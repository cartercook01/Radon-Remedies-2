// Setup check: tells you whether the site can really talk to your Apple Calendar.
// Set DIAG_KEY in Netlify to any long random text, then open:
//   https://YOUR-SITE/.netlify/functions/calendar-check?key=YOUR_DIAG_KEY
// Add &write=1 to also create and immediately delete a test event.
// You can remove DIAG_KEY afterward to switch this page off.
const cal = require('../lib/caldav');

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body, null, 2) });

exports.handler = async (event) => {
  const key = process.env.DIAG_KEY;
  const q = event.queryStringParameters || {};
  if (!key || q.key !== key) return reply(404, { error: 'Not found' });

  const c = cal.cfg();
  const report = {
    configured: { ICLOUD_APPLE_ID: !!c.user, ICLOUD_APP_PASSWORD: !!c.pass },
    settings: { timezone: c.tz, arrivalTimes: `${cal.label12(c.startHour, 0)} to ${cal.label12(c.endHour, 0)}`, visitMinutes: c.slotMin, pickupReminder: `${c.pickupDays} days later, ${c.pickupMin} minutes`, bufferMinutes: c.bufferMin, openDays: c.openDays, minNoticeHours: c.minNoticeH, horizonDays: c.horizonDays, allDayEventsBlock: c.allDayBlocks },
  };
  if (!cal.configured()) { report.result = 'FAIL: set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD'; return reply(200, report); }
  try {
    const d = await cal.discover(true);
    report.calendarsFound = d.calendars.map((k) => k.name);
    report.bookingsAreWrittenTo = d.write.name;
    report.timesAreBlockedBy = d.check.map((k) => k.name);
    const tomorrow = cal.addDays(cal.todayIn(c.tz), 2);
    const av = await cal.availability(tomorrow, 3);
    report.openTimesNext3Days = av;
    if (q.write === '1') {
      const date = Object.keys(av).find((k) => av[k].length);
      if (!date) { report.writeTest = 'SKIPPED: no open time in the next few days'; }
      else {
        const time = av[date][av[date].length - 1];
        const r = await cal.reserve({ date, time, summary: 'TEST - Radon Remedies setup check (safe to delete)', location: 'n/a', description: 'Created by the setup check. It deletes itself.', pickup: { ref: 'TEST-' + Date.now(), summary: 'TEST pick-up reminder (safe to delete)', description: 'Created by the setup check. It deletes itself.' } });
        if (r.ok) { await cal.removeBooking(r); report.writeTest = `OK: created and deleted a test visit and pick-up reminder on ${date} at ${time}`; }
        else report.writeTest = 'FAIL: ' + r.reason;
      }
    }
    report.result = 'OK: connected to Apple Calendar';
  } catch (e) {
    report.result = 'FAIL: ' + e.message;
  }
  return reply(200, report);
};
