// Radon Remedies: receives a signed test request and sends
//   1) a confirmation email (with the signed PDF) to the homeowner
//   2) a copy of the signed document + appointment reminder to the owner
//   3) a confirmation text message to the homeowner
//
// Required environment variables (set in Netlify > Site settings > Environment variables):
//   RESEND_API_KEY          API key from resend.com
//   FROM_EMAIL              e.g. "Radon Remedies <appointments@radonremediesutah.com>" (domain must be verified in Resend)
//   OWNER_EMAIL             defaults to carter@radonremediesutah.com
//   TWILIO_ACCOUNT_SID      from twilio.com
//   TWILIO_AUTH_TOKEN
//   ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD (+ more, see netlify/lib/caldav.js): the Apple Calendar that holds bookings
//   TWILIO_FROM             your Twilio phone number in +1XXXXXXXXXX format
//     (or TWILIO_MESSAGING_SERVICE_SID instead of TWILIO_FROM)
// Optional:
//   BUSINESS_PHONE          shown in messages, default 435-328-8555
//   ALLOWED_ORIGIN          only needed if the form is hosted on a different domain than this function

const cal = require('../lib/caldav');

const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '435-328-8555';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'carter@radonremediesutah.com';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function reply(statusCode, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = process.env.ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return { statusCode, headers, body: JSON.stringify(body) };
}

function toE164(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? '+1' + d : null;
}

function longDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function validate(p) {
  const need = ['homeowner', 'address', 'phone', 'email', 'date', 'time', 'ref', 'signedAt', 'pdfBase64'];
  for (const k of need) if (!p[k] || typeof p[k] !== 'string') return 'Missing ' + k;
  if (p.website) return 'Rejected'; // honeypot
  if (p.homeowner.length > 120 || p.address.length > 250 || (p.notes || '').length > 1000) return 'Field too long';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || p.email.length > 200) return 'Invalid email';
  if (!toE164(p.phone)) return 'Invalid phone';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'Invalid date';
  if (!/^\d{1,2}:\d{2} (AM|PM)$/.test(p.time)) return 'Invalid time';
  if (!/^RR-\d{8}-[A-Z0-9]{4}$/.test(p.ref)) return 'Invalid reference';
  if (!p.consents || !p.consents.agree || !p.consents.esign || !p.consents.sms) return 'Consent boxes are required';
  if (!p.pdfBase64.startsWith('JVBER') || p.pdfBase64.length > 4000000) return 'Invalid document';
  return null;
}

function emailShell(inner) {
  return `<div style="font-family:Calibri,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1d2f40">
  <div style="background:#0a2c4a;color:#fff;padding:16px 20px;font-weight:700;letter-spacing:.08em">RADON REMEDIES</div>
  <div style="padding:22px 20px;border:1px solid #d9e2ea;border-top:0">${inner}</div>
  <div style="padding:12px 20px;color:#6b7c8c;font-size:12px">Radon Remedies · ${esc(BUSINESS_PHONE)} · ${esc(OWNER_EMAIL)}</div></div>`;
}

function apptBox(p) {
  return `<div style="background:#eaf4e2;border-radius:10px;padding:14px 16px;margin:16px 0">
    <div style="font-size:12px;letter-spacing:.08em;color:#3f8626;font-weight:700">APPOINTMENT</div>
    <div style="font-size:20px;font-weight:700;color:#0a2c4a">${esc(longDate(p.date))} at ${esc(p.time)}</div>
    <div style="margin-top:4px">${esc(p.address)}</div></div>`;
}

function customerEmail(p) {
  const first = esc(p.homeowner.split(' ')[0]);
  return emailShell(`
    <h2 style="margin:0 0 8px;color:#0a2c4a">You're scheduled for your free radon test</h2>
    <p>Hi ${first}, thank you for signing up. Your signed agreement is attached to this email as a PDF for your records.</p>
    ${apptBox(p)}
    <p style="margin:0 0 6px"><strong>To make sure your results are accurate:</strong></p>
    <ul style="margin:0 0 12px;padding-left:20px">
      <li>Keep windows closed and exterior doors closed (except normal coming and going) starting at least 12 hours before the test and until we pick up the monitor.</li>
      <li>Do not move, unplug, cover or turn off the radon monitor once it is placed.</li>
      <li>If anything happens to the monitor, or you need to change your appointment, call us right away.</li>
    </ul>
    <p>Questions? Call <strong>${esc(BUSINESS_PHONE)}</strong>.</p>
    <p style="color:#6b7c8c;font-size:13px">Request ID: ${esc(p.ref)}</p>`);
}

function ownerEmail(p, meta, booking) {
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7c8c;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`;
  return emailShell(`
    <h2 style="margin:0 0 8px;color:#0a2c4a">New signed radon test request</h2>
    <p style="margin:0">Reminder: you are scheduled to place a monitor for this homeowner.</p>
    ${apptBox(p)}
    <table style="border-collapse:collapse">
      ${row('Homeowner', p.homeowner)}${row('Phone', p.phone)}${row('Email', p.email)}
      ${row('Property', p.address)}${row('Access notes', p.notes || 'None')}
    </table>
    <p>A <strong>pick-up reminder</strong> was added to your Apple Calendar for <strong>${esc(longDate(booking.pickupDate))} at ${esc(p.time)}</strong> (1 hour).</p>
    <p>The signed agreement is attached as a PDF.</p>
    <p style="color:#6b7c8c;font-size:12px;margin-top:16px">Request ID ${esc(p.ref)} · Signed ${esc(p.signedAt)} · Agreement version ${esc(p.agreementVersion || '')}<br>
    IP ${esc(meta.ip)} · ${esc((p.userAgent || '').slice(0, 160))}</p>`);
}

async function sendEmail({ to, subject, html, p, replyTo, extra = [] }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: [to],
      subject,
      html,
      reply_to: replyTo,
      attachments: [{ filename: `Radon-Remedies-Signed-Agreement-${p.ref}.pdf`, content: p.pdfBase64 }].concat(extra),
    }),
  });
  if (!res.ok) throw new Error('Email failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
}

async function sendSms(p) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const params = new URLSearchParams({
    To: toE164(p.phone),
    Body: `Radon Remedies: Hi ${p.homeowner.split(' ')[0]}, your free radon test is set for ${longDate(p.date)} at ${p.time}. Please keep windows and doors closed starting 12 hours before and don't touch the monitor once placed. Questions? ${BUSINESS_PHONE}. Reply STOP to opt out.`,
  });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set('From', process.env.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error('SMS failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(204, {});
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) return reply(500, { ok: false, error: 'Email is not configured.' });
  if (!cal.configured()) return reply(503, { ok: false, error: 'Scheduling is not set up yet. Please call us to book.' });
  if ((event.body || '').length > 5000000) return reply(413, { ok: false, error: 'Request too large.' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, error: 'Bad request.' }); }
  const problem = validate(p);
  if (problem) return reply(400, { ok: false, error: problem });

  const meta = { ip: (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown' };
  const subjectTail = `${longDate(p.date)}, ${p.time}`;
  const safeName = p.homeowner.replace(/[\r\n<>]+/g, ' ').trim();

  // 1) Take the time slot in Apple Calendar first. This is the double-booking guard:
  //    the slot is re-checked and then written with "create only if it does not exist".
  let booking;
  try {
    booking = await cal.reserve({
      date: p.date,
      time: p.time,
      summary: `Radon test: ${safeName}`,
      location: p.address.replace(/[\r\n]+/g, ' '),
      pickup: {
        ref: p.ref,
        summary: `PICK UP radon monitor: ${safeName}`,
        location: p.address.replace(/[\r\n]+/g, ' '),
        description: [`Retrieve the radon monitor from ${safeName}.`, `Phone: ${p.phone}`, `Access notes: ${p.notes || 'None'}`, `Test was placed ${longDate(p.date)} at ${p.time}.`, `Request ID: ${p.ref}`].join('\n'),
      },
      description: [`Homeowner: ${safeName}`, `Phone: ${p.phone}`, `Email: ${p.email}`, `Access notes: ${p.notes || 'None'}`, `Pick up the monitor in 48-72 hours.`, `Request ID: ${p.ref}`, 'Signed agreement was emailed to you.'].join('\n'),
    });
  } catch (e) {
    console.error('Calendar booking failed', e.message);
    return reply(503, { ok: false, error: 'We could not reserve that time right now. Please try again in a minute or call ' + BUSINESS_PHONE + '.' });
  }
  if (!booking.ok) return reply(409, { ok: false, code: 'slot_taken', error: 'Sorry, that time was just booked by someone else. Please choose another time.' });

  // 2) The owner copy must succeed. If it fails, give the time slot back so it is not lost.
  try {
    await sendEmail({ to: OWNER_EMAIL, subject: `New signed radon test: ${safeName}, ${subjectTail}`, html: ownerEmail(p, meta, booking), p, replyTo: p.email });
  } catch (e) {
    console.error('Owner email failed', e.message);
    try { await cal.removeBooking(booking); } catch (e2) { console.error('Could not release slot', e2.message); }
    return reply(502, { ok: false, error: 'Could not deliver the request.' });
  }

  // 3) Customer email (with a calendar invite file) and text. Failures here do not undo the booking.
  const invite = {
    filename: 'Radon-Test-Appointment.ics',
    content_type: 'text/calendar; charset=utf-8; method=PUBLISH',
    content: Buffer.from(cal.buildIcs({ uid: cal.slotKey(p.date, cal.parseLabel(p.time).h, cal.parseLabel(p.time).mi) + '@radonremediesutah.com', startMs: booking.startMs, endMs: booking.endMs, summary: 'Free radon test (Radon Remedies)', location: p.address.replace(/[\r\n]+/g, ' '), description: `Radon Remedies will place a radon monitor and pick it up in 48-72 hours. Questions? ${BUSINESS_PHONE}`, alarms: true, method: 'PUBLISH' })).toString('base64'),
  };
  const [custEmail, sms] = await Promise.allSettled([
    sendEmail({ to: p.email, subject: `Your free radon test: ${subjectTail}`, html: customerEmail(p), p, replyTo: OWNER_EMAIL, extra: [invite] }),
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)
      ? sendSms(p) : Promise.reject(new Error('Twilio not configured')),
  ]);
  if (custEmail.status === 'rejected') console.error(custEmail.reason.message);
  if (sms.status === 'rejected') console.error(sms.reason.message);

  return reply(200, { ok: true, emailSent: custEmail.status === 'fulfilled', smsSent: sms.status === 'fulfilled' });
};
