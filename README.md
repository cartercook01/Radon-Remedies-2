# Radon Remedies free-test signup form (with Apple Calendar scheduling)

Files
- `index.html`: the form (logo, open-time picker, agreement, checkboxes, drawn signature). One file.
- `netlify/functions/availability.js`: reads your Apple Calendar and returns only the OPEN times.
- `netlify/functions/submit.js`: reserves the time in your Apple Calendar, then sends the emails and the text.
- `netlify/functions/calendar-check.js`: a private setup check that shows whether the Apple connection works.
- `netlify/lib/caldav.js`: the Apple Calendar (iCloud CalDAV) code.
- `netlify.toml`: tells Netlify where the functions are.

## How the calendar works
- Your Apple Calendar is the only schedule. Nothing is stored anywhere else.
- When a customer picks a date, the page asks the function for open times. Open = working hours (Monday to Saturday, arrival times 9 AM through 4 PM) minus anything on your calendars. Each visit is a 45-minute event, so you have 15 minutes of travel before the next hour. Personal events on your calendars block times too, and booked times simply do not appear.
- Times less than 24 hours away, and dates more than 60 days away, are not offered.
- When the customer signs and submits, the function checks the time one more time and writes a "Radon test: Name" event (address, phone, email, notes, 1-day and 1-hour alerts) into your calendar. A second event, "PICK UP radon monitor: Name", is added 2 days later at the same time of day for 1 hour (a Friday visit moves it to Monday instead of Sunday), with their address and phone. That hour is blocked for new customers too. Apple Calendar on your iPhone and Mac shows it within a minute or so.
- Two people cannot get the same time. If someone grabs it first, the customer is sent back to pick another time, and nothing is emailed.
- If your email to yourself fails, both calendar events are removed so the time is not lost. If the pick-up reminder cannot be written, the visit is not booked either.
- If the calendar cannot be reached, the site shows no times and asks people to call (it never guesses).
- The customer's confirmation email also includes an "Add to calendar" file (.ics).
- If you move or delete an event in Apple Calendar, the site follows automatically. Tip: to cancel a customer, delete BOTH of their events (the visit and the pick-up) and the times open back up.

## Setup (about 30 minutes, plus Twilio registration time)

1. **Check the settings** at the top of the script in `index.html` (`CONFIG`): phone number, closed-house hours, equipment amount.
2. **Apple app-specific password.** Go to appleid.apple.com, sign in, open Sign-In and Security, then App-Specific Passwords, and create one named "Radon website". Copy it (looks like `abcd-efgh-ijkl-mnop`). Your Apple ID needs two-factor authentication on (it normally is). Never use your real Apple ID password here.
3. **Pick your calendar.** In Apple Calendar, make a calendar for jobs (for example "Radon Remedies"), or use an existing one. Use the exact name in step 6. Events on all your calendars block times unless you limit it (see Optional settings).
4. **Email: Resend (resend.com).** Create an account, add and verify `radonremediesutah.com` (a few DNS records), create an API key.
5. **Text: Twilio (twilio.com).** Buy a local number. US carriers require business registration (A2P 10DLC) before texts are delivered reliably; approval can take days.
6. **Host on Netlify (netlify.com).** Put this folder in a GitHub repo and connect it, or use the Netlify CLI (`netlify deploy --prod`). Plain drag-and-drop does not run functions.
7. **Add environment variables** in Netlify (Site settings > Environment variables):
   - `ICLOUD_APPLE_ID` = your Apple ID email
   - `ICLOUD_APP_PASSWORD` = the app-specific password from step 2
   - `ICLOUD_CALENDAR_NAME` = the calendar that receives bookings (exact name)
   - `RESEND_API_KEY`, `FROM_EMAIL` = `Radon Remedies <appointments@radonremediesutah.com>`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (like `+14355551234`)
   - `DIAG_KEY` = any long random text (only for the setup check; delete it afterward)
   - optional: `OWNER_EMAIL` (default carter@radonremediesutah.com), `BUSINESS_PHONE`
8. **Run the setup check** after deploying. Open
   `https://YOUR-SITE/.netlify/functions/calendar-check?key=YOUR_DIAG_KEY&write=1`
   You should see `"result": "OK: connected to Apple Calendar"`, your calendar names, some open times, and `writeTest: OK`. (The test briefly creates and deletes one event on your calendar.) If it says FAIL, the message tells you what to fix.
9. **Test for real** with your own email and phone: book a time, confirm both events show on your iPhone, then reload the form and confirm that time is gone. Delete the two test events to reopen the times.

## Optional settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `BUSINESS_TZ` | America/Denver | your time zone |
| `SLOT_START_HOUR` / `SLOT_END_HOUR` | 9 / 16 | first and last arrival time (24-hour clock) |
| `SLOT_MINUTES` | 45 | how long one visit blocks |
| `PICKUP_DAYS` / `PICKUP_MINUTES` | 2 / 60 | when the pick-up reminder lands and how long it is |
| `BUFFER_MINUTES` | 0 | travel padding added around every event |
| `OPEN_DAYS` | 1,2,3,4,5,6 | days offered, 0 = Sunday ... 6 = Saturday |
| `MIN_NOTICE_HOURS` | 24 | how soon someone can book |
| `HORIZON_DAYS` | 60 | how far ahead (also set `horizonDays` in `CONFIG` in index.html to match) |
| `ICLOUD_CHECK_CALENDARS` | all | comma list of calendars that block times |
| `ALL_DAY_BLOCKS` | true | set `false` if all-day events (birthdays, etc.) should NOT block the day |

## Notes
- Not tested against a live iCloud account (it was tested against a simulated Apple server). Step 8 is how you confirm the real connection.
- If you change your Apple ID password, Apple revokes app-specific passwords: create a new one and update Netlify.
- If you host the form on a different domain than the functions, set `endpoint` and `availabilityEndpoint` in `CONFIG` to the full URLs and set `ALLOWED_ORIGIN` in Netlify to the form's domain.
- Opening `index.html` straight from your computer works for previewing, but no times will load and submitting will fail because there are no functions.
- Have an attorney review the agreement text (the `AGREEMENT` section of `index.html`) before real use.
