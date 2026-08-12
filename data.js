// Zero-dependency JSON file "database". Fine for a small team (a handful of
// employees, a few requests a week) — everything fits easily in memory and
// disk I/O is negligible at this scale.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const TYPES = ['vacation', 'sick', 'personal'];

function emptyBalances() {
  const b = {};
  for (const t of TYPES) b[t] = { total_days: 0, used_days: 0 };
  return b;
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
      users: [
        {
          id: 1,
          name: 'Tenielle',
          email: 'leduccitycentrephysio@gmail.com',
          password_hash: hashPassword(defaultPassword),
          role: 'admin',
          hours_per_day: 8,
          balances: emptyBalances(),
          schedule_template: emptyScheduleTemplate(),
          created_at: new Date().toISOString()
        }
      ],
      requests: [],
      scheduleOverrides: [],
      weeklyCheckins: [],
      annualReviews: [],
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
  if (!loaded.nextOverrideId) loaded.nextOverrideId = 1;
  if (!loaded.nextCheckinId) loaded.nextCheckinId = 1;
  if (!loaded.nextReviewId) loaded.nextReviewId = 1;
  if (!loaded.settings) {
    loaded.settings = {
      weeklyQuestions: DEFAULT_WEEKLY_QUESTIONS.slice(),
      annualQuestions: DEFAULT_ANNUAL_QUESTIONS.slice(),
      managerQuestions: DEFAULT_MANAGER_QUESTIONS.slice()
    };
  }
  for (const u of loaded.users) {
    if (!u.schedule_template) u.schedule_template = emptyScheduleTemplate();
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
function createUser({ name, email, password, role, hours_per_day, allotments }) {
  const user = {
    id: db.nextUserId++,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password_hash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'employee',
    hours_per_day: hours_per_day || 8,
    balances: emptyBalances(),
    schedule_template: emptyScheduleTemplate(),
    created_at: new Date().toISOString()
  };
  for (const t of TYPES) {
    if (allotments && allotments[t] != null) user.balances[t].total_days = allotments[t];
  }
  db.users.push(user);
  save();
  return user;
}
function deleteUser(id) {
  db.users = db.users.filter((u) => u.id !== Number(id));
  db.requests = db.requests.filter((r) => r.user_id !== Number(id));
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
    if (totals[t] != null && !isNaN(totals[t])) user.balances[t].total_days = totals[t];
  }
  save();
}

function createRequest({ user_id, type, start_date, end_date, days_count, reason }) {
  const r = {
    id: db.nextRequestId++,
    user_id: Number(user_id),
    type,
    start_date,
    end_date,
    days_count,
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
    if (user) user.balances[r.type].used_days += r.days_count;
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

// Team schedule for a 7-day span starting at weekStartStr (a Monday, "YYYY-MM-DD").
function teamScheduleForWeek(weekStartStr) {
  const start = new Date(weekStartStr + 'T00:00:00');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
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
  hashPassword,
  verifyPassword,
  getUserByEmail,
  getUserById,
  allUsers,
  createUser,
  deleteUser,
  updatePassword,
  updateBalances,
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
  getEffectiveShift,
  teamScheduleForWeek,
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
