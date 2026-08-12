// Zero-dependency JSON file "database". Fine for a small team (a handful of
// employees, a few requests a week) — everything fits easily in memory and
// disk I/O is negligible at this scale.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const TYPES = ['vacation', 'wellness', 'personal']; // day-based, admin-settable balances
const REQUEST_TYPES = TYPES.concat(['overtime']); // everything an employee can submit a request for
const WEEKLY_OVERTIME_THRESHOLD_HOURS = 40;
const PAY_PERIOD_ANCHOR = '2026-08-02'; // a known biweekly pay period start (Sunday) — payday 2026-08-21

// Alberta's official 2026 general (statutory) holidays — admin can add/edit/remove.
const DEFAULT_STAT_HOLIDAYS = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-16', name: 'Alberta Family Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-18', name: 'Victoria Day' },
  { date: '2026-07-01', name: 'Canada Day' },
  { date: '2026-09-07', name: 'Labour Day' },
  { date: '2026-10-12', name: 'Thanksgiving Day' },
  { date: '2026-11-11', name: 'Remembrance Day' },
  { date: '2026-12-25', name: 'Christmas Day' }
];

function emptyBalances() {
  // Vacation/wellness/personal are all tracked in HOURS, same as overtime —
  // employees don't enter specific shift times when requesting time off, the
  // app calculates hours from their normal schedule for the requested dates.
  const b = {};
  for (const t of TYPES) b[t] = { total_hours: 0, used_hours: 0 };
  return b;
}
function emptyOvertimeBalance() {
  return { banked_hours: 0, used_hours: 0 };
}
function hoursBetween(startTime, endTime) {
  const [sh, sm] = (startTime || '0:0').split(':').map(Number);
  const [eh, em] = (endTime || '0:0').split(':').map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? mins / 60 : 0;
}
function addDaysToDateStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysCountInclusive(start_date, end_date) {
  const s = new Date(start_date + 'T00:00:00');
  const e = new Date(end_date + 'T00:00:00');
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch (e) {
    return false;
  }
}

const DEFAULT_WEEKLY_QUESTIONS = [
  'What did you get done this week?',
  'Anything blocking you or that you need help with?',
  'How are you feeling about your workload (overloaded / okay / could take more)?',
  "Anything you'd like to raise at this week's meeting?"
];
const DEFAULT_ANNUAL_QUESTIONS = [
  'What were your key accomplishments this year?',
  'What goals do you have for the next year?',
  'What support or resources would help you grow?',
  'Any feedback for the clinic or management?'
];
const DEFAULT_MANAGER_QUESTIONS = [
  'Overall performance summary',
  'Strengths observed this year',
  'Areas for growth',
  "Goals for next year (manager's perspective)"
];

function emptyScheduleTemplate() {
  // keyed by day-of-week string '0' (Sun) .. '6' (Sat); null = not scheduled to work
  const t = {};
  for (let i = 0; i < 7; i++) t[String(i)] = null;
  return t;
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const defaultPassword = 'changeme123';
    const initial = {
      nextUserId: 2,
      nextRequestId: 1,
      nextOverrideId: 1,
      nextCheckinId: 1,
      nextReviewId: 1,
      nextPunchId: 1,
      nextStatHolidayId: DEFAULT_STAT_HOLIDAYS.length + 1,
      users: [
        {
          id: 1,
          name: 'Tenielle',
          email: 'leduccitycentrephysio@gmail.com',
          password_hash: hashPassword(defaultPassword),
          role: 'admin',
          hours_per_day: 8,
          hourly_wage: 0,
          vacation_percent: 0,
          accrued_vacation_pay: 0,
          vacation_accrual_processed_through: null,
          balances: emptyBalances(),
          overtime: emptyOvertimeBalance(),
          overtime_processed_through: null,
          schedule_template: emptyScheduleTemplate(),
          created_at: new Date().toISOString()
        }
      ],
      requests: [],
      scheduleOverrides: [],
      weeklyCheckins: [],
      annualReviews: [],
      punches: [],
      statHolidays: DEFAULT_STAT_HOLIDAYS.map((h, i) => ({ id: i + 1, date: h.date, name: h.name })),
      settings: {
        weeklyQuestions: DEFAULT_WEEKLY_QUESTIONS.slice(),
        annualQuestions: DEFAULT_ANNUAL_QUESTIONS.slice(),
        managerQuestions: DEFAULT_MANAGER_QUESTIONS.slice()
      }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    console.log('----------------------------------------------------');
    console.log('Seeded default admin account:');
    console.log('  email:    leduccitycentrephysio@gmail.com');
    console.log(`  password: ${defaultPassword}`);
    console.log('  Please log in and change this password immediately.');
    console.log('----------------------------------------------------');
  }
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // Fill in defaults for anything missing, so upgrading an existing db.json
  // (from before these features existed) doesn't crash.
  if (!loaded.scheduleOverrides) loaded.scheduleOverrides = [];
  if (!loaded.weeklyCheckins) loaded.weeklyCheckins = [];
  if (!loaded.annualReviews) loaded.annualReviews = [];
  if (!loaded.punches) loaded.punches = [];
  if (!loaded.statHolidays) loaded.statHolidays = DEFAULT_STAT_HOLIDAYS.map((h, i) => ({ id: i + 1, date: h.date, name: h.name }));
  if (!loaded.nextOverrideId) loaded.nextOverrideId = 1;
  if (!loaded.nextCheckinId) loaded.nextCheckinId = 1;
  if (!loaded.nextReviewId) loaded.nextReviewId = 1;
  if (!loaded.nextPunchId) loaded.nextPunchId = 1;
  if (!loaded.nextStatHolidayId) loaded.nextStatHolidayId = loaded.statHolidays.length + 1;
  if (!loaded.settings) {
    loaded.settings = {
      weeklyQuestions: DEFAULT_WEEKLY_QUESTIONS.slice(),
      annualQuestions: DEFAULT_ANNUAL_QUESTIONS.slice(),
      managerQuestions: DEFAULT_MANAGER_QUESTIONS.slice()
    };
  }
  let renamedSick = false;
  for (const u of loaded.users) {
    if (!u.schedule_template) u.schedule_template = emptyScheduleTemplate();
    if (!u.overtime) u.overtime = emptyOvertimeBalance();
    if (u.overtime_processed_through === undefined) u.overtime_processed_through = null;
    if (u.hourly_wage == null) u.hourly_wage = 0;
    if (u.vacation_percent == null) u.vacation_percent = 0;
    if (u.accrued_vacation_pay == null) u.accrued_vacation_pay = 0;
    if (u.vacation_accrual_processed_through === undefined) u.vacation_accrual_processed_through = null;
    // one-time migration: balances.sick -> balances.wellness
    if (u.balances && u.balances.sick && !u.balances.wellness) {
      u.balances.wellness = u.balances.sick;
      delete u.balances.sick;
      renamedSick = true;
    }
    if (!u.balances) u.balances = emptyBalances();
    for (const t of TYPES) {
      if (!u.balances[t]) u.balances[t] = { total_hours: 0, used_hours: 0 };
      // one-time migration: day-based balances -> hour-based (old total_days/used_days)
      if (u.balances[t].total_hours == null && u.balances[t].total_days != null) {
        const hpd = u.hours_per_day || 8;
        u.balances[t].total_hours = u.balances[t].total_days * hpd;
        u.balances[t].used_hours = (u.balances[t].used_days || 0) * hpd;
        delete u.balances[t].total_days;
        delete u.balances[t].used_days;
        renamedSick = true;
      }
    }
  }
  for (const r of loaded.requests) {
    if (r.type === 'sick') {
      r.type = 'wellness';
      renamedSick = true;
    }
    // one-time migration: day-based requests -> hour-based (old days_count)
    if (r.hours_count == null && r.days_count != null) {
      const u = loaded.users.find((x) => x.id === r.user_id);
      const hpd = (u && u.hours_per_day) || 8;
      r.hours_count = r.days_count * hpd;
      delete r.days_count;
      renamedSick = true;
    }
  }
  if (renamedSick) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(loaded, null, 2));
  }
  return loaded;
}

let db = load();

function save() {
  // Write to a temp file then rename, so a crash mid-write can't corrupt the file.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function getUserByEmail(email) {
  return db.users.find((u) => u.email === String(email || '').trim().toLowerCase());
}
function getUserById(id) {
  return db.users.find((u) => u.id === Number(id));
}
function allUsers() {
  return db.users.slice();
}
function createUser({ name, email, password, role, hours_per_day, allotments, overtime_hours, hourly_wage, vacation_percent, accrued_vacation_pay }) {
  const user = {
    id: db.nextUserId++,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password_hash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'employee',
    hours_per_day: hours_per_day || 8,
    hourly_wage: hourly_wage || 0,
    vacation_percent: vacation_percent || 0,
    accrued_vacation_pay: accrued_vacation_pay || 0,
    vacation_accrual_processed_through: null,
    balances: emptyBalances(),
    overtime: emptyOvertimeBalance(),
    overtime_processed_through: null, // set on first processOvertimeForUser() call — no retroactive backfill
    schedule_template: emptyScheduleTemplate(),
    created_at: new Date().toISOString()
  };
  for (const t of TYPES) {
    if (allotments && allotments[t] != null) user.balances[t].total_hours = allotments[t];
  }
  if (overtime_hours != null && !isNaN(overtime_hours)) user.overtime.banked_hours = overtime_hours;
  db.users.push(user);
  save();
  return user;
}
function deleteUser(id) {
  db.users = db.users.filter((u) => u.id !== Number(id));
  db.requests = db.requests.filter((r) => r.user_id !== Number(id));
  db.punches = db.punches.filter((p) => p.user_id !== Number(id));
  save();
}
function updatePassword(id, newPassword) {
  const user = getUserById(id);
  if (!user) return;
  user.password_hash = hashPassword(newPassword);
  save();
}
function updateBalances(id, totals) {
  const user = getUserById(id);
  if (!user) return;
  for (const t of TYPES) {
    if (totals[t] != null && !isNaN(totals[t])) user.balances[t].total_hours = totals[t];
  }
  save();
}
function updateOvertimeBanked(id, bankedHours) {
  const user = getUserById(id);
  if (!user) return;
  if (bankedHours != null && !isNaN(bankedHours)) user.overtime.banked_hours = bankedHours;
  save();
}
function updateWageAndAccrual(id, { hourly_wage, vacation_percent, accrued_vacation_pay }) {
  const user = getUserById(id);
  if (!user) return;
  if (hourly_wage != null && !isNaN(hourly_wage)) user.hourly_wage = hourly_wage;
  if (vacation_percent != null && !isNaN(vacation_percent)) user.vacation_percent = vacation_percent;
  if (accrued_vacation_pay != null && !isNaN(accrued_vacation_pay)) user.accrued_vacation_pay = accrued_vacation_pay;
  save();
}

// Every request type (vacation/wellness/personal/overtime) is tracked in
// hours, not days, and employees never enter specific shift times for time
// off — if they don't type an exact hours figure, it's calculated
// automatically from their normal schedule for the requested date range
// (falling back to hours_per_day x days if nothing's scheduled on those
// dates, e.g. an employee with no weekly template set yet).
function calcRequestHours(user_id, start_date, end_date, hours_count) {
  if (hours_count != null && hours_count !== '' && !isNaN(hours_count)) return Number(hours_count);
  const scheduled = computeScheduledHoursInRange(user_id, start_date, end_date);
  if (scheduled > 0) return scheduled;
  const user = getUserById(user_id);
  return daysCountInclusive(start_date, end_date) * ((user && user.hours_per_day) || 8);
}
function createRequest({ user_id, type, start_date, end_date, hours_count, reason }) {
  const r = {
    id: db.nextRequestId++,
    user_id: Number(user_id),
    type,
    start_date,
    end_date,
    hours_count: calcRequestHours(user_id, start_date, end_date, hours_count),
    reason: reason || '',
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_by: null,
    decided_at: null
  };
  db.requests.push(r);
  save();
  return r;
}
function getRequestById(id) {
  return db.requests.find((r) => r.id === Number(id));
}
function requestsForUser(user_id) {
  return db.requests
    .filter((r) => r.user_id === Number(user_id))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
function pendingRequests() {
  return db.requests
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
function approvedRequestsInRange(start_date, end_date) {
  return db.requests.filter(
    (r) => r.status === 'approved' && r.start_date <= end_date && r.end_date >= start_date
  );
}
function allApprovedRequests() {
  return db.requests.filter((r) => r.status === 'approved');
}
function deleteRequest(id) {
  db.requests = db.requests.filter((r) => r.id !== Number(id));
  save();
}
function decideRequest(id, status, decidedBy) {
  const r = getRequestById(id);
  if (!r) return null;
  r.status = status;
  r.decided_by = decidedBy;
  r.decided_at = new Date().toISOString();
  if (status === 'approved') {
    const user = getUserById(r.user_id);
    if (user) {
      const hours = r.hours_count || 0;
      if (r.type === 'overtime') {
        user.overtime.used_hours += hours;
      } else {
        user.balances[r.type].used_hours += hours;
      }
    }
  }
  save();
  return r;
}

// ---------- helpers shared by schedule/time-off conflict checks ----------
function isApprovedTimeOff(user_id, dateStr) {
  return db.requests.some(
    (r) => r.user_id === Number(user_id) && r.status === 'approved' && r.start_date <= dateStr && r.end_date >= dateStr
  );
}

// ---------- weekly shift template ----------
function updateScheduleTemplate(user_id, template) {
  const user = getUserById(user_id);
  if (!user) return;
  const next = emptyScheduleTemplate();
  for (let i = 0; i < 7; i++) {
    const entry = template[String(i)];
    if (entry && entry.start_time && entry.end_time) {
      next[String(i)] = { start_time: entry.start_time, end_time: entry.end_time };
    }
  }
  user.schedule_template = next;
  save();
}

// ---------- date-specific overrides (holidays, one-off changes) ----------
function addOverride({ user_id, date, is_off, start_time, end_time }) {
  // Replace any existing override for this user+date rather than stacking duplicates.
  db.scheduleOverrides = db.scheduleOverrides.filter((o) => !(o.user_id === Number(user_id) && o.date === date));
  const o = {
    id: db.nextOverrideId++,
    user_id: Number(user_id),
    date,
    is_off: !!is_off,
    start_time: is_off ? null : start_time,
    end_time: is_off ? null : end_time
  };
  db.scheduleOverrides.push(o);
  save();
  return o;
}
function deleteOverride(id) {
  db.scheduleOverrides = db.scheduleOverrides.filter((o) => o.id !== Number(id));
  save();
}
function overridesForUser(user_id) {
  return db.scheduleOverrides
    .filter((o) => o.user_id === Number(user_id))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function overrideForUserDate(user_id, date) {
  return db.scheduleOverrides.find((o) => o.user_id === Number(user_id) && o.date === date);
}

// Copy one user's effective schedule (template + overrides) from a source
// week onto the following week as explicit overrides, so that destination
// week can then be tweaked independently without touching the base template.
function copyWeekForward(user_id, sourceWeekStartStr) {
  for (let i = 0; i < 7; i++) {
    const sourceDate = addDaysToDateStr(sourceWeekStartStr, i);
    const destDate = addDaysToDateStr(sourceWeekStartStr, i + 7);
    const shift = getEffectiveShift(user_id, sourceDate);
    if (shift.working) {
      addOverride({ user_id, date: destDate, is_off: false, start_time: shift.start_time, end_time: shift.end_time });
    } else {
      addOverride({ user_id, date: destDate, is_off: true });
    }
  }
}

// Effective shift for a user on a given date: override wins, else weekly template.
function getEffectiveShift(user_id, dateStr) {
  const override = overrideForUserDate(user_id, dateStr);
  if (override) {
    if (override.is_off) return { working: false, source: 'override' };
    return { working: true, start_time: override.start_time, end_time: override.end_time, source: 'override' };
  }
  const user = getUserById(user_id);
  if (!user) return { working: false, source: 'none' };
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const entry = user.schedule_template[String(dow)];
  if (!entry) return { working: false, source: 'template' };
  return { working: true, start_time: entry.start_time, end_time: entry.end_time, source: 'template' };
}

// Team schedule for a 14-day pay period starting at periodStartStr (a Sunday).
function teamScheduleForPeriod(periodStartStr) {
  const days = [];
  for (let i = 0; i < 14; i++) days.push(addDaysToDateStr(periodStartStr, i));
  return allUsers().map((u) => ({
    userId: u.id,
    name: u.name,
    days: days.map((dateStr) => {
      const shift = getEffectiveShift(u.id, dateStr);
      const timeOff = isApprovedTimeOff(u.id, dateStr);
      return { date: dateStr, ...shift, timeOffConflict: timeOff && shift.working };
    })
  }));
}

// ---------- punch clock ----------
function getOpenPunch(user_id) {
  return db.punches.find((p) => p.user_id === Number(user_id) && !p.clock_out);
}
function punchIn(user_id) {
  if (getOpenPunch(user_id)) return null; // already punched in
  const now = new Date().toISOString();
  const p = { id: db.nextPunchId++, user_id: Number(user_id), date: now.slice(0, 10), clock_in: now, clock_out: null };
  db.punches.push(p);
  save();
  return p;
}
function punchOut(user_id) {
  const p = getOpenPunch(user_id);
  if (!p) return null;
  p.clock_out = new Date().toISOString();
  save();
  return p;
}
function punchesForUserOnDate(user_id, dateStr) {
  return db.punches.filter((p) => p.user_id === Number(user_id) && p.date === dateStr);
}
function sumClosedPunchHoursForDate(user_id, dateStr) {
  let total = 0;
  for (const p of punchesForUserOnDate(user_id, dateStr)) {
    if (p.clock_out) total += (new Date(p.clock_out) - new Date(p.clock_in)) / (1000 * 60 * 60);
  }
  return total;
}

// Hours to count for a given date: prefer actual punched hours; if none were
// recorded, fall back to scheduled hours (so nothing breaks if someone
// forgets to punch). Days covered by approved time off never count.
function hoursCountedForDate(user_id, dateStr) {
  const user = getUserById(user_id);
  // Never count a date before the employee existed — otherwise a recurring
  // weekly template (which applies to any date, past or future, once set)
  // would make a brand-new hire look like they'd worked every matching
  // weekday going back through history, inflating stat-pay eligibility,
  // average daily wage, overtime, and vacation accrual alike.
  if (user && user.created_at && dateStr < user.created_at.slice(0, 10)) return 0;
  if (isApprovedTimeOff(user_id, dateStr)) return 0;
  const punched = sumClosedPunchHoursForDate(user_id, dateStr);
  if (punched > 0) return punched;
  const shift = getEffectiveShift(user_id, dateStr);
  return shift.working ? hoursBetween(shift.start_time, shift.end_time) : 0;
}

// ---------- payroll weeks / pay periods (Sun–Sat, biweekly, anchored) ----------
function payrollWeekStart(dateStr) {
  const d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday
  return d.toISOString().slice(0, 10);
}
function payPeriodStart(dateStr) {
  const weekStart = payrollWeekStart(dateStr);
  const anchor = new Date(PAY_PERIOD_ANCHOR + 'T00:00:00');
  const cur = new Date(weekStart + 'T00:00:00');
  const diffWeeks = Math.round((cur - anchor) / (7 * 86400000));
  const parity = ((diffWeeks % 2) + 2) % 2; // normalize negative mod
  cur.setDate(cur.getDate() - parity * 7);
  return cur.toISOString().slice(0, 10);
}
function payPeriodEnd(periodStartStr) {
  return addDaysToDateStr(periodStartStr, 13);
}
// Payday for the pay period starting 2026-08-02 (ending 2026-08-15) is
// 2026-08-21 — 6 days after the period ends, i.e. 19 days after it starts.
// That offset is constant for every biweekly period since they're all the
// same fixed length.
function paydayForPeriod(periodStartStr) {
  return addDaysToDateStr(periodStartStr, 19);
}

// A single employee's effective 14-day schedule for a pay period — same
// shape as one row of teamScheduleForPeriod(), used by the employee
// dashboard, "My Schedule", and the admin edit-schedule page.
function scheduleForUserPeriod(user_id, periodStartStr) {
  const days = [];
  for (let i = 0; i < 14; i++) days.push(addDaysToDateStr(periodStartStr, i));
  return days.map((dateStr) => {
    const shift = getEffectiveShift(user_id, dateStr);
    const timeOff = isApprovedTimeOff(user_id, dateStr);
    return { date: dateStr, ...shift, timeOffConflict: timeOff && shift.working };
  });
}

function computeWorkedHoursForWeek(user_id, weekStartStr) {
  let total = 0;
  for (let i = 0; i < 7; i++) total += hoursCountedForDate(user_id, addDaysToDateStr(weekStartStr, i));
  return total;
}

// Bank overtime for any fully-completed payroll week(s) since this user was
// last processed. Only weeks that have entirely passed are counted, and
// nothing before overtime_processed_through is ever backfilled — that
// marker is set to "now" the first time this runs for a user, so switching
// this on doesn't create a surprise lump sum from prior history.
function processOvertimeForUser(user_id) {
  const user = getUserById(user_id);
  if (!user) return;
  const currentWeekStart = payrollWeekStart();
  if (!user.overtime_processed_through) {
    user.overtime_processed_through = currentWeekStart;
    save();
    return;
  }
  let cursor = addDaysToDateStr(user.overtime_processed_through, 7);
  let changed = false;
  while (cursor < currentWeekStart) {
    const workedHours = computeWorkedHoursForWeek(user.id, cursor);
    if (workedHours > WEEKLY_OVERTIME_THRESHOLD_HOURS) {
      user.overtime.banked_hours += workedHours - WEEKLY_OVERTIME_THRESHOLD_HOURS;
    }
    user.overtime_processed_through = cursor;
    cursor = addDaysToDateStr(cursor, 7);
    changed = true;
  }
  if (changed) save();
}
function processOvertimeForAllUsers() {
  for (const u of db.users) processOvertimeForUser(u.id);
}

// Bank vacation pay (dollars, separate from the day-based "available"
// vacation balance) for any fully-completed pay period since this user was
// last processed: accrued = hours worked in the period × hourly wage ×
// vacation %. Same no-backfill-on-first-run behavior as overtime.
function processVacationAccrualForUser(user_id) {
  const user = getUserById(user_id);
  if (!user) return;
  const currentPeriodStart = payPeriodStart();
  if (!user.vacation_accrual_processed_through) {
    user.vacation_accrual_processed_through = currentPeriodStart;
    save();
    return;
  }
  let cursor = addDaysToDateStr(user.vacation_accrual_processed_through, 14);
  let changed = false;
  while (cursor < currentPeriodStart) {
    let periodWages = 0;
    for (let i = 0; i < 14; i++) {
      periodWages += hoursCountedForDate(user.id, addDaysToDateStr(cursor, i)) * (user.hourly_wage || 0);
    }
    user.accrued_vacation_pay += periodWages * ((user.vacation_percent || 0) / 100);
    user.vacation_accrual_processed_through = cursor;
    cursor = addDaysToDateStr(cursor, 14);
    changed = true;
  }
  if (changed) save();
}
function processVacationAccrualForAllUsers() {
  for (const u of db.users) processVacationAccrualForUser(u.id);
}

// Sum of an employee's normally-scheduled hours across a date range
// (regardless of time-off conflicts) — used as the default amount deducted
// when an overtime request doesn't specify an explicit hours figure.
function computeScheduledHoursInRange(user_id, start_date, end_date) {
  let total = 0;
  let cursor = start_date;
  while (cursor <= end_date) {
    const shift = getEffectiveShift(user_id, cursor);
    if (shift.working) total += hoursBetween(shift.start_time, shift.end_time);
    cursor = addDaysToDateStr(cursor, 1);
  }
  return total;
}

// ---------- statutory holiday pay (Alberta rules) ----------
function listStatHolidays() {
  return db.statHolidays.slice().sort((a, b) => a.date.localeCompare(b.date));
}
function addStatHoliday(date, name) {
  const h = { id: db.nextStatHolidayId++, date, name: name || 'Stat holiday' };
  db.statHolidays.push(h);
  save();
  return h;
}
function deleteStatHoliday(id) {
  db.statHolidays = db.statHolidays.filter((h) => h.id !== Number(id));
  save();
}
function averageDailyWage(user_id, windowEndExclusiveDate) {
  // Alberta rule: total wages earned over the 4 weeks immediately before the
  // holiday, divided by the number of days actually worked in that window.
  const user = getUserById(user_id);
  const start = addDaysToDateStr(windowEndExclusiveDate, -28);
  const end = addDaysToDateStr(windowEndExclusiveDate, -1);
  let totalWages = 0;
  let daysWorked = 0;
  let cursor = start;
  while (cursor <= end) {
    const hours = hoursCountedForDate(user_id, cursor);
    if (hours > 0) {
      totalWages += hours * (user.hourly_wage || 0);
      daysWorked++;
    }
    cursor = addDaysToDateStr(cursor, 1);
  }
  return daysWorked > 0 ? totalWages / daysWorked : 0;
}
function computeStatHolidayPay(user_id, holidayDate) {
  const user = getUserById(user_id);
  if (!user) return null;
  const start = addDaysToDateStr(holidayDate, -365);
  const end = addDaysToDateStr(holidayDate, -1);
  let daysWorkedPastYear = 0;
  let cursor = start;
  while (cursor <= end) {
    if (hoursCountedForDate(user_id, cursor) > 0) daysWorkedPastYear++;
    cursor = addDaysToDateStr(cursor, 1);
  }
  const eligible = daysWorkedPastYear >= 30;
  if (!eligible) {
    return { eligible: false, pay: 0, breakdown: `Not eligible — only ${daysWorkedPastYear} workdays in the past 12 months (30 required).` };
  }

  const dow = new Date(holidayDate + 'T00:00:00').getDay();
  const regularWorkday = !!user.schedule_template[String(dow)]; // per base template, ignoring one-off overrides
  const effective = getEffectiveShift(user_id, holidayDate); // override-aware — did they actually work it?
  const workedHours = effective.working ? hoursBetween(effective.start_time, effective.end_time) : 0;
  const adw = averageDailyWage(user_id, holidayDate);

  let pay = 0;
  let breakdown;
  if (regularWorkday && workedHours === 0) {
    pay = adw;
    breakdown = 'Regular workday, not worked: average daily wage';
  } else if (regularWorkday && workedHours > 0) {
    pay = workedHours * (user.hourly_wage || 0) * 1.5 + adw;
    breakdown = '1.5x wages for hours worked + average daily wage';
  } else if (!regularWorkday && workedHours > 0) {
    pay = workedHours * (user.hourly_wage || 0) * 1.5;
    breakdown = 'Not a regular workday, worked: 1.5x wages only';
  } else {
    pay = 0;
    breakdown = 'Not a regular workday, not worked: no holiday pay owed';
  }
  return { eligible: true, pay, breakdown, averageDailyWage: adw, workedHours, regularWorkday };
}

// ---------- weekly HR check-ins ----------
function getSettings() {
  return db.settings;
}
function updateSettings(partial) {
  Object.assign(db.settings, partial);
  save();
}
function isoWeekStart(dateStr) {
  const d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function upsertCheckin(user_id, week_start, answers) {
  let c = db.weeklyCheckins.find((c) => c.user_id === Number(user_id) && c.week_start === week_start);
  if (c) {
    c.answers = answers;
    c.submitted_at = new Date().toISOString();
  } else {
    c = {
      id: db.nextCheckinId++,
      user_id: Number(user_id),
      week_start,
      answers,
      submitted_at: new Date().toISOString()
    };
    db.weeklyCheckins.push(c);
  }
  save();
  return c;
}
function getCheckin(user_id, week_start) {
  return db.weeklyCheckins.find((c) => c.user_id === Number(user_id) && c.week_start === week_start);
}
function checkinsForUser(user_id) {
  return db.weeklyCheckins
    .filter((c) => c.user_id === Number(user_id))
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}
function checkinsForWeek(week_start) {
  return db.weeklyCheckins.filter((c) => c.week_start === week_start);
}

// ---------- annual reviews (self-assessment + manager review) ----------
function getReview(user_id, year) {
  return db.annualReviews.find((r) => r.user_id === Number(user_id) && r.year === Number(year));
}
function upsertSelfReview(user_id, year, answers) {
  let r = getReview(user_id, year);
  if (!r) {
    r = {
      id: db.nextReviewId++,
      user_id: Number(user_id),
      year: Number(year),
      self_answers: null,
      self_submitted_at: null,
      manager_answers: null,
      manager_submitted_at: null,
      manager_id: null
    };
    db.annualReviews.push(r);
  }
  r.self_answers = answers;
  r.self_submitted_at = new Date().toISOString();
  save();
  return r;
}
function upsertManagerReview(user_id, year, answers, manager_id) {
  let r = getReview(user_id, year);
  if (!r) {
    r = {
      id: db.nextReviewId++,
      user_id: Number(user_id),
      year: Number(year),
      self_answers: null,
      self_submitted_at: null,
      manager_answers: null,
      manager_submitted_at: null,
      manager_id: null
    };
    db.annualReviews.push(r);
  }
  r.manager_answers = answers;
  r.manager_submitted_at = new Date().toISOString();
  r.manager_id = Number(manager_id);
  save();
  return r;
}
function reviewsForYear(year) {
  return db.annualReviews.filter((r) => r.year === Number(year));
}

module.exports = {
  TYPES,
  REQUEST_TYPES,
  WEEKLY_OVERTIME_THRESHOLD_HOURS,
  PAY_PERIOD_ANCHOR,
  hashPassword,
  verifyPassword,
  getUserByEmail,
  getUserById,
  allUsers,
  createUser,
  deleteUser,
  updatePassword,
  updateBalances,
  updateOvertimeBanked,
  updateWageAndAccrual,
  createRequest,
  getRequestById,
  requestsForUser,
  pendingRequests,
  approvedRequestsInRange,
  allApprovedRequests,
  deleteRequest,
  decideRequest,
  isApprovedTimeOff,
  updateScheduleTemplate,
  addOverride,
  deleteOverride,
  overridesForUser,
  overrideForUserDate,
  copyWeekForward,
  getEffectiveShift,
  teamScheduleForPeriod,
  scheduleForUserPeriod,
  getOpenPunch,
  punchIn,
  punchOut,
  punchesForUserOnDate,
  sumClosedPunchHoursForDate,
  hoursCountedForDate,
  payrollWeekStart,
  payPeriodStart,
  payPeriodEnd,
  paydayForPeriod,
  computeWorkedHoursForWeek,
  computeScheduledHoursInRange,
  calcRequestHours,
  processOvertimeForUser,
  processOvertimeForAllUsers,
  processVacationAccrualForUser,
  processVacationAccrualForAllUsers,
  listStatHolidays,
  addStatHoliday,
  deleteStatHoliday,
  averageDailyWage,
  computeStatHolidayPay,
  getSettings,
  updateSettings,
  isoWeekStart,
  upsertCheckin,
  getCheckin,
  checkinsForUser,
  checkinsForWeek,
  getReview,
  upsertSelfReview,
  upsertManagerReview,
  reviewsForYear
};
