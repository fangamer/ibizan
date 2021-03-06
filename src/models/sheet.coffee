
GoogleSpreadsheet = require 'google-spreadsheet'
Q = require 'q'
moment = require 'moment'

require '../../lib/moment-holidays.js'
{ HEADERS } = require '../helpers/constants'
{ Calendar, CalendarEvent } = require './calendar'
Logger = require('../helpers/logger')()
Project = require './project'
{ User, Settings, Timetable } = require './user'

options = {}

class Spreadsheet
  constructor: (sheet_id) ->
    if sheet_id and sheet_id isnt 'test'
      @sheet = new GoogleSpreadsheet(sheet_id)
    else
      @sheet = false
    @initialized = false

  authorize: (auth) ->
    deferred = Q.defer()
    @sheet.useServiceAccountAuth auth, (err) ->
      if err
        deferred.reject err
      else
        Logger.log 'Authorized successfully'
        deferred.resolve()
    Logger.log 'waiting for authorization'
    deferred.promise

  loadOptions: () ->
    deferred = Q.defer()
    @_loadWorksheets()
    .then(@_loadVariables.bind(@))
    .then(@_loadProjects.bind(@))
    .then(@_loadEmployees.bind(@))
    .then(@_loadEvents.bind(@))
    .then(@_loadPunches.bind(@))
    .catch((error) -> deferred.reject("Couldn't download sheet data: #{error}"))
    .done(
      (opts) =>
        @initialized = true
        deferred.resolve opts
    )
    return deferred.promise

  saveRow: (row, rowname="row") ->
    deferred = Q.defer()
    if not row
      deferred.reject "No row passed to saveRow"
    else
      row.save (err) ->
        if err
          # Retry up to 3 times
          retry = 1
          setTimeout ->
            if retry <= 3
              Logger.debug "Retrying save of #{rowname}, attempt #{retry}..."
              row.save (err) ->
                if not err
                  Logger.debug "#{rowname} saved successfully"
                  deferred.resolve row
                  return true
              retry += 1
            else
              deferred.reject err
              Logger.error "Unable to save #{rowname}", new Error(err)
          , 1000
        else
          deferred.resolve row
    return deferred.promise

  newRow: (sheet, row, rowname="row") ->
    deferred = Q.defer()
    if not sheet
      deferred.reject "No sheet passed to newRow"
    else if not row
      deferred.reject "No row passed to newRow"
    else
      sheet.addRow row, (err) ->
        if err
          # Retry up to 3 times
          retry = 1
          setTimeout ->
            if retry <= 3
              Logger.debug "Retrying adding #{rowname}, attempt #{retry}..."
              sheet.addRow row, (err) ->
                if not err
                  Logger.debug "#{rowname} saved successfully"
                  deferred.resolve row
                  return true
              retry += 1
            else
              deferred.reject err
              Logger.error "Unable to add #{rowname}", new Error(err)
          , 1000
        else
          deferred.resolve row
    return deferred.promise

  enterPunch: (punch, user) ->
    deferred = Q.defer()
    valid = punch.isValid user
    if not punch or not user
      deferred.reject 'Invalid parameters passed: Punch or user is undefined.'
    else if typeof valid is 'string'
      deferred.reject valid
    else
      headers = HEADERS.rawdata
      if punch.mode is 'out'
        if user.punches and
           user.punches.length > 0
          len = user.punches.length
          for i in [len-1..0]
            last = user.punches[i]
            if last.mode is 'in'
              break
            else if last.mode is 'out'
              continue
            else if last.times.length is 2
              continue
          if not last?
            deferred.reject 'You haven\'t punched out yet.'
          last.out punch
          row = last.toRawRow user.name
          @saveRow(row, "punch for #{user.name}")
          .then(
            () ->
              # add hours to project in projects
              if last.times.block
                elapsed = last.times.block
              else
                elapsed = last.elapsed
              logged = user.timetable.loggedTotal
              user.timetable.setLogged(logged + elapsed)
              # calculate project times
              promises = []
              for project in last.projects
                project.total += elapsed
                promises.push (project.updateRow())
              promises.push(user.updateRow())
              Q.all(promises)
              .catch(
                (err) ->
                  deferred.reject err
              )
              .done(
                () ->
                  deferred.resolve last
              )
          )
          .catch(
            (err) ->
              deferred.reject err
          ).done()
      else
        row = punch.toRawRow user.name
        that = @
        @newRow(@rawData, row)
        .then(
          (row, rawData) ->
            params = {}
            that.rawData.getRows params, (err, rows) ->
              if err or not rows
                deferred.reject "Could not get rawData rows: #{err}"
              else
                row_matches =
                  (r for r in rows when r[headers.id] is row[headers.id])
                row_match = row_matches[0]
                punch.assignRow row_match
                user.punches.push punch
                if punch.mode is 'vacation' or
                   punch.mode is 'sick' or
                   punch.mode is 'unpaid'
                  if punch.times.block
                    elapsed = punch.times.block
                  else
                    elapsed = punch.elapsed
                  elapsedDays = user.toDays elapsed
                  if punch.mode is 'vacation'
                    total = user.timetable.vacationTotal
                    available = user.timetable.vacationAvailable
                    user.timetable.setVacation(total + elapsedDays, available - elapsedDays)
                  else if punch.mode is 'sick'
                    total = user.timetable.sickTotal
                    available = user.timetable.sickAvailable
                    user.timetable.setSick(total + elapsedDays, available - elapsedDays)
                  else if punch.mode is 'unpaid'
                    total = user.timetable.unpaidTotal
                    user.timetable.setUnpaid(total + elapsedDays)
                  user.updateRow()
                  .catch(
                    (err) ->
                      deferred.reject "Could not update user row: #{err}"
                  )
                  .done(
                    () ->
                      deferred.resolve punch
                  )
                else
                  deferred.resolve punch
        )
        .catch(
          (err) ->
            deferred.reject "Could not add row: #{err}"
        ).done()
    deferred.promise

  generateReport: (reports) ->
    deferred = Q.defer()
    numberDone = 0

    that = @
    addPayrollRow = (row) ->
      that.payroll.addRow reports[numberDone], (err) ->
        if err
          deferred.reject err, numberDone
        else
          numberDone += 1
          if numberDone >= reports.length
            deferred.resolve numberDone
          else
            addPayrollRow reports[numberDone]
    addPayrollRow reports[numberDone]

    deferred.promise

  addEventRow: (row) ->
    deferred = Q.defer()

    @events.addRow row, (err) ->
      if err
        deferred.reject err
      else
        deferred.resolve row
    deferred.promise

  _loadWorksheets: () ->
    deferred = Q.defer()
    @sheet.getInfo (err, info) =>
      if err
        deferred.reject err
      else
        @title = info.title
        @id = info.id
        @id = @id.replace 'https://spreadsheets.google.com/feeds/worksheets/',
                          ''
        @id = @id.replace '/private/full', ''
        @url = "https://docs.google.com/spreadsheets/d/#{@id}"
        for worksheet in info.worksheets
          title = worksheet.title
          words = title.split ' '
          title = words[0].toLowerCase()
          i = 1
          while title.length < 6 and i < words.length
            title = title.concat(words[i])
            i += 1
          @[title] = worksheet

        if not (@rawData and
                @payroll and
                @variables and
                @projects and
                @employees and
                @events)
          deferred.reject 'Worksheets failed to be associated properly'
        else
          Logger.fun "----------------------------------------"
          deferred.resolve {}
    deferred.promise

  _loadVariables: (opts) ->
    deferred = Q.defer()
    @variables.getRows (err, rows) ->
      if err
        deferred.reject err
      else
        opts =
          vacation: 0
          sick: 0
          houndFrequency: 0
          payWeek: null
          holidays: []
          clockChannel: ''
          exemptChannels: []
        VARIABLE_HEADERS = HEADERS.variables
        for row in rows
          for key, header of VARIABLE_HEADERS
            if row[header]
              if header is VARIABLE_HEADERS.holidayOverride
                continue
              if header is VARIABLE_HEADERS.holidays
                name = row[header]
                if row[VARIABLE_HEADERS.holidayOverride]
                  date = moment row[VARIABLE_HEADERS.holidayOverride],
                                'MM/DD/YYYY'
                else
                  date = moment().fromHolidayString row[VARIABLE_HEADERS.holidays]
                opts[key].push
                  name: name
                  date: date
              else if header is VARIABLE_HEADERS.payweek
                opts[key] = moment row[VARIABLE_HEADERS.payweek],
                                   'MM/DD/YYYY'
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
        Logger.fun "Loaded organization settings"
        Logger.fun "----------------------------------------"
        deferred.resolve opts
    deferred.promise

  _loadProjects: (opts) ->
    deferred = Q.defer()
    @projects.getRows (err, rows) ->
      if err
        deferred.reject err
      else
        projects = []
        for row in rows
          project = Project.parse row
          if project
            projects.push project
        opts.projects = projects
        Logger.fun "Loaded #{projects.length} projects"
        Logger.fun "----------------------------------------"
        deferred.resolve opts
    deferred.promise

  _loadEmployees: (opts) ->
    deferred = Q.defer()
    @employees.getRows (err, rows) ->
      if err
        deferred.reject err
      else
        users = members = []
        for row in rows
          user = User.parse row
          if user
            users.push user
        opts.users = users
        Logger.fun "Loaded #{users.length} users"
        Logger.fun "----------------------------------------"
        deferred.resolve opts
    deferred.promise

  _loadEvents: (opts) ->
    deferred = Q.defer()
    @events.getRows (err, rows) ->
      if err
        deferred.reject err
      else
        events = []
        for row in rows
          calendarevent = CalendarEvent.parse row
          if calendarevent
            events.push calendarevent
        opts.events = events
        Logger.fun "Loaded #{events.length} calendar events"
        Logger.fun "----------------------------------------"
        deferred.resolve opts
    deferred.promise

  _loadPunches: (opts) ->
    # HACK: THIS IS CHEATING
    Punch = require './punch'
    deferred = Q.defer()
    @rawData.getRows (err, rows) ->
      if err
        deferred.reject err
      else
        for row in rows
          user = opts.users.filter((item, index, arr) ->
            return item.name is row[HEADERS.rawdata.name]
          )[0]
          punch = Punch.parseRaw user, row, opts.projects
          if punch and user
            user.punches.push punch
        Logger.fun "Loaded #{rows.length} punches for #{opts.users.length} users"
        Logger.fun "----------------------------------------"
        deferred.resolve opts
    deferred.promise

module.exports = Spreadsheet
