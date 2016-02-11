GoogleSpreadsheet = require 'google-spreadsheet'
moment = require 'moment'
require '../../lib/moment-holidays.js'
constants = require '../helpers/constants'
HEADERS = constants.HEADERS
Project = require './project'
{User, Timetable} = require './user'

options = {}

class Spreadsheet
  constructor: (sheet_id) ->
    @sheet = new GoogleSpreadsheet(sheet_id)
    @initialized = false
  authorize: (auth, cb) ->
    @sheet.useServiceAccountAuth auth, (err) ->
      if err
        console.error 'authorization failed'
        cb err
      console.log 'authorized'
      cb()
    console.log 'waiting for authorization'
  loadOptions: (cb) ->
    that = this
    @sheet.getInfo (err, info) ->
      if err
        cb err
      that.title = info.title
      that.payroll = info.worksheets[0] # HACK
      that.rawData = info.worksheets[2] # HACK
      that.punchCount = parseInt(that.rawData.rowCount) - 1
      that.loadVariables info.worksheets[4], (opts) -> 
        that.loadProjects info.worksheets[1], (projects) ->
          opts.projects = projects
          that.loadEmployees info.worksheets[3], (users) ->
            opts.users = users
            that.initialized = true
            cb opts
  loadVariables: (worksheet, cb) ->
    worksheet.getRows (err, rows) ->
      if err
        throw err
      opts =
        vacation: 0
        sick: 0
        holidays: {}
        clockChannel: ''
        exemptChannels: []
      VARIABLE_HEADERS = HEADERS.variables
      for row in rows
        for key, header of VARIABLE_HEADERS
          if row[header]
            if header is VARIABLE_HEADERS.holidays
              name = row[header]
              date = moment().fromHolidayString(row[VARIABLE_HEADERS.holidayDate])
              opts[key][name] = date
            else if header is VARIABLE_HEADERS.exemptChannels
              channel = row[header]
              if channel
                channel = channel.replace '#', ''
                opts[key].push channel
            else
              if isNaN(row[header])
                val = row[header]
                if val
                  opts[key] = val.trim().replace '#', ''
              else
                opts[key] = parseInt row[header]
      cb opts
  loadProjects: (worksheet, cb) ->
    worksheet.getRows (err, rows) ->
      if err
        throw err
      projects = []
      PROJECT_HEADERS = HEADERS.projects
      for row in rows
        if row[PROJECT_HEADERS.name]
          name = row[PROJECT_HEADERS.name].trim()
        if row[PROJECT_HEADERS.start]
          startDate = moment(row[PROJECT_HEADERS.start], 'MM/DD/YYYY')
        if row[PROJECT_HEADERS.total]
          total = parseInt row[PROJECT_HEADERS.total]
        project = new Project(name, startDate, total)
        projects.push project
      cb projects
  loadEmployees: (worksheet, cb) ->
    worksheet.getRows (err, rows) ->
      if err
        throw err
      users = []
      USER_HEADERS = HEADERS.users
      today = moment()
      for row in rows
        temp = {}
        for key, header of USER_HEADERS
          if header is USER_HEADERS.start or header is USER_HEADERS.end
            temp[key] = moment("#{today.format("YYYY-MM-DD")} #{row[header]}")
          else if header is USER_HEADERS.salary
            temp[key] = row[header] is 'Y'
          else
            if isNaN(row[header])
              temp[key] = row[header].trim()
            else
              temp[key] = parseInt row[header]
        timetable = new Timetable(temp.start, temp.end, temp.timezone)
        timetable.setVacation(temp.vacationAvailable, temp.vacationLogged)
        timetable.setSick(temp.sickAvailable, temp.sickLogged)
        timetable.setUnpaid(temp.unpaidLogged)
        timetable.setOvertime(temp.overtime)
        timetable.setLogged(temp.totalLogged)
        timetable.setAverageLogged(temp.averageLogged)
        user = new User(temp.name, temp.slackname, temp.salary, timetable)
        users.push user
      cb users
  enterPunch: (punch, user, cb) ->
    # code
    if not punch or not user
      cb(new Error('Invalid parameters passed: Punch or user is undefined.'))
      return
    headers = HEADERS.rawdata
    if user.lastPunch and user.lastPunch.punch.mode is 'in' and punch.mode is 'out'
      row = user.lastPunch.row
      row[headers.out] = punch.times[0].format('hh:mm:ss A')
      elapsed = punch.times[0].diff(user.lastPunch.punch.times[0], 'hours', true)
      hours = Math.floor elapsed
      minutes = Math.round((elapsed - hours) * 60)
      row[headers.totalTime] = "#{hours}:#{if minutes < 10 then "0#{minutes}" else minutes}:00"
      extraProjectCount = user.lastPunch.punch.projects.length
      for project in punch.projects
        if extraProjectCount >= 6
          break
        if project not in user.lastPunch.punch.projects
          extraProjectCount += 1
          row[headers["project#{extraProjectCount}"]] = "##{project.name}"
      if punch.notes
        row[headers.notes] = "#{user.lastPunch.punch.notes}\n#{punch.notes}" 
      row.save (err) ->
        if err
          cb(err)
          return
        cb()
    else
      row = {}
      row[headers.id] = @punchCount + 1
      today = moment()
      row[headers.today] = today.format('MM/DD/YYYY')
      row[headers.name] = user.name
      if punch.mode is 'in'
        row[headers.in] = punch.times[0].format('hh:mm:ss A')
      else if punch.mode is 'out'
        row[headers.out] = punch.times[0].format('hh:mm:ss A')
        # row[headers.totalTime] = 
      else if punch.times.block?
        block = punch.times.block
        hours = Math.floor block
        minutes = Math.round((block - hours) * 60)
        row[headers.blockTime] = "#{hours}:#{if minutes < 10 then "0#{minutes}" else minutes}:00"
      row[headers.notes] = punch.notes
      max = if punch.projects.length < 6 then punch.projects.length else 5
      for i in [0..max]
        project = punch.projects[i]
        if project?
          row[headers["project#{i + 1}"]] = "##{project.name}"
      that = this
      @rawData.addRow row, (err) ->
        if err
          cb(err)
          return
        params = 
          orderby: "column:#{headers.id}"
          reverse: true
        that.rawData.getRows params, (err, rows) ->
          if err or not rows
            cb(err)
            return
          # HACK: THIS NEEDS STRESS TESTING
          first = rows[0]
          user.lastPunch = 
            punch: punch
            row: first # Important for undo and update operations
          that.punchCount = rows.length - 1
          cb()

  generateReport: () ->
    # code

module.exports = Spreadsheet