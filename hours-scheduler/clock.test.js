import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryAction, researchOpen } from './clock.js';

test('desired research availability covers complete weekday and weekend windows', () => {
  const days=[
    ['2026-07-06',17,3],['2026-07-07',17,2],['2026-07-08',17,2],
    ['2026-07-09',17,2],['2026-07-10',17,2],['2026-07-11',16,2],['2026-07-12',16,3]
  ];
  for(const [day,start,stop] of days){
    const at=(hour,minute=0)=>new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00-04:00`);
    assert.equal(researchOpen(at(0)),true,`${day} overnight`);
    assert.equal(researchOpen(at(stop-1,59)),true,`${day} before close`);
    assert.equal(researchOpen(at(stop)),false,`${day} closed`);
    assert.equal(researchOpen(at(12)),false,`${day} midday`);
    assert.equal(researchOpen(at(start-1,59)),false,`${day} before open`);
    assert.equal(researchOpen(at(start)),true,`${day} opens`);
    assert.equal(researchOpen(at(start,30)),true,`${day} remains open after boundary grace`);
    assert.equal(researchOpen(at(23,59)),true,`${day} evening`);
  }
});

test('desired availability survives both daylight saving transitions',()=>{
  for(const [instant,expected] of [
    ['2026-03-08T06:59:59Z',true],['2026-03-08T07:00:00Z',false],
    ['2026-03-08T19:59:59Z',false],['2026-03-08T20:00:00Z',true],
    ['2026-11-01T05:30:00Z',true],['2026-11-01T06:30:00Z',true],
    ['2026-11-01T07:59:59Z',true],['2026-11-01T08:00:00Z',false],
    ['2026-11-01T20:59:59Z',false],['2026-11-01T21:00:00Z',true],
    ['2026-11-02T07:59:59Z',true],['2026-11-02T08:00:00Z',false]
  ])assert.equal(researchOpen(new Date(instant)),expected,instant);
  assert.throws(()=>researchOpen(new Date('invalid')));
});

test('each day starts at its specified Eastern hour and closes the previous evening window', () => {
  const days = [
    ['2026-07-06', 17, 3], // Monday closes Sunday's weekend window.
    ['2026-07-07', 17, 2],
    ['2026-07-08', 17, 2],
    ['2026-07-09', 17, 2],
    ['2026-07-10', 17, 2],
    ['2026-07-11', 16, 2], // Saturday closes Friday's weekday window.
    ['2026-07-12', 16, 3]
  ];
  for (const [day, start, stop] of days) {
    const at = (hour, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-04:00`);
    assert.equal(boundaryAction(at(start)), 'start', `${day} opens`);
    assert.equal(boundaryAction(at(stop)), 'stop', `${day} closes`);
    assert.equal(boundaryAction(at(start - 1)), null, `${day} does not open early`);
    assert.equal(boundaryAction(at(stop + 1)), null, `${day} does not close twice`);
  }
});

test('acts only in the first fifteen minutes of a matching boundary hour', () => {
  for (const [hour, action] of [[17, 'start'], [2, 'stop']]) {
    for (const minute of [0, 1, 7, 14])
      assert.equal(boundaryAction(new Date(`2026-07-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:59-04:00`)), action);
    for (const minute of [15, 30, 59])
      assert.equal(boundaryAction(new Date(`2026-07-07T${String(hour).padStart(2, '0')}:${minute}:00-04:00`)), null);
  }
  for (const hour of [0, 1, 3, 8, 12, 16, 18, 23])
    assert.equal(boundaryAction(new Date(`2026-07-07T${String(hour).padStart(2, '0')}:00:00-04:00`)), null);
});

test('winter and summer UTC offsets select the same Eastern boundaries', () => {
  for (const [instant, expected] of [
    ['2026-01-06T22:00:00Z', 'start'], ['2026-01-07T07:00:00Z', 'stop'],
    ['2026-07-07T21:00:00Z', 'start'], ['2026-07-08T06:00:00Z', 'stop'],
    ['2026-01-10T21:00:00Z', 'start'], ['2026-01-11T08:00:00Z', 'stop'],
    ['2026-07-11T20:00:00Z', 'start'], ['2026-07-12T07:00:00Z', 'stop']
  ]) assert.equal(boundaryAction(new Date(instant)), expected, instant);
});

test('spring forward and fall back close the weekend at 3 AM without an extra action', () => {
  for (const [instant, expected] of [
    ['2026-03-08T06:00:00Z', null], // 1 AM EST, before the skipped hour.
    ['2026-03-08T07:00:00Z', 'stop'], // 3 AM EDT.
    ['2026-03-08T08:00:00Z', null],
    ['2026-03-08T20:00:00Z', 'start'],
    ['2026-11-01T05:00:00Z', null], // First 1 AM.
    ['2026-11-01T06:00:00Z', null], // Repeated 1 AM.
    ['2026-11-01T07:00:00Z', null], // 2 AM EST.
    ['2026-11-01T08:00:00Z', 'stop'], // 3 AM EST.
    ['2026-11-01T21:00:00Z', 'start']
  ]) assert.equal(boundaryAction(new Date(instant)), expected, instant);
});

test('the six UTC candidate triggers produce exactly one start and one stop per day around DST', () => {
  const candidateHours = [6, 7, 8, 20, 21, 22];
  for (const firstDay of ['2026-03-05', '2026-10-29']) {
    for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
      const day = new Date(`${firstDay}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + dayOffset);
      for (const delay of [0, 14]) {
        const actions = candidateHours.map(hour => {
          const trigger = new Date(day);
          trigger.setUTCHours(hour, delay, 0, 0);
          return boundaryAction(trigger);
        }).filter(Boolean);
        assert.deepEqual(actions, ['stop', 'start'], `${day.toISOString()} delayed ${delay} minutes`);
      }
    }
  }
});

test('invalid dates fail instead of choosing a boundary', () => {
  assert.throws(() => boundaryAction(new Date('invalid')));
});
