// Returns the OPEN arrival times (booked and busy times are simply left out).
//   GET /.netlify/functions/availability?date=YYYY-MM-DD            -> { ok, date, slots: ["8:00 AM", ...] }
//   GET /.netlify/functions/availability?from=YYYY-MM-DD&days=60    -> { ok, days: { "YYYY-MM-DD": [...], ... } }
const cal = require('../lib/caldav');

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
if (process.env.ALLOWED_ORIGIN) H['Access-Control-Allow-Origin'] = process.env.ALLOWED_ORIGIN;
const reply = (statusCode, body) => ({ statusCode, headers: H, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(204, {});
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!cal.configured()) return reply(503, { ok: false, error: 'Scheduling is not set up yet. Please call us.' });
  const q = event.queryStringParameters || {};
  try {
    if (q.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return reply(400, { ok: false, error: 'Invalid date' });
      const out = await cal.availability(q.date, 1);
      return reply(200, { ok: true, date: q.date, slots: out[q.date] || [] });
    }
    const from = q.from || cal.todayIn(cal.cfg().tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return reply(400, { ok: false, error: 'Invalid date' });
    const days = Math.min(Math.max(parseInt(q.days || '14', 10) || 14, 1), 62);
    return reply(200, { ok: true, days: await cal.availability(from, days) });
  } catch (e) {
    console.error('availability failed:', e.message);
    // Fail closed: never show times we could not verify.
    return reply(503, { ok: false, error: 'Could not load open times right now. Please call us to schedule.' });
  }
};
