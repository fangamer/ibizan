
moment = require 'moment'
Q = require 'q'

{ HEADERS } = require '../helpers/constants'
Logger = require('../helpers/logger')()
{ Calendar, CalendarEvent } = require './calendar'
Spreadsheet = require './sheet'
{ Settings } = require './user'

CONFIG =
  sheet_id: process.env.SHEET_ID
  auth:
    client_email: process.env.CLIENT_EMAIL
    private_key: process.env.PRIVATE_KEY

NAME = process.env.ORG_NAME

# Singleton
class Organization
  instance = null

  class OrganizationPrivate
    constructor: (id) ->
      @name = NAME || 'Bad organization name'
      sheet_id = id || CONFIG.sheet_id
      if sheet_id
        @spreadsheet = new Spreadsheet(sheet_id)
        Logger.fun "Welcome to #{@name}!"
        @initTime = moment()
        if @spreadsheet.sheet
          @sync().done(() -> Logger.log('Options loaded'))
      else
        Logger.warn 'Sheet not initialized, no spreadsheet ID was provided'
    ready: () ->
      if @spreadsheet
        return @spreadsheet.initialized
      return false
    sync: (auth) ->
      deferred = Q.defer()
      @spreadsheet.authorize(auth || CONFIG.auth)
      .then(@spreadsheet.loadOptions.bind(@spreadsheet))
      .then(
        (opts) =>
          if opts
            @houndFrequency = opts.houndFrequency
            if @users
              old = @users.slice(0)
            @users = opts.users
            if old
              for user in old
                if newUser = @getUserBySlackName user.slack
                  newUser.settings = Settings.fromSettings user.settings
            @projects = opts.projects
            @calendar = new Calendar(opts.vacation, opts.sick, opts.holidays, opts.payweek, opts.events)
            @clockChannel = opts.clockChannel
            @exemptChannels = opts.exemptChannels
        )
        .catch((error) -> deferred.reject(error))
        .done(() -> deferred.resolve(true))
      deferred.promise
    getUserBySlackName: (name, users) ->
      if not users
        users = @users
      if users
        for user in users
          if name is user.slack
            return user
      Logger.debug "User #{name} could not be found"
    getUserByRealName: (name, users) ->
      if not users
        users = @users
      if users
        for user in users
          if name is user.name
            return user
      Logger.debug "Person #{name} could not be found"
    getProjectByName: (name, projects) ->
      if not projects
        projects = @projects
      name = name.replace '#', ''
      if projects
        for project in @projects
          if name is project.name
            return project
      Logger.debug "Project #{name} could not be found"
    addEvent: (date, name) ->
      deferred = Q.defer()
      date = moment(date, 'MM/DD/YYYY')
      if not date.isValid()
        deferred.reject "Invalid date given to addEvent"
      else if not name? or not name.length > 0
        deferred.reject "Invalid name given to addEvent"

      calendarevent = new CalendarEvent(date, name)
      calendar = @calendar
      @spreadsheet.addEventRow(calendarevent.toEventRow())
      .then(
        () ->
          calendar.events.push calendarevent
          deferred.resolve calendarevent
      )
      .catch(
        (err) ->
          deferred.reject "Could not add event row: #{err}"
      )
      .done()
      deferred.promise
    generateReport: (start, end, send=false) ->
      deferred = Q.defer()
      if not @spreadsheet
        deferred.reject 'No spreadsheet is loaded, report cannot be generated'
        return
      else if not start or not end
        deferred.reject 'No start or end date were passed as arguments'
        return

      Logger.log "Generating payroll from #{start.format('MMM Do, YYYY')}
                  to #{end.format('MMM Do, YYYY')}"
      headers = HEADERS.payrollreports
      reports = []
      # Sort by last name, then tax type
      usersByLastName = @users.sort((a, b) ->
        if a.name.split(' ').pop() < b.name.split(' ').pop()
          return -1
        if a.name.split(' ').pop() > b.name.split(' ').pop()
          return 1
        return 0
      )
      usersByTaxType = usersByLastName.sort((a, b) ->
        if a.taxType > b.taxType
          return -1
        if a.taxType < b.taxType
          return 1
        return 0
      )
      for user in usersByTaxType
        row = user.toRawPayroll(start, end)
        if row
          reports.push row
      if send
        @spreadsheet.generateReport(reports)
        .done((numberDone) -> deferred.resolve(reports))
      else
        deferred.resolve reports
      deferred.promise
    dailyReport: (reports, today, yesterday) ->
      PAYROLL = HEADERS.payrollreports
      USERS = HEADERS.users
      response = "DAILY WORK LOG:
                  *#{yesterday.format('dddd MMMM D YYYY').toUpperCase()}*\n"
      logBuffer = ''
      offBuffer = ''

      # Sort reports by time logged
      sortedReports = reports.sort((left, right) ->
        if left[USERS.logged] < right[USERS.logged] or
           left[USERS.vacation] < left[USERS.vacation] or
           left[USERS.sick] < left[USERS.sick] or
           left[USERS.unpaid] < left[USERS.unpaid]
          return -1
        else if left[USERS.logged] > right[USERS.logged] or
                left[USERS.vacation] > left[USERS.vacation] or
                left[USERS.sick] > left[USERS.sick] or
                left[USERS.unpaid] > left[USERS.unpaid]
          return 1
        return 0
      )
      for report in sortedReports
        recorded = false
        if report[PAYROLL.logged] > 0
          status = "#{report.extra.slack}:\t\t\t#{report[PAYROLL.logged]} hours"
          notes = report.extra.notes?.replace('\n', '; ')
          if notes
            status += " \"#{notes}\""
          projectStr = ''
          if report.extra.projects? and report.extra.projects?.length > 0
            for project in report.extra.projects
              projectStr += "##{project.name} "
          if projectStr
            projectStr = projectStr.trim()
            status += " #{projectStr}"
          status += "\n"
          logBuffer += "#{status}"
          recorded = true
        if report[PAYROLL.vacation] > 0
          offBuffer += "#{report.extra.slack}:\t#{report[PAYROLL.vacation]}
                        hours vacation\n"
          recorded = true
        if report[PAYROLL.sick] > 0
          offBuffer += "#{report.extra.slack}:\t#{report[PAYROLL.sick]}
                        hours sick\n"
          recorded = true
        if report[PAYROLL.unpaid] > 0
          offBuffer += "#{report.extra.slack}:\t#{report[PAYROLL.unpaid]}
                        hours unpaid\n"
          recorded = true
        if not recorded
          offBuffer += "#{report.extra.slack}:\t0 hours\n"
      response += logBuffer + "\n"
      if offBuffer.length > 0
        response += "DAILY OFF-TIME LOG:
                     *#{yesterday.format('dddd MMMM D YYYY').toUpperCase()}*\n"
        response += offBuffer + "\n"
      upcomingEvents = @calendar.upcomingEvents()
      if upcomingEvents.length > 0
        now = moment().subtract(1, 'days')
        response += "\nUPCOMING EVENTS:\n"
        for upcomingEvent in upcomingEvents
          days = upcomingEvent.date.diff(now, 'days')
          weeks = upcomingEvent.date.diff(now, 'weeks')
          daysArticle = "day"
          if days > 1
            daysArticle += "s"
          weeksArticle = "week"
          if weeks > 1
            weeksArticle += "s"

          if weeks > 0
            daysRemainder = days % 7 or 0
            daysArticle = if daysRemainder > 1 then 'days' else 'day'
            response += "#{upcomingEvent.name} in #{weeks} #{if weeks > 1 then 'weeks' else 'week'}#{if daysRemainder > 0 then ', ' + daysRemainder + ' ' + daysArticle}\n"
          else
            response += "*#{upcomingEvent.name}* #{if days > 1 then 'in *' + days + ' days*' else '*tomorrow*'}\n"

      return response
    resetHounding: () ->
      i = 0
      for user in @users
        if user.settings?.shouldResetHound
          user.settings.fromSettings {
            shouldHound: true
          }
        i += 1
      i
    setHoundFrequency: (frequency) ->
      i = 0
      for user in @users
        user.settings.fromSettings {
          houndFrequency: frequency
        }
        i += 1
      i
    setShouldHound: (should) ->
      i = 0
      for user in @users
        user.settings.fromSettings {
          shouldHound: should
        }
        i += 1
      i
  @get: (id) ->
    instance ?= new OrganizationPrivate(id)
    instance

module.exports = Organization
