// Radon Remedies: Apple (iCloud) Calendar access over CalDAV.
//
// Apple Calendar is the single source of truth:
//   * open times = working hours minus anything already on your calendar(s)
//   * a booking = an event written to your calendar, using a name that is unique to
//     that time slot and "If-None-Match: *", so two people can never reserve the same slot
//
// Environment variables:
//   ICLOUD_APPLE_ID          your Apple ID email
//   ICLOUD_APP_PASSWORD      an app-specific password (appleid.apple.com > Sign-In and Security)
//   ICLOUD_CALENDAR_NAME     calendar that receives bookings (default: first event calendar found)
//   ICLOUD_CHECK_CALENDARS   optional, comma list of calendars that block times (default: all event calendars)
//   BUSINESS_TZ              default America/Denver (Utah)
//   SLOT_START_HOUR          first arrival time, 24h clock, default 9 (9 AM)
//   SLOT_END_HOUR            last arrival time, 24h clock, default 16 (4 PM, so the visit ends by 4:45)
//   SLOT_MINUTES             length of one visit, default 45 (leaves 15 minutes of travel before the next hour)
//   PICKUP_DAYS              days after the visit that the pick-up reminder is placed, default 2
//   PICKUP_MINUTES           length of the pick-up reminder, default 60
//   BUFFER_MINUTES           travel padding added around every busy event, default 0
//   OPEN_DAYS                days of week offered, 0=Sun ... 6=Sat, default 1,2,3,4,5,6 (Monday to Saturday)
//   MIN_NOTICE_HOURS         default 24
//   HORIZON_DAYS             how far ahead people can book, default 60
//   ALL_DAY_BLOCKS           "false" to let all-day events NOT block the day (default: they block)
//   CALDAV_URL               default https://caldav.icloud.com (only change for testing)

'use strict';

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

function cfg() {
  const e = process.env;
  return {
    url: (e.CALDAV_URL || 'https://caldav.icloud.com').replace(/\/+$/, '') + '/',
    user: e.ICLOUD_APPLE_ID || '',
    pass: e.ICLOUD_APP_PASSWORD || '',
    writeName: (e.ICLOUD_CALENDAR_NAME || '').trim(),
    checkNames: (e.ICLOUD_CHECK_CALENDARS || '').split(',').map((s) => s.trim()).filter(Boolean),
    tz: e.BUSINESS_TZ || 'America/Denver',
    startHour: num(e.SLOT_START_HOUR, 9),
    endHour: num(e.SLOT_END_HOUR, 16),
    slotMin: num(e.SLOT_MINUTES, 45),
    pickupDays: num(e.PICKUP_DAYS, 2),
    pickupMin: num(e.PICKUP_MINUTES, 60),
    bufferMin: num(e.BUFFER_MINUTES, 0),
    openDays: (e.OPEN_DAYS || '1,2,3,4,5,6').split(',').map((s) => Number(s.trim())).filter((n) => n >= 0 && n <= 6),
    minNoticeH: num(e.MIN_NOTICE_HOURS, 24),
    horizonDays: num(e.HORIZON_DAYS, 60),
    allDayBlocks: String(e.ALL_DAY_BLOCKS || 'true').toLowerCase() !== 'false',
  };
}

const configured = () => { const c = cfg(); return !!(c.user && c.pass); };

// ---------- time zone helpers (no libraries) ----------
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
// wall-clock time in tz -> UTC milliseconds
function zonedToUtc(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(t, tz);
    t -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - want;
  }
  return t;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoDate = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;
function todayIn(tz, nowMs = Date.now()) { const p = tzParts(nowMs, tz); return isoDate(p.y, p.mo, p.d); }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
function weekday(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function label12(h, m) { return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; }
function parseLabel(s) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(String(s || ''));
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3] === 'PM') h += 12;
  return { h, mi: Number(m[2]) };
}
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// ---------- tiny XML helpers (CalDAV responses are simple) ----------
function xmlDecode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function tag(xml, name) {
  const m = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'i').exec(xml || '');
  return m ? m[1] : null;
}
function responses(xml) {
  return (String(xml).match(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/gi) || []);
}

// ---------- HTTP ----------
async function dav(method, url, { body, headers = {}, depth, timeoutMs = 8000 } = {}) {
  const c = cfg();
  const base = new URL(c.url);
  const auth = 'Basic ' + Buffer.from(c.user + ':' + c.pass).toString('base64');
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('Refusing non-HTTPS calendar URL');
    if (u.host !== base.host && !u.hostname.endsWith('.icloud.com')) throw new Error('Refusing to send credentials to ' + u.host);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(target, {
        method,
        redirect: 'manual',
        signal: ctl.signal,
        headers: Object.assign({ Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8' }, depth !== undefined ? { Depth: String(depth) } : {}, headers),
        body,
      });
    } catch (e) {
      throw new Error('Calendar connection failed (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ')');
    } finally { clearTimeout(timer); }
    if ([301, 302, 307, 308].includes(res.status) && res.headers.get('location')) { target = new URL(res.headers.get('location'), target).toString(); continue; }
    return { status: res.status, text: await res.text(), headers: res.headers, url: target };
  }
  throw new Error('Too many calendar redirects');
}

function authFail(r) {
  if (r.status === 401 || r.status === 403) return new Error('Apple rejected the login (check ICLOUD_APPLE_ID and that ICLOUD_APP_PASSWORD is an app-specific password).');
  return null;
}

// ---------- discovery (cached while the function stays warm) ----------
let cache = null;
async function discover(force) {
  const c = cfg();
  const key = [c.url, c.user, c.writeName, c.checkNames.join('|')].join('#');
  if (!force && cache && cache.key === key && Date.now() - cache.at < 10 * 60 * 1000) return cache.val;

  const p1 = await dav('PROPFIND', c.url, { depth: 0, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>' });
  if (authFail(p1)) throw authFail(p1);
  if (p1.status !== 207) throw new Error('Calendar discovery failed (principal, HTTP ' + p1.status + ')');
  const principalHref = tag(tag(p1.text, 'current-user-principal'), 'href');
  if (!principalHref) throw new Error('Calendar discovery failed (no principal)');
  const principal = new URL(xmlDecode(principalHref).trim(), p1.url).toString();

  const p2 = await dav('PROPFIND', principal, { depth: 0, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>' });
  if (authFail(p2)) throw authFail(p2);
  if (p2.status !== 207) throw new Error('Calendar discovery failed (home set, HTTP ' + p2.status + ')');
  const homeHref = tag(tag(p2.text, 'calendar-home-set'), 'href');
  if (!homeHref) throw new Error('Calendar discovery failed (no calendar home)');
  const home = new URL(xmlDecode(homeHref).trim(), p2.url).toString();

  const p3 = await dav('PROPFIND', home, { depth: 1, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>' });
  if (authFail(p3)) throw authFail(p3);
  if (p3.status !== 207) throw new Error('Calendar discovery failed (calendar list, HTTP ' + p3.status + ')');

  const all = [];
  for (const r of responses(p3.text)) {
    const href = tag(r, 'href');
    const rt = tag(r, 'resourcetype') || '';
    if (!href || !/<(?:\w+:)?calendar(?:\s[^>]*)?\/?>/i.test(rt)) continue;
    const comps = [...r.matchAll(/<(?:\w+:)?comp\s+name="([A-Za-z]+)"/g)].map((m) => m[1].toUpperCase());
    if (comps.length && !comps.includes('VEVENT')) continue; // reminders lists etc.
    all.push({ name: xmlDecode(tag(r, 'displayname') || '').trim() || '(unnamed)', url: new URL(xmlDecode(href).trim(), home).toString().replace(/\/?$/, '/') });
  }
  if (!all.length) throw new Error('No event calendars found in this Apple account.');

  let write;
  if (c.writeName) {
    write = all.find((k) => k.name.toLowerCase() === c.writeName.toLowerCase());
    if (!write) throw new Error(`Calendar "${c.writeName}" was not found. Available: ${all.map((k) => k.name).join(', ')}`);
  } else write = all[0];

  let check = all;
  if (c.checkNames.length) {
    check = all.filter((k) => c.checkNames.some((n) => n.toLowerCase() === k.name.toLowerCase()));
    if (!check.length) throw new Error('None of ICLOUD_CHECK_CALENDARS matched. Available: ' + all.map((k) => k.name).join(', '));
  }
  if (!check.some((k) => k.url === write.url)) check = check.concat([write]); // bookings always count as busy

  const val = { calendars: all, write, check };
  cache = { key, at: Date.now(), val };
  return val;
}

// ---------- iCalendar parsing ----------
function parseIcsDate(value, params, tz) {
  const v = String(value).trim();
  if (/^\d{8}$/.test(v)) return { allDay: true, ms: zonedToUtc(+v.slice(0, 4), +v.slice(4, 6), +v.slice(6, 8), 0, 0, tz) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  if (m[7]) return { allDay: false, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  let zone = tz;
  const tzid = /TZID=([^;:]+)/i.exec(params || '');
  if (tzid) { try { new Intl.DateTimeFormat('en-US', { timeZone: tzid[1].replace(/"/g, '') }); zone = tzid[1].replace(/"/g, ''); } catch (e) { zone = tz; } }
  return { allDay: false, ms: zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], zone) };
}
function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}
// returns [{start,end,allDay}] in UTC ms. Cancelled and "free" events are skipped.
function parseBusy(ics, tz, allDayBlocks) {
  const text = String(ics).replace(/\r?\n[ \t]/g, '');
  const out = [];
  for (const block of text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
    const props = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Za-z-]+)((?:;[^:]*)*):(.*)$/.exec(line);
      if (m && !props[m[1].toUpperCase()]) props[m[1].toUpperCase()] = { params: m[2], value: m[3] };
    }
    if (!props.DTSTART) continue;
    if (props.STATUS && /CANCELLED/i.test(props.STATUS.value)) continue;
    if (props.TRANSP && /TRANSPARENT/i.test(props.TRANSP.value)) continue;
    const s = parseIcsDate(props.DTSTART.value, props.DTSTART.params, tz);
    if (!s) continue;
    let e = props.DTEND ? parseIcsDate(props.DTEND.value, props.DTEND.params, tz) : null;
    let endMs;
    if (e) endMs = e.ms;
    else if (props.DURATION && parseDuration(props.DURATION.value) != null) endMs = s.ms + parseDuration(props.DURATION.value);
    else endMs = s.allDay ? s.ms + 86400000 : s.ms;
    if (s.allDay && !allDayBlocks) continue;
    out.push({ start: s.ms, end: Math.max(endMs, s.ms + 60000), allDay: s.allDay });
  }
  return out;
}

async function busyBetween(startMs, endMs) {
  const c = cfg();
  const { check } = await discover();
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${utcStamp(startMs)}" end="${utcStamp(endMs)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(startMs)}" end="${utcStamp(endMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const results = await Promise.all(check.map(async (k) => {
    const r = await dav('REPORT', k.url, { depth: 1, body });
    if (authFail(r)) throw authFail(r);
    if (r.status !== 207) throw new Error(`Could not read calendar "${k.name}" (HTTP ${r.status})`);
    const list = [];
    for (const resp of responses(r.text)) {
      const data = tag(resp, 'calendar-data');
      if (data) list.push(...parseBusy(xmlDecode(data), c.tz, c.allDayBlocks));
    }
    return list;
  }));
  return [].concat(...results);
}

// ---------- availability ----------
// Returns { 'YYYY-MM-DD': ['8:00 AM', ...], ... } for `days` days starting at fromIso. Only OPEN times are listed.
async function availability(fromIso, days, nowMs = Date.now()) {
  const c = cfg();
  const today = todayIn(c.tz, nowMs);
  const lastBookable = addDays(today, c.horizonDays);
  const dates = [];
  for (let i = 0; i < days; i++) { const d = addDays(fromIso, i); if (d >= today && d <= lastBookable) dates.push(d); }
  const result = {};
  if (!dates.length) return result;

  const [fy, fm, fd] = dates[0].split('-').map(Number);
  const [ly, lm, ld] = dates[dates.length - 1].split('-').map(Number);
  const rangeStart = zonedToUtc(fy, fm, fd, 0, 0, c.tz) - c.bufferMin * 60000;
  const rangeEnd = zonedToUtc(ly, lm, ld, 23, 59, c.tz) + 60000 + c.bufferMin * 60000;
  const busy = await busyBetween(rangeStart, rangeEnd);
  const earliest = nowMs + c.minNoticeH * 3600000;
  const buf = c.bufferMin * 60000;

  for (const date of dates) {
    result[date] = [];
    if (!c.openDays.includes(weekday(date))) continue;
    const [y, mo, d] = date.split('-').map(Number);
    for (let h = c.startHour; h <= c.endHour; h++) {
      const s = zonedToUtc(y, mo, d, h, 0, c.tz);
      const e = s + c.slotMin * 60000;
      if (s < earliest) continue;
      if (busy.some((b) => b.start - buf < e && b.end + buf > s)) continue;
      result[date].push(label12(h, 0));
    }
  }
  return result;
}

// ---------- calendar events ----------
function icsEscape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function fold(line) {
  const out = []; let cur = ''; let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 73) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join('\r\n');
}
function buildIcs({ uid, startMs, endMs, summary, location, description, alarms, method }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Radon Remedies//Scheduling//EN', 'CALSCALE:GREGORIAN'];
  if (method) lines.push('METHOD:' + method);
  lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + utcStamp(Date.now()), 'DTSTART:' + utcStamp(startMs), 'DTEND:' + utcStamp(endMs),
    'SUMMARY:' + icsEscape(summary), 'LOCATION:' + icsEscape(location), 'DESCRIPTION:' + icsEscape(description), 'STATUS:CONFIRMED', 'TRANSP:OPAQUE');
  if (alarms) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Radon test in 1 hour', 'TRIGGER:-PT1H', 'END:VALARM');
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Radon test tomorrow', 'TRIGGER:-P1D', 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function slotKey(date, h, mi) { return `radon-${date}-${pad(h)}${pad(mi)}`; }

// Try to take a slot. Resolves {ok:true, href, startMs, endMs} or {ok:false, reason:'unavailable'|'taken'}.
// Throws on calendar/network errors (the caller must treat those as "could not book").
async function reserve({ date, time, summary, location, description, pickup, nowMs = Date.now() }) {
  const c = cfg();
  const t = parseLabel(time);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'unavailable' };
  const open = (await availability(date, 1, nowMs))[date] || [];
  if (!open.includes(label12(t.h, t.mi))) return { ok: false, reason: 'unavailable' };

  const [y, mo, d] = date.split('-').map(Number);
  const startMs = zonedToUtc(y, mo, d, t.h, t.mi, c.tz);
  const endMs = startMs + c.slotMin * 60000;
  const key = slotKey(date, t.h, t.mi);
  const { write } = await discover();
  const href = write.url + key + '.ics';
  const ics = buildIcs({ uid: key + '@radonremediesutah.com', startMs, endMs, summary, location, description, alarms: true });
  const r = await dav('PUT', href, { body: ics, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' } });
  if (authFail(r)) throw authFail(r);
  if (r.status === 412) return { ok: false, reason: 'taken' };
  if (![200, 201, 204].includes(r.status)) throw new Error('Could not write the calendar event (HTTP ' + r.status + ')');
  const out = { ok: true, href, startMs, endMs };

  // Pick-up reminder: same time of day, PICKUP_DAYS later (moved to the next open day if that is a Sunday), PICKUP_MINUTES long. If it cannot be written,
  // undo the visit so you never have a booking without its pick-up reminder.
  if (pickup) {
    try {
      let pd = addDays(date, c.pickupDays);
      for (let i = 0; i < 7 && !c.openDays.includes(weekday(pd)); i++) pd = addDays(pd, 1); // closed day (Sunday) -> next open day (Monday)
      const [py, pm, pdd] = pd.split('-').map(Number);
      const pStart = zonedToUtc(py, pm, pdd, t.h, t.mi, c.tz);
      const pEnd = pStart + c.pickupMin * 60000;
      const pKey = 'radon-pickup-' + String(pickup.ref || key).replace(/[^A-Za-z0-9-]/g, '');
      const pHref = write.url + pKey + '.ics';
      const pIcs = buildIcs({ uid: pKey + '@radonremediesutah.com', startMs: pStart, endMs: pEnd, summary: pickup.summary, location: pickup.location || location, description: pickup.description, alarms: true });
      const pr = await dav('PUT', pHref, { body: pIcs, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' } });
      if (![200, 201, 204].includes(pr.status)) throw new Error('HTTP ' + pr.status);
      Object.assign(out, { pickupHref: pHref, pickupDate: pd, pickupStartMs: pStart, pickupEndMs: pEnd });
    } catch (e) {
      try { await remove(href); } catch (e2) { /* best effort */ }
      throw new Error('Could not write the pick-up reminder (' + e.message + ')');
    }
  }
  return out;
}

async function remove(href) {
  const r = await dav('DELETE', href);
  if (![200, 204, 404].includes(r.status)) throw new Error('Could not remove calendar event (HTTP ' + r.status + ')');
}

async function removeBooking(b) {
  if (b && b.pickupHref) await remove(b.pickupHref);
  if (b && b.href) await remove(b.href);
}

module.exports = { removeBooking, configured, cfg, discover, availability, reserve, remove, buildIcs, parseBusy, parseLabel, label12, zonedToUtc, todayIn, addDays, slotKey, utcStamp };
