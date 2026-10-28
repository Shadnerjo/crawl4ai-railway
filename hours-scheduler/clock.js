const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekend = day => day === 0 || day === 6;

function easternParts(date) {
  const parts = easternClock.formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  const day = weekdays.indexOf(value('weekday'));
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  if (day < 0 || !Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error('Could not determine the Eastern scheduler time.');
  return {day,hour,minute};
}

// Each overnight closing time belongs to the preceding evening's window.
export function researchOpen(date = new Date()) {
  const {day,hour,minute}=easternParts(date);
  const minutes=hour*60+minute;
  return minutes >= (weekend(day)?16:17)*60 || minutes < (weekend((day+6)%7)?3:2)*60;
}

// Retained for testing individual boundaries; production reconciliation uses
// researchOpen every five minutes so a missed boundary can recover later.
export function boundaryAction(date = new Date()) {
  const {day,hour,minute}=easternParts(date);
  if (minute >= 15) return null;
  if (hour === (weekend(day) ? 16 : 17)) return 'start';
  const previousDay = (day + 6) % 7;
  if (hour === (weekend(previousDay) ? 3 : 2)) return 'stop';
  return null;
}
