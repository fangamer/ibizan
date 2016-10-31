
import * as moment from 'moment';
const GoogleSpreadsheet = require('google-spreadsheet');

import { Rows } from '../shared/rows';
import { momentForHoliday } from '../shared/moment-holiday';
import * as Logger from '../logger';
import { CalendarEvent } from './calendar';
import { Project } from './project';
import { Punch } from './punch';
import { User } from './user';

export interface GoogleAuth {
  client_email: string;
  private_key: string
};

export class Spreadsheet {
  sheet: any;
  initialized: boolean;
  title: string;
  id: string;
  url: string;
  rawData: any;
  payroll: any;
  variables: any;
  projects: any;
  employees: any;
  events: any;

  constructor(sheetId: string) {
    if (sheetId && sheetId !== 'test') {
      this.sheet = new GoogleSpreadsheet(sheetId);
    } else {
      this.sheet = false;
    }
    this.initialized = false;
  }
  async authorize(auth: GoogleAuth) {
    return new Promise((resolve, reject) => {
      this.sheet.useServiceAccountAuth(auth, (err) => {
        if (err) {
          reject(err);
        } else {
          Logger.Console.log('Authorized successfully');
          resolve();
        }
      });
      Logger.Console.log('Waiting for authorization');
    });
  }
  async loadOptions() {
    let opts;
    try {
      opts = await this.loadWorksheets();
      opts = await this.loadVariables(opts);
      opts = await this.loadProjects(opts);
      opts = await this.loadEmployees(opts);
      opts = await this.loadEvents(opts);
      opts = await this.loadPunches(opts);
    } catch (err) {
      throw err;
    }
    this.initialized = true;
    return opts;
  }
  async saveRow(row: any, rowName: string = 'row') {
    return new Promise((resolve, reject) => {
      row.save((err) => {
        if (err) {
          // Retry up to 3 times
          let retry = 1;
          setTimeout(() => {
            if (retry <= 3) {
              Logger.Console.debug(`Retrying save of ${rowName}, attempt ${retry}...`);
              row.save((err) => {
                if (!err) {
                  Logger.Console.debug(`${rowName} saved successfully`);
                  resolve(row);
                  return true;
                }
              });
              retry += 1;
            } else {
              reject(err);
              Logger.Console.error(`Unable to save ${rowName}`, new Error(err));
            }
          }, 1000);
        } else {
          resolve(row);
        }
      });
    });
  }
  async newRow(sheet, row, rowName: string = 'row') {
    return new Promise((resolve, reject) => {
      if (!sheet) {
        reject('No sheet passed to newRow');
      } else if (!row) {
        reject('No row passed to newRow');
      } else {
        sheet.addRow(row, (err) => {
          if (err) {
            // Retry up to 3 times
            let retry = 1
            setTimeout(() => {
              if (retry <= 3) {
                Logger.Console.debug(`Retrying adding ${rowName}, attempt ${retry}...`);
                sheet.addRow(row, (err) => {
                  if (!err) {
                    Logger.Console.debug(`${rowName} saved successfully`);
                    resolve(row);
                    return true;
                  }
                });
                retry += 1;
              } else {
                reject(err);
                Logger.Console.error(`Unable to add ${rowName}`, new Error(err));
              }
            }, 1000);
          } else {
            resolve(row);
          }
        });
      }
    });
  }
  async enterPunch(punch: Punch, user: User) {
    const valid = punch.isValid(user);
    if (!punch || !user) {
      throw 'Invalid parameters passed: Punch or user is undefined';
    } else if (typeof valid === 'string') {
      throw valid;
    } else {
      if (punch.mode === 'out') {
        if (user.punches && user.punches.length > 0) {
          const len = user.punches.length;
          let last;
          for (let i = len - 1; i >= 0; i--) {
            last = user.punches[i];
            if (last.mode === 'in') {
              break;
            } else if (last.mode === 'out') {
              continue;
            } else if (last.times.length === 2) {
              continue;
            }
          }
          if (!last) {
            throw 'You haven\'t punched out yet.';
          }
          last.out(punch);
          const row = last.toRawRow(user.name);
          try {
            await this.saveRow(row, `punch for ${user.name}`);
            // add hours to project in projects
            let elapsed;
            if (last.times.block) {
              elapsed = last.times.block;
            } else {
              elapsed = last.elapsed;
            }
            const logged = user.timetable.loggedTotal;
            user.timetable.loggedTotal = logged + elapsed;
            // calculate project times
            for (let project of last.projects) {
              project.total += elapsed;
              try {
                await project.updateRow();
              } catch (err) {
                throw err;
              }
            }
            return last;
          } catch (err) {
            throw err;
          }
        }
      } else {
        const row = punch.toRawRow(user.name);
        try {
          const newRow = await this.newRow(this.rawData, row);
          this.rawData.getRows({}, async (err, rows) => {
            if (err || !rows) {
              throw `Could not get rawData rows: ${err}`;
            } else {
              const rowMatches = rows.filter(r => r.id === row.id);
              const rowMatch = rowMatches[0];
              punch.assignRow(rowMatch);
              user.punches.push(punch);
              if (punch.mode === 'vacation' || punch.mode === 'sick' || punch.mode === 'unpaid') {
                let elapsed;
                if (punch.times.block) {
                  elapsed = punch.times.block;
                } else {
                  elapsed = punch.elapsed;
                }
                const elapsedDays = user.toDays(elapsed);
                if (punch.mode === 'vacation') {
                  const total = user.timetable.vacationTotal;
                  const available = user.timetable.vacationAvailable;
                  user.timetable.setVacation(total + elapsedDays, available - elapsedDays);
                } else if (punch.mode === 'sick') {
                  const total = user.timetable.sickTotal;
                  const available = user.timetable.sickAvailable;
                  user.timetable.setSick(total + elapsedDays, available - elapsedDays);
                } else if (punch.mode === 'unpaid') {
                  const total = user.timetable.unpaidTotal;
                  user.timetable.unpaidTotal = total + elapsedDays;
                }
                try {
                  await user.updateRow();
                } catch (err) {
                  throw `Could not update user row: ${err}`;
                }
                return punch;
              }
            }
          });
        } catch (err) {
          throw `Could not add row: ${err}`;
        }
      }
    }
  }
  async generateReport(reports) {
    return new Promise<number>((resolve, reject) => {
      let numberDone = 0;
      for (let row of reports) {
        this.payroll.addRow(row, (err) => {
          if (err) {
            reject(err);
          } else {
            numberDone += 1;
            if (numberDone >= reports.length) {
              resolve(numberDone);
            }
          }
        });
      }
    });
  }
  async addEventRow(row) {
    return new Promise((resolve, reject) => {
      this.events.addRow(row, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }
  private async loadWorksheets() {
    return new Promise((resolve, reject) => {
      this.sheet.getInfo((err, info) => {
        if (err) {
          reject(err);
        } else {
          this.title = info.title;
          let id = info.id;
          id = id.replace('https://spreadsheets.google.com/feeds/worksheets/', '');
          this.id = id.replace('/private/full', '');
          this.url = `https://docs.google.com/spreadsheets/d/${this.id}`;
          for (let worksheet of info.worksheets) {
            let title = worksheet.title;
            const words = title.split(' ');
            title = words[0].toLowerCase();
            let i = 1;
            while (title.length < 6 && i < words.length) {
              title = title.concat(words[i]);
              i += 1;
            }
            this[title] = worksheet;
          }
          if (!(this.rawData && this.payroll && this.variables && this.projects && this.employees && this.events)) {
            reject('Worksheets failed to be associated properly');
          } else {
            Logger.Console.fun('----------------------------------------');
            resolve({});
          }
        }
      });
    });
  }
  private async loadVariables(opts: any) {
    return new Promise((resolve, reject) => {
      this.variables.getRows((err, rows) => {
        if (err) {
          reject(err);
        } else {
          const variableRows = rows.map((row, index, arr) => new Rows.VariablesRow(row));
          const opts = {
            vacation: 0,
            sick: 0,
            houndFrequency: 0,
            payWeek: null,
            holidays: [],
            clockChannel: '',
            exemptChannels: []
          };
          for (let row of variableRows) {
            if (row.vacation || +row.vacation === 0) {
              opts.vacation = +row.vacation;
            }
            if (row.sick || +row.sick === 0) {
              opts.sick = +row.sick;
            }
            if (row.houndFrequency || +row.houndFrequency === 0) {
              opts.houndFrequency = +row.houndFrequency;
            }
            if (row.holidays) {
              const name = row.holidays;
              let date;
              if (row.holidayOverride) {
                date = moment(row.holidayOverride, 'MM/DD/YYYY');
              } else {
                date = momentForHoliday(row.holidays);
              }
              opts.holidays.push({ name, date });
            }
            if (row.payweek) {
              opts.payWeek = moment(row.payweek, 'MM/DD/YYYY');
            }
            if (row.clockChannel) {
              opts.clockChannel = row.clockChannel.replace('#', '');
            }
            if (row.exemptChannel) {
              opts.exemptChannels.push(row.exemptChannel.replace('#', ''));
            }
          }
          Logger.Console.fun('Loaded organization settings');
          Logger.Console.fun('----------------------------------------');
          resolve(opts);
        }
      });
    });
  }
  private async loadProjects(opts: any) {
    return new Promise((resolve, reject) => {
      this.projects.getRows((err, rows) => {
        if (err) {
          reject(err);
        } else {
          const projectRows = rows.map((row, index, arr) => new Rows.ProjectsRow(row));
          let projects: Project[] = [];
          for (let row of projectRows) {
            const project = Project.parse(row);
            if (project) {
              projects.push(project);
            }
          }
          opts.projects = projects;
          Logger.Console.fun(`Loaded ${projects.length} projects`);
          Logger.Console.fun('----------------------------------------');
          resolve(opts);
        }
      });
    });
  }
  private async loadEmployees(opts: any) {
    return new Promise((resolve, reject) => {
      this.employees.getRows((err, rows) => {
        if (err) {
          reject(err);
        } else {
          const userRows = rows.map((row, index, arr) => new Rows.UsersRow(row));
          let users: User[] = [];
          for (let row of userRows) {
            const user = User.parse(row);
            if (user) {
              users.push(user);
            }
          }
          opts.users = users;
          Logger.Console.fun(`Loaded ${users.length} users`);
          Logger.Console.fun('----------------------------------------');
          resolve(opts);
        }
      });
    });
  }
  private async loadEvents(opts: any) {
    return new Promise((resolve, reject) => {
      this.events.getRows((err, rows) => {
        if (err) {
          reject(err);
        } else {
          const eventsRows: Rows.EventsRow[] = rows.map((row, index, arr) => new Rows.EventsRow(row));
          let events: CalendarEvent[] = [];
          for (let row of eventsRows) {
            const calendarEvent = CalendarEvent.parse(row);
            if (calendarEvent) {
              events.push(calendarEvent);
            }
          }
          opts.events = events;
          Logger.Console.fun(`Loaded ${events.length} calendar events`);
          Logger.Console.fun('----------------------------------------');
          resolve(opts);
        }
      })
    });
  }
  private async loadPunches(opts: any) {
    return new Promise((resolve, reject) => {
      this.rawData.getRows((err, rows) => {
        if (err) {
          reject(err);
        } else {
          const punchRows = rows.map((row, index, arr) => new Rows.RawDataRow(row));
          punchRows.forEach((row, index, arr) => {
            const user: User = opts.users.filter((item, index, arr) => item.name === row.name)[0];
            const punch = Punch.parseRaw(user, row, this, opts.projects);
            if (punch && user) {
              user.punches.push(punch);
            }
          });
          Logger.Console.fun(`Loaded ${rows.length} punches for ${opts.users.length} users`);
          Logger.Console.fun('----------------------------------------');
          resolve(opts);
        }
      });
    });
  }
}
