moment = require 'moment-timezone'
expect = require('chai').expect

constants = require '../../src/helpers/constants'
{User, Timetable} = require '../../src/models/user'

describe 'Timetable', ->
  beforeEach ->
    start = moment({day: 3, hour: 7})
    end = moment({day: 3, hour: 18})
    @timetable = new Timetable(start, end, 'America/New_York')

  test_validate_set_values = (timetable, mode,
                               total, expectedTotal,
                               available, expectedAvailable) ->
    timetable['set' + mode.charAt(0).toUpperCase() + mode.substring(1)](total, available)
    expect(timetable[mode+'Total']).to.eql expectedTotal
    if available and expectedAvailable
      expect(timetable[mode+'Available']).to.eql expectedAvailable

  describe '#setVacation(total, available)', ->
    mode = 'vacation'
    it 'should change the underlying values', ->
      test_validate_set_values(@timetable, mode, 85, 85, 30, 30)
    it 'should only take numbers', ->
      test_validate_set_values(@timetable, mode, 'ghosts', 0, {}, 0)
    it 'should only take positive numbers', ->
      test_validate_set_values(@timetable, mode, -85, 0, -30, 0)
    it 'should handle less than two arguments gracefully', ->
      test_validate_set_values(@timetable, mode, undefined, 0)
  describe '#setSick(total, available)', ->
    mode = 'sick'
    it 'should change the underlying values', ->
      test_validate_set_values(@timetable, mode, 85, 85, 30, 30)
    it 'should only take numbers', ->
      test_validate_set_values(@timetable, mode, 'ghosts', 0, {}, 0)
    it 'should only take positive numbers', ->
      test_validate_set_values(@timetable, mode, -85, 0, -30, 0)
    it 'should handle less than two arguments gracefully', ->
      test_validate_set_values(@timetable, mode, undefined, 0)
  describe '#setUnpaid(total)', ->
    mode = 'unpaid'
    it 'should change the underlying values', ->
      test_validate_set_values(@timetable, mode, 85, 85)
    it 'should only take numbers', ->
      test_validate_set_values(@timetable, mode, 'ghosts', 0)
    it 'should only take positive numbers', ->
      test_validate_set_values(@timetable, mode, -85, 0)
    it 'should handle less than two arguments gracefully', ->
      test_validate_set_values(@timetable, mode, undefined, 0)
  describe '#setLogged(total)', ->
    mode = 'logged'
    it 'should change the underlying values', ->
      test_validate_set_values(@timetable, mode, 85, 85)
    it 'should only take numbers', ->
      test_validate_set_values(@timetable, mode, 'ghosts', 0)
    it 'should only take positive numbers', ->
      test_validate_set_values(@timetable, mode, -85, 0)
    it 'should handle less than two arguments gracefully', ->
      test_validate_set_values(@timetable, mode, undefined, 0)
  describe '#setAverageLogged(total)', ->
    mode = 'averageLogged'
    it 'should change the underlying values', ->
      test_validate_set_values(@timetable, mode, 85, 85)
    it 'should only take numbers', ->
      test_validate_set_values(@timetable, mode, 'ghosts', 0)
    it 'should only take positive numbers', ->
      test_validate_set_values(@timetable, mode, -85, 0)
    it 'should handle less than two arguments gracefully', ->
      test_validate_set_values(@timetable, mode, undefined, 0)

test_row = require('../mocks/mocked/mocked_employees.json')[0]

describe 'User', ->
  beforeEach ->
    start = moment({day: 3, hour: 7})
    end = moment({day: 3, hour: 18})
    timetable = new Timetable(start, end, moment.tz.zone('America/New_York'))
    @user = new User('Jimmy Hendricks', 'jeff', false, timetable)
  describe '#parse(row)', ->
    it 'should return a new User when given a row', ->
      user = User.parse test_row
      expect(user).to.not.be.null
  describe '#activeHours()', ->
    it 'should return an array', ->
      expect(@user.activeHours()).to.be.instanceof Array
    it 'should return an array of two dates', ->
      dates = @user.activeHours()
      expect(dates).to.have.length(2)
      expect(dates).to.have.deep.property('[0]')
                    .that.is.an.instanceof moment
      expect(dates).to.have.deep.property('[1]')
                    .that.is.an.instanceof moment
    it 'should return the start and end times', ->
      dates = @user.activeHours()
      expect(dates).to.have.deep.property '[0]', @user.timetable.start
      expect(dates).to.have.deep.property '[1]', @user.timetable.end
  describe '#activeTime()', ->
    it 'should return the elapsed time between start and end', ->
      elapsed = @user.activeTime()
      expect(elapsed).to.be.a.Number
      expect(elapsed).to.equal 8
  describe '#isInactive()', ->
    it 'should be true when it is earlier than the start time', ->
      [start, end] = @user.activeHours()
      time = moment(start).subtract(2, 'hours')
      expect(@user.isInactive(time)).to.be.true
    it 'should be true when it is later than the end time', ->
      [start, end] = @user.activeHours()
      time = moment(end).add(2, 'hours')
      expect(@user.isInactive(time)).to.be.true
    it 'should be false when it is in between the start and end time', ->
      [start, end] = @user.activeHours()
      time = moment(start).add(end.diff(start, 'hours') / 2, 'hours')
      expect(@user.isInactive(time)).to.be.false
  describe '#undoPunch()', ->
  describe '#toRawPayroll(start, end)', ->
    it 'should not return null', ->
      payrollRow = @user.toRawPayroll()
      expect(payrollRow).to.not.be.null
  describe '#updateRow()', ->
  describe '#description()', ->
    it 'should return a description of the project for output', ->
      description = @user.description()
      expect(description).to.exist
