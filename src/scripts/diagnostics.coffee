# Description:
#   Your dog friend makes sure everything's in order
#
# Commands:
#
# Notes:
#
# Author:
#   aaronsky

moment = require 'moment'

{ HEADERS, STRINGS, TIMEZONE } = require '../helpers/constants'
strings = STRINGS.diagnostics

Organization = require('../models/organization').get()

module.exports = (robot) ->
  Logger = require('../helpers/logger')(robot)

  robot.respond /uptime/i, id: 'diagnostics.uptime', (res) ->
    res.send "#{Organization.name}'s Ibizan has been up since
              #{Organization.initTime.toDate()}
              _(#{+moment()
                .diff(Organization.initTime, 'minutes', true)
                .toFixed(2)}
              minutes)_"
    Logger.addReaction 'dog2', res.message

  robot.respond /users/i, id: 'diagnostics.users', userRequired: true, adminOnly: true, (res) ->
    user = Organization.getUserBySlackName res.message.user.name
    response = 'All users:'
    attachments = []
    for u in Organization.users
      attachments.push u.slackAttachment()
    user.directMessage response, Logger, attachments
    Logger.addReaction 'dog2', res.message

  robot.respond /user$/i, id: 'diagnostics.userHelp', adminOnly: true, (res) ->
    res.send strings.userhelp
    Logger.addReaction 'dog2', res.message

  robot.respond /user (.*)/i, id: 'diagnostics.user', userRequired: true, adminOnly: true, (res) ->
    user = Organization.getUserBySlackName res.message.user.name
    u = Organization.getUserBySlackName res.match[1]
    response = "User #{res.match[1]}"
    if u
      response += ":"
      user.directMessage response, Logger, [u.slackAttachment()]
      Logger.addReaction 'dog2', res.message
    else
      response += " could not be found. Make sure you're using their Slack name."
      user.directMessage response, Logger
      Logger.addReaction 'x', res.message

  robot.respond /daily report/i, id: 'diagnostics.dailyReport', adminOnly: true, (res) ->
    yesterday =
      moment.tz({hour: 0, minute: 0, second: 0}, TIMEZONE).subtract(1, 'days')
    today = moment.tz({hour: 0, minute: 0, second: 0}, TIMEZONE)
    Organization.generateReport(yesterday, today)
      .catch((err) ->
        Logger.errorToSlack "Failed to produce a daily report", err
      )
      .done(
        (reports) ->
          numberDone = reports.length
          report = Organization.dailyReport reports, today, yesterday
          res.send report
      )
    Logger.addReaction 'dog2', res.message

  robot.respond /projects/i, id: 'diagnostics.projects', userRequired: true, adminOnly: true, (res) ->
    user = Organization.getUserBySlackName res.message.user.name
    response = ''
    for project in Organization.projects
      response += project.description() + '\n\n'
    user.directMessage response, Logger
    Logger.addReaction 'dog2', res.message

  robot.respond /calendar/i, id: 'diagnostics.calendar', userRequired: true, adminOnly: true, (res) ->
    user = Organization.getUserBySlackName res.message.user.name
    user.directMessage Organization.calendar.description(), Logger
    Logger.addReaction 'dog2', res.message

  robot.respond /sync/i, id: 'diagnostics.sync', (res) ->
    Logger.addReaction 'clock4', res.message
    Organization.sync()
    .catch(
      (err) ->
        Logger.errorToSlack "Failed to resync", err
        Logger.removeReaction 'clock4', res.message
        Logger.addReaction 'x', res.message
    )
    .done(
      (status) ->
        res.send "Resynced with spreadsheet"
        Logger.removeReaction 'clock4', res.message
        Logger.addReaction 'dog2', res.message
    )

  robot.router.post '/diagnostics/sync', (req, res) ->
    body = req.body
    if not Organization.ready()
      res.status 401
      res.json {
        "text": "Organization is not ready to resync"
      }
    else
      response_url = body.response_url || null
      if response_url
        Logger.log "POSTing to #{response_url}"
      Organization.sync()
      .catch(
        (err) ->
          message = "Failed to resync"
          Logger.errorToSlack message, err
          payload =
            text: message
          if response_url
            robot.http(response_url)
            .header('Content-Type', 'application/json')
            .post(JSON.stringify(payload))
      )
      .done(
        (status) ->
          message = "Resynced with spreadsheet"
          Logger.log message
          payload =
            text: message
          if response_url
            robot.http(response_url)
            .header('Content-Type', 'application/json')
            .post(JSON.stringify(payload)) (err, response, body) ->
              if err
                response.send "Encountered an error :( #{err}"
                return
              if res.statusCode isnt 200
                response.send "Request didn't come back HTTP 200 :("
                return
              Logger.log body
      )
      res.status 200
      res.json {
        "text": "Beginning to resync..."
      }

  # Ibizan responds to cries for help
  robot.respond /.*(help|docs|documentation|commands).*/i, id: 'diagnostics.help', (res) ->
    user = Organization.getUserBySlackName res.message.user.name
    user.directMessage strings.help, Logger
    Logger.addReaction 'dog2', res.message
