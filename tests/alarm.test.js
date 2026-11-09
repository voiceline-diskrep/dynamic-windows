'use strict';
const test = require('node:test');
const assert = require('node:assert');

function convertTo24Hour(hour, ampm) {
  let h = hour % 12;
  if (ampm === 'PM') h += 12;
  return h;
}

function shouldAlarmTrigger(alarm, curHour24, curMinute, todayKey) {
  if (!alarm.enabled) return false;
  const targetHour = convertTo24Hour(alarm.hour, alarm.ampm);
  if (targetHour === curHour24 && alarm.minute === curMinute && alarm.lastTriggeredDate !== todayKey) {
    return true;
  }
  return false;
}

function calculateSnoozeTime(currentDate, snoozeMinutes = 5) {
  const snoozeTime = new Date(currentDate.getTime() + snoozeMinutes * 60 * 1000);
  let sh = snoozeTime.getHours();
  const sm = snoozeTime.getMinutes();
  const sampm = sh >= 12 ? 'PM' : 'AM';
  sh = sh % 12 || 12;
  return { hour: sh, minute: sm, ampm: sampm };
}

test('AlarmEngine: converts 12h AM/PM to 24h correctly', () => {
  assert.strictEqual(convertTo24Hour(12, 'AM'), 0);
  assert.strictEqual(convertTo24Hour(7, 'AM'), 7);
  assert.strictEqual(convertTo24Hour(12, 'PM'), 12);
  assert.strictEqual(convertTo24Hour(1, 'PM'), 13);
  assert.strictEqual(convertTo24Hour(11, 'PM'), 23);
});

test('AlarmEngine: triggers only when enabled and matches exact time', () => {
  const alarm = {
    id: 'test_1',
    hour: 7,
    minute: 30,
    ampm: 'AM',
    enabled: true,
    lastTriggeredDate: null
  };

  const today = '2026-11-09';
  // Wrong hour
  assert.strictEqual(shouldAlarmTrigger(alarm, 6, 30, today), false);
  // Wrong minute
  assert.strictEqual(shouldAlarmTrigger(alarm, 7, 29, today), false);
  // Exact match
  assert.strictEqual(shouldAlarmTrigger(alarm, 7, 30, today), true);

  // Once triggered on todayKey, must not re-trigger within same day
  alarm.lastTriggeredDate = today;
  assert.strictEqual(shouldAlarmTrigger(alarm, 7, 30, today), false);

  // Next day triggers again
  assert.strictEqual(shouldAlarmTrigger(alarm, 7, 30, '2026-11-10'), true);
});

test('AlarmEngine: snooze calculates correct +5m forward roll across hour boundaries', () => {
  // Test normal 5m advance
  const t1 = new Date('2026-11-09T07:10:00');
  const snz1 = calculateSnoozeTime(t1, 5);
  assert.deepStrictEqual(snz1, { hour: 7, minute: 15, ampm: 'AM' });

  // Test hour rollover at 7:58 -> 8:03
  const t2 = new Date('2026-11-09T07:58:00');
  const snz2 = calculateSnoozeTime(t2, 5);
  assert.deepStrictEqual(snz2, { hour: 8, minute: 3, ampm: 'AM' });

  // Test AM to PM rollover at 11:57 AM -> 12:02 PM
  const t3 = new Date('2026-11-09T11:57:00');
  const snz3 = calculateSnoozeTime(t3, 5);
  assert.deepStrictEqual(snz3, { hour: 12, minute: 2, ampm: 'PM' });
});

test('AlarmEngine: disabled alarm never triggers', () => {
  const alarm = {
    id: 'test_off',
    hour: 8,
    minute: 0,
    ampm: 'AM',
    enabled: false,
    lastTriggeredDate: null
  };
  assert.strictEqual(shouldAlarmTrigger(alarm, 8, 0, '2026-11-09'), false);
});
