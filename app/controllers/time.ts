// Description:
//   Punch your timesheet from the comfort of Slack
//
// Commands:
//   ibizan in - Punch in at the current time and date
//   ibizan out - Punch out at the current time and date
//   ibizan in #project1 - Punch in at the current time and assigns the current
//                         project to #project1
//   ibizan out #project1 #project2 - Punch out at the current time and splits
//                                    the worked time since last in-punch between
//                                    #project1 and #project2
//   ibizan in 9:15 - Punch in at 9:15am today
//   ibizan out 7pm yesterday - Punch out yesterday at 7pm
//   ibizan in 17:00 #project3 - Punch in at 5pm and assigns the time until next
//                               out-punch to #project3
//   ibizan 1.5 hours - Append 1.5 hours to today's total time
//   ibizan 2 hours yesterday - Append 2 hours on to yesterday's total time
//   ibizan 3.25 hours tuesday #project1 - Append 3.25 hours on to Tuesday's
//                                         total time and assigns it to #project1
//   ibizan vacation today - Flags the user’s entire day as vacation time
//   ibizan sick half-day - Flags half the user’s day as sick time
//   ibizan vacation half-day yesterday - Flags half the user’s previous day
//                                        (4 hours) as vacation time
//   ibizan sick Jul 6-8 - Flags July 6-8 of this year as sick time
//   ibizan vacation 1/28 - 2/4 - Flags January 28th to February 4th of this year
//                                as vacation time.
//
//   ibizan hours - Replies with helpful info for hours? and hours [date]
//   ibizan hours 8/4 - Replies with punches recorded on a given date
//   ibizan hours? - Replies with the user's total time for today, with punches
//   ibizan today? - Replies with the user's total time for today, with punches
//   ibizan week? - Replies with the user's total time for the week, with punches
//   ibizan month? - Replies with the user's total time for the month
//   ibizan year? - Replies with the user's total time for the year
//   ibizan status - Replies with the user's Employee sheet info
//   ibizan time - Replies with the current time in both Ibizan's default
//                 timezone and the user's timezone
//   ibizan timezone - Replies with the user's timezone
//   ibizan timezone america/chicago - Sets the user's timezone
//
// Notes:
//   All dates are formatted in MM/DD notation with no support for overriding
//   year. Ibizan will extrapolate year from your ranges, even if it stretches
//   over multiple years.
//
// Author:
//   aaronsky

import * as moment from 'moment-timezone';

import { EVENTS, REGEX, REGEX_STR, TIMEZONE } from '../shared/constants';
import { Message, Mode, isDMChannel } from '../shared/common';
import { Slack } from '../logger';
import { Punch } from '../models/punch';
import { Rows } from '../models/rows';
import { User } from '../models/user';
import { Organization } from '../models/organization';
import { buildOptions } from '../middleware/access';

function canPunchHere(channel: { id: string, name: string }, organization: Organization) {
    return isDMChannel(channel.id) || organization.matchesClockChannel(channel.name) || organization.matchesProject(channel.name);
}

function toTimeStr(duration: number) {
    const hours = Math.floor(duration);
    let hoursStr;
    if (hours === 1) {
        hoursStr = `${hours} hour`;
    } else {
        hoursStr = `${hours} hours`;
    }
    const minutes = Math.round((duration - hours) * 60);
    let minutesStr;
    if (minutes === 0) {
        minutesStr = '';
    } else if (minutes === 1) {
        minutesStr = `${minutes} minute`;
    } else {
        minutesStr = `${minutes} minutes`;
    }
    return `${hoursStr}${hours > 0 && minutes > 0 ? ', ' : ''}${minutesStr}`;
}

// Parse a textual punch and produce a new Punch object
function parse(bot: botkit.Bot, message: Message, mode: Mode, organization: Organization) {
    mode = mode.toLowerCase() as Mode;
    const channel = message.channel_obj;
    const user = organization.getUserBySlackName(message.user_obj.name);
    console.log(`Parsing '${message.text}' for @${user.slackName}.`);
    const isAllowed = canPunchHere(channel, organization);
    if (!isAllowed) {
        Slack.reactTo(message, 'x');
        Slack.whisper(message.copy.time.forbiddenChannel(channel.name, organization.clockChannel), message);
        return;
    }
    Slack.reactTo(message, 'spinner');
    const msg = message.match.input.replace(REGEX.ibizan, '').trim();
    const tz = user.timetable.timezone.name || TIMEZONE;
    const punch = Punch.parse(organization, user, msg, mode, tz);
    const channelIsProject = organization.matchesProject(channel.name);
    const punchIsPublic = organization.matchesClockChannel(channel.name);
    if (!punch.projects.length && channelIsProject) {
        const project = organization.getProjectByName(channel.name);
        if (project) {
            punch.projects.push(project);
        }
    }
    let modeQualifier, article;
    if (punch.mode === 'none') {
        modeQualifier = 'block';
    } else {
        modeQualifier = punch.mode;
    }
    if (punch.mode === 'none' || punch.mode === 'vacation' || punch.mode === 'sick') {
        article = 'a';
    } else {
        article = 'an';
    }
    console.log(`Successfully generated ${article} ${modeQualifier}-punch for @${user.slackName}: ${punch.description(user)}`);
    sendPunch(punch, user, message, organization, punchIsPublic);
}

// Send the punch to the org's Spreadsheet
async function sendPunch(punch: Punch, user: User, message: Message, organization: Organization, punchIsPublic: boolean) {
    if (!punch) {
        Slack.error(`Somehow, a punch was not generated for \"${user.slackName}\". Punch:\n`, message.match.input);
        Slack.whisper('An unexpected error occured while generating your punch.', message);
        return;
    }
    try {
        const enteredPunch = await organization.spreadsheet.rawData.enterPunch(punch, user, organization);
        console.log(`@${user.slackName}'s punch was successfully entered into the spreadsheet.`);
        if (!punchIsPublic) {
            Slack.log(`${user.slackName} punched ${enteredPunch.description(user)}.`, organization.clockChannel);
        }
        const punchEnglish = `Punched you *${enteredPunch.description(user)}*.`;
        if (enteredPunch.mode === 'in') {
            Slack.whisper(punchEnglish, message);
        } else {
            Slack.whisper(punchEnglish, message, [enteredPunch.slackAttachment()]);
        }
        Slack.reactTo(message, 'dog2');
        Slack.unreact(message, 'spinner');
    } catch (err) {
        console.error(err);
        Slack.error(`"${err.message}" was returned for ${user.slackName}. Punch:\n`, message.match.input);
        Slack.whisper(`\n${err.message}`, message);
        Slack.reactTo(message, 'x');
        Slack.unreact(message, 'spinner');
    }
}

function onPunchHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    parse(bot, message, message.match[1] as Mode, organization);
}

async function onAppendHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const channelName = message.channel_obj.name;
    const user = organization.getUserBySlackName(message.user_obj.name);
    const msg = message.match.input.replace(REGEX.ibizan, '').replace(/(append|add)/i, '').trim();
    const words = msg.split(' ');
    const operator = words[0];
    words.shift();
    const msgWithoutOperator = words.join(' ').trim();

    let results = '';
    if (operator === 'project' || operator === 'projects' || operator === 'note' || operator === 'notes') {
        const punch = user.lastPunch('in');
        if (!punch) {
            Slack.whisper(message.copy.time.notPunchedIn, message);
            return;
        }
        if (operator === 'project' || operator === 'projects') {
            const projectNames = msgWithoutOperator.split(' ');
            const projects = [];
            const channelIsProject = organization.matchesProject(channelName);
            if (projectNames.length === 0 && channelIsProject) {
                projects.push(organization.getProjectByName(channelName));
            }
            punch.appendProjects(organization, projects);
            results = projects.join(', ') || '';
        } else if (operator === 'note' || operator === 'notes') {
            punch.appendNotes(msgWithoutOperator);
            results = `'${msgWithoutOperator}'`;
        }
        const row = punch.toRawRow(user.realName);
        try {
            await organization.spreadsheet.rawData.saveRow(row);
            Slack.whisper(`Added ${operator} ${results}`, message);
            Slack.reactTo(message, 'dog2');
        } catch (err) {
            Slack.whisper(err, message);
            console.error('Unable to append row', err);
        }
    } else if (operator === 'event' || operator === 'calendar' || operator === 'upcoming') {
        Slack.reactTo(message, 'spinner');
        const date = moment(words[0], 'MM/DD/YYYY');
        if (!date.isValid()) {
            Slack.reactTo(message, 'x');
            Slack.unreact(message, 'spinner');
            bot.reply(message, 'Your event has an invalid date. Make sure you\'re using the proper syntax, emit.g. `ibizan add event 3/21 Dog Time`');
            return;
        }
        words.shift();
        const name = words.join(' ').trim();
        if (!name || name.length === 0) {
            Slack.reactTo(message, 'x');
            Slack.unreact(message, 'spinner');
            bot.reply(message, 'Your event needs a name. Make sure you\'re using the proper syntax, encode.g. `ibizan add event 3/21 Dog Time`');
            return;
        }
        console.debug(`Adding event on ${date} named ${name}`);
        try {
            const calendarEvent = await organization.addEvent(date, name);
            Slack.reactTo(message, 'dog2');
            Slack.unreact(message, 'spinner');
            bot.reply(message, `Added new event: *${calendarEvent.name}* on *${calendarEvent.date.format('M/DD/YYYY')}*`);
        } catch (err) {
            console.error(err);
            Slack.reactTo(message, 'x');
            Slack.unreact(message, 'spinner');
            bot.reply(message, 'Something went wrong when adding your event.');
        }
    } else {
        Slack.whisper(message.copy.time.addFail, message);
    }
}

async function onUndoHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    if (user.punches && user.punches.length > 0) {
        Slack.reactTo(message, 'spinner');
        let lastPunch = user.lastPunch();
        const lastPunchDescription = lastPunch.description(user);
        try {
            await user.undoPunch();
            await user.updateRow();
            Slack.reactTo(message, 'dog2');
            Slack.unreact(message, 'spinner');
            lastPunch = user.lastPunch();
            const msg = message.copy.time.undoSuccess(lastPunchDescription, lastPunch && lastPunch.description(user));
            Slack.whisper(msg, message);
        } catch (err) {
            Slack.error(`"${err}" was returned for an undo operation by ${user.slackName}`);
            Slack.whisper(message.copy.time.undoError, message);
        }
    } else {
        Slack.whisper(message.copy.time.undoFail, message);
    }
}

function onUpcomingEventsHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    let response = '';
    const upcomingEvents = organization.calendar.upcomingEvents();
    if (upcomingEvents.length > 0) {
        response = 'Upcoming events:\n' + upcomingEvents.reduce((acc, event) => response + `*${event.date.format('M/DD/YY')}* - ${event.name}\n`, response);
    } else {
        response = message.copy.time.noEvents;
    }
    const msg = {
        text: response,
        channel: message.channel
    } as Message;
    bot.say(msg);
    Slack.reactTo(message, 'dog2');
}

function onHoursHelpHandler(bot: botkit.Bot, message: Message) {
    Slack.whisper(message.copy.time.hoursHelp, message);
    Slack.reactTo(message, 'dog2');
}

function onHoursForDateHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    const tz = user.timetable.timezone.name;
    const date = moment(message.match[1], 'MM/DD/YYYY');
    if (!date.isValid()) {
        console.log(`hours: \"${message.match[1]}\" is an invalid date`);
        Slack.whisper(`\"${message.match[1]}\" is not a valid date`, message);
        Slack.reactTo(message, 'x');
        return;
    }
    const formattedDate = date.format('dddd, MMMM D, YYYY');

    const startOfDay = moment.tz(date, tz).startOf('day');
    const endOfDay = moment.tz(date, tz).endOf('day');
    const report = user.toRawPayroll(startOfDay, endOfDay);
    const attachments = user.punches.reduce((acc, punch) => {
        if (punch.date.isBefore(startOfDay) || punch.date.isAfter(endOfDay)) {
            return acc;
        }
        return [...acc, punch.slackAttachment()];
    }, []);

    let loggedAny = false;
    let msg;
    if (!report.logged && !report.vacation && !report.sick && !report.unpaid) {
        msg = `You haven't recorded any hours on ${formattedDate}`;
    } else {
        if (!report.logged) {
            msg = 'You haven\'t recorded any paid work time';
        } else {
            msg = `You have *${toTimeStr(+report.logged)} of paid work time*`;
            loggedAny = true;
        }
        msg = ['vacation', 'sick', 'unpaid'].reduce((acc, kind) => {
            if (report[kind]) {
                const value = +report[kind];
                if (!loggedAny) {
                    acc += `, but you have *${toTimeStr(value)} of ${kind}${kind === 'unpaid' ? 'work' : ''} time*`;
                    loggedAny = true;
                } else {
                    acc += ` and *${toTimeStr(value)} of ${kind} time*`;
                }
            }
            return acc;
        }, msg);
        msg += ` recorded for ${formattedDate}`;
    }
    if (report.extra && report.extra.projects && report.extra.projects.length > 0) {
        msg += ' (' + report.extra.projects.reduce((acc, project) => acc + `#${project.name}`, msg) + ')';
    }
    Slack.reactTo(message, 'dog2');
    Slack.whisper(msg, message, attachments);
}

function onHoursForPeriodHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);

    const tz = user.timetable.timezone.name;
    const now = moment.tz(tz);
    const mode = message.match[1].toLowerCase();

    let lowerBoundDate: moment.Moment;
    let upperBoundDate: moment.Moment;

    let report: Rows.PayrollReportsRow;
    let dateArticle;
    if (mode === 'week') {
        lowerBoundDate = moment({
            hour: 0,
            minute: 0,
            second: 0
        }).day('Sunday');
        upperBoundDate = now;
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
        dateArticle = 'this week';
    } else if (mode === 'month') {
        lowerBoundDate = moment.tz({
            hour: 0,
            minute: 0,
            second: 0
        }, tz).startOf('month');
        upperBoundDate = now;
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
        dateArticle = 'this month';
    } else if (mode === 'year') {
        lowerBoundDate = moment.tz({
            hour: 0,
            minute: 0,
            second: 0
        }, tz).startOf('year');
        upperBoundDate = now;
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
        dateArticle = 'this year';
    } else if (mode === 'yesterday') {
        lowerBoundDate = now.clone().subtract(1, 'days').startOf('day');
        upperBoundDate = now.clone().subtract(1, 'days').endOf('day');
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
        dateArticle = `yesterday (${lowerBoundDate.format('M/DD')})`;
    } else if (mode === 'period') {
        lowerBoundDate = moment({
            hour: 0,
            minute: 0,
            second: 0
        }).day('Monday');
        if (organization.calendar.isPayWeek()) {
            lowerBoundDate = lowerBoundDate.subtract(1, 'weeks');
        }
        upperBoundDate = lowerBoundDate.clone().add(13, 'days');
        if (message.match[0].match(/(last|previous)/)) {
            lowerBoundDate = lowerBoundDate.subtract(2, 'weeks');
            upperBoundDate = upperBoundDate.subtract(2, 'weeks');
            dateArticle = `last pay period (${lowerBoundDate.format('M/DD')} to ${upperBoundDate.format('M/DD')})`;
        } else {
            dateArticle = `this pay period (${lowerBoundDate.format('M/DD')} to ${upperBoundDate.format('M/DD')})`;
        }
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
    } else {
        lowerBoundDate = now.clone().hour(0).minute(0).second(0).subtract(1, 'minutes');
        upperBoundDate = now;
        report = user.toRawPayroll(lowerBoundDate, upperBoundDate);
        dateArticle = 'today';
    }

    const attachments = user.punches.reduce((acc, punch) => {
        if (punch.date.isBefore(lowerBoundDate) || punch.date.isAfter(upperBoundDate)) {
            return acc;
        } else if (!punch.elapsed && !punch.times.block) {
            return acc;
        }
        return [...acc, punch.slackAttachment()];
    }, []);

    let loggedAny = false
    let msg;
    if (!report.logged && !report.vacation && !report.sick && !report.unpaid) {
        msg = `You haven't recorded any hours ${dateArticle}.`;
    } else {
        if (!report.logged) {
            msg = 'You haven\'t recorded any paid work time';
        } else {
            msg = `You have *${toTimeStr(+report.logged)} of paid work time*`;
            loggedAny = true
        }
        msg = ['vacation', 'sick', 'unpaid'].reduce((acc, kind) => {
            if (report[kind] && report[kind] > 0) {
                if (!loggedAny) {
                    acc += `, but you have *${toTimeStr(+report[kind])} of ${kind}${kind === 'unpaid' ? 'work' : ''} time*`;
                    loggedAny = true;
                } else {
                    acc += ` and *${toTimeStr(+report[kind])} of ${kind} time*`;
                }
            }
            return acc;
        }, msg);
        msg += ` recorded for ${dateArticle}.`;
    }
    if (report.extra && report.extra.projects && report.extra.projects.length > 0) {
        msg += ' (' + report.extra.projects.map(project => `#${project.name} `) + ')';
        msg = msg.replace(' )', ')');
    }

    Slack.reactTo(message, 'dog2');
    Slack.whisper(msg, message, attachments);
}

function onUserStatusHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    Slack.whisper('Your status:', message, [user.slackAttachment()]);
    Slack.reactTo(message, 'dog2');
}

function onUserTimeHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    const userTime = moment.tz(user.timetable.timezone.name);
    const ibizanTime = moment.tz(TIMEZONE);
    let msg = `It's currently *${userTime.format('h:mm A')}* in your timezone (${userTime.format('z, Z')}).`
    if (userTime.format('z') !== ibizanTime.format('z')) {
        msg += `\n\nIt's ${ibizanTime.format('h:mm A')} in the default timezone (${ibizanTime.format('z, Z')}).`;
    }
    Slack.whisper(msg, message);
    Slack.reactTo(message, 'dog2');
}

function onUserTimezoneHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    const userTime = moment.tz(user.timetable.timezone.name);
    Slack.whisper(`Your timezone is set to *${user.timetable.timezone.name}* (${userTime.format('z, Z')}).`, message);
    Slack.reactTo(message, 'dog2');
}

function onSetUserTimezoneHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    let input = message.match[1];
    let isTzSet = false;
    let tz = user.setTimezone(input);

    if (tz) {
        isTzSet = true;
    } else {
        // Try adding 'America/' if a region is not specified
        if (!input.includes('/')) {
            input = 'America/' + input;
        }
        if (tz = user.setTimezone(input)) {
            isTzSet = true;
        } else {
            // Try changing spaces to underscores
            input = input.replace(' ', '_');
            if (tz = user.setTimezone(input)) {
                isTzSet = true;
            }
        }
    }
    if (isTzSet) {
        const userTime = moment.tz(user.timetable.timezone.name);
        Slack.whisper(`Your timezone is now *${user.timetable.timezone.name}* (${userTime.format('z, Z')}).`, message);
    } else {
        Slack.whisper('I do not recognize that timezone. Check <https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List|this list> for a valid time zone name.', message);
        Slack.reactTo(message, 'x');
    }
}

function onSetUserActiveTimesHandler(bot: botkit.Bot, message: Message) {
    const organization: Organization = message.organization;
    if (!organization) {
        console.error('No Organization was found for the team: ' + bot);
        return;
    }
    const user = organization.getUserBySlackName(message.user_obj.name);
    const command = message.match[1];

    if (!command) {
        const msg = {
            text: message.copy.time.activeHelp,
            channel: message.channel
        } as Message;
        bot.say(msg);
        Slack.reactTo(message, 'dog2');
        return;
    }

    const comps = command.split(' ') || [];
    const scope = comps[0] || 'unknown';
    const time = comps[1] || 'notime';

    if (scope !== 'unknown' && time !== 'notime') {
        const newTime = moment.tz(time, 'h:mm A', user.timetable.timezone.name);
        if (!newTime.isValid()) {
            Slack.whisper(`\"${time}\" is not a valid time.`, message);
            Slack.reactTo(message, 'x');
            return;
        }
        if (scope === 'start') {
            if (!newTime.isBefore(user.timetable.end)) {
                Slack.whisper(`${newTime.format('h:mm A')} is not before your current end time of ${user.timetable.start.format('h:mm A')}.`, message);
                Slack.reactTo(message, 'x');
                return;
            }
            user.setStart(newTime);
        } else if (scope === 'end') {
            if (!newTime.isAfter(user.timetable.start)) {
                Slack.whisper(`${newTime.format('h:mm A')} is not after your current start time of ${user.timetable.start.format('h:mm A')}.`, message);
                Slack.reactTo(message, 'x');
                return;
            }
            user.setEnd(newTime);
        }
        Slack.whisper(`Your active *${scope}* time is now *${newTime.format('h:mm A')}*.`, message);
        Slack.reactTo(message, 'dog2');
    } else {
        Slack.whisper(message.copy.time.activeFail, message);
        Slack.reactTo(message, 'x');
    }
}

export default function (controller: botkit.Controller) {
    // Punch for a given mode
    // respond
    // time.punchByMode, userRequired: true
    controller.hears(REGEX_STR.modes,
        EVENTS.respond,
        buildOptions({ id: 'time.punchByMode', userRequired: true }, controller),
        onPunchHandler);

    // Punch for a block of time
    // respond
    // time.punchByTime, userRequired: true
    controller.hears(REGEX_STR.rel_time,
        EVENTS.respond,
        buildOptions({ id: 'time.punchByTime', userRequired: true }, controller),
        onPunchHandler);

    // Switch projects during an 'in' punch
    // append to lastPunch
    // respond
    // time.append, userRequired: true
    controller.hears('(append|add)',
        EVENTS.respond,
        buildOptions({ id: 'time.append', userRequired: true }, controller),
        onAppendHandler);

    // respond
    // time.undo, userRequired: true
    controller.hears('undo',
        EVENTS.respond,
        buildOptions({ id: 'time.undo', userRequired: true }, controller),
        onUndoHandler);

    // respond
    // time.events
    controller.hears('(events|upcoming)$',
        EVENTS.respond,
        buildOptions({ id: 'time.events' }, controller),
        onUpcomingEventsHandler);

    /** User feedback **/

    // Gives helpful info if a user types 'hours' with no question mark or date
    // respond
    // time.hoursHelp
    controller.hears('hours$',
        EVENTS.respond,
        buildOptions({ id: 'time.hoursHelp' }, controller),
        onHoursHelpHandler);

    // Returns the hours worked on a given date
    // respond
    // time.hoursOnDate, userRequired: true
    controller.hears('hours (.*)',
        EVENTS.respond,
        buildOptions({ id: 'time.hoursOnDate', userRequired: true }, controller),
        onHoursForDateHandler);

    // Returns the hours worked for the given time period
    // respond
    // time.hours, userRequired: true
    controller.hears(REGEX_STR.hours,
        EVENTS.respond,
        buildOptions({ id: 'time.hours', userRequired: true }, controller),
        onHoursForPeriodHandler);

    // Returns the user's info as a slackAttachment
    // respond
    // time.status, userRequired: true
    controller.hears('(status|info)$',
        EVENTS.respond,
        buildOptions({ id: 'time.status', userRequired: true }, controller),
        onUserStatusHandler);

    // Returns the user's time in their timezone, as well as Ibizan's default time
    // respond
    // time.time, userRequired: true
    controller.hears('time$',
        EVENTS.respond,
        buildOptions({ id: 'time.time', userRequired: true }, controller),
        onUserTimeHandler);

    // Returns the user's timezone
    // respond
    // time.time, userRequired: true
    controller.hears('timezone$',
        EVENTS.respond,
        buildOptions({ id: 'time.time', userRequired: true }, controller),
        onUserTimezoneHandler);

    // Sets the user's timezone
    // respond
    // time.time, userRequired: true
    controller.hears('timezone (.*)',
        EVENTS.respond,
        buildOptions({ id: 'time.time', userRequired: true }, controller),
        onSetUserTimezoneHandler);

    // Sets the user's active times
    // respond
    // time.active, userRequired: true
    controller.hears('active\s*(.*)?$',
        EVENTS.respond,
        buildOptions({ id: 'time.active', userRequired: true }, controller),
        onSetUserActiveTimesHandler);

    // Slash command responses
    // /punch -> time.punchByMode OR time.punchByTime
    // /hours -> time.hours
    // /ibizan -> catchall that submits anything to ibizan as if it were a mention
    controller.on('slash_command', function(bot, message) {
        bot.replyAcknowledge();

        if (message.command == '/punch') {
            message.match = message.text.match(REGEX_STR.modes);
            onPunchHandler(bot, message);
        } else if (message.command == '/hours') {
            message.match = message.text.match(REGEX_STR.hours);
            onHoursForPeriodHandler(bot, message);
        } else if (message.command == '/ibizan') {
            controller.trigger('direct_mention', [bot, message]);
        }
    });

    return controller;
};