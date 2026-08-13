const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');
const { URL } = require('url');

const db = require('./data');
const T = require('./templates');

const PORT = process.env.PORT || 3000;
const TYPES = db.TYPES;

// ---------- in-memory session store ----------
// A single Node process holds these; restarting the server logs everyone
// out, which is an acceptable trade-off for a small internal tool.
const sessions = new Map(); // sid -> { userId, expires }
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 14; // 14 days

function newSession(userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId, expires: Date.now() + SESSION_MAX_AGE });
  return sid;
}
function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return s;
}
function destroySession(sid) {
  sessions.delete(sid);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, sid) {
  const secure = process.env.FORCE_HTTPS_COOKIE === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `sid=${sid}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}; SameSite=Lax${secure}`
  );
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function notFound(res) {
  sendHtml(res, '<h1>404 Not Found</h1>', 404);
}
function forbidden(res) {
  sendHtml(res, '<h1>403 Forbidden</h1>', 403);
}
function csvField(f) {
  const s = String(f == null ? '' : f);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serveStatic(req, res, pathname) {
  const filePath = path.join(__dirname, 'public', pathname.replace('/', ''));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath);
    const types = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Punch-clock summary used by the dashboard: whether they're currently
// clocked in, since when, and hours worked today (closed punches plus, if
// currently clocked in, the running total).
function computePunchStatus(user) {
  const today = new Date().toISOString().slice(0, 10);
  const open = db.getOpenPunch(user.id);
  const closedHoursToday = db.sumClosedPunchHoursForDate(user.id, today);
  if (open) {
    const elapsed = (Date.now() - new Date(open.clock_in).getTime()) / (1000 * 60 * 60);
    return {
      isOpen: true,
      sinceLabel: new Date(open.clock_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      hoursToday: closedHoursToday + elapsed
    };
  }
  return { isOpen: false, sinceLabel: null, hoursToday: closedHoursToday };
}

// ---------- request handler ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (method === 'GET' && pathname === '/style.css') return serveStatic(req, res, pathname);

    const cookies = parseCookies(req);
    const session = getSession(cookies.sid);
    const user = session ? db.getUserById(session.userId) : null;
    if (user) {
      // Keep auto-computed balances current on every page load.
      db.processOvertimeForUser(user.id);
      db.processVacationAccrualForUser(user.id);
    }

    let body = {};
    if (method === 'POST') {
      const raw = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        body = querystring.parse(raw);
      } else if (contentType.includes('application/json')) {
        try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      }
    }

    const requireLogin = () => !!user;
    const requireAdmin = () => !!user && user.role === 'admin';

    // ---- auth ----
    if (method === 'GET' && pathname === '/login') {
      if (user) return redirect(res, '/');
      return sendHtml(res, T.loginPage({ error: null }));
    }
    if (method === 'POST' && pathname === '/login') {
      if (user) return redirect(res, '/');
      const found = db.getUserByEmail(body.email);
      if (!found || !db.verifyPassword(body.password || '', found.password_hash)) {
        return sendHtml(res, T.loginPage({ error: 'Incorrect email or password.' }));
      }
      const sid = newSession(found.id);
      setSessionCookie(res, sid);
      return redirect(res, '/');
    }
    if (method === 'POST' && pathname === '/logout') {
      if (cookies.sid) destroySession(cookies.sid);
      clearSessionCookie(res);
      return redirect(res, '/login');
    }

    if (!requireLogin()) return redirect(res, '/login');

    if (method === 'GET' && pathname === '/') {
      return redirect(res, user.role === 'admin' ? '/admin' : '/dashboard');
    }

    // ---- employee dashboard ----
    if (method === 'GET' && pathname === '/dashboard') {
      const periodStart = db.payPeriodStart(url.searchParams.get('period'));
      const myRequests = db.requestsForUser(user.id);
      return sendHtml(
        res,
        T.dashboardPage({
          user,
          balances: user.balances,
          overtime: user.overtime,
          accruedVacationPay: user.accrued_vacation_pay,
          myRequests,
          types: TYPES,
          requestTypes: db.REQUEST_TYPES,
          punchStatus: computePunchStatus(user),
          scheduleDays: db.scheduleForUserPeriod(user.id, periodStart),
          periodStart,
          periodEndLabel: db.payPeriodEnd(periodStart),
          paydayLabel: db.paydayForPeriod(periodStart),
          error: url.searchParams.get('error'),
          success: url.searchParams.get('success')
        })
      );
    }

    // ---- punch clock ----
    if (method === 'POST' && pathname === '/punch/in') {
      db.punchIn(user.id);
      return redirect(res, '/dashboard');
    }
    if (method === 'POST' && pathname === '/punch/out') {
      db.punchOut(user.id);
      return redirect(res, '/dashboard');
    }

    if (method === 'POST' && pathname === '/requests') {
      const { type, start_date, end_date, reason } = body;
      if (!db.REQUEST_TYPES.includes(type) || !start_date || !end_date) {
        return redirect(res, '/dashboard?error=' + encodeURIComponent('Please fill out all fields.'));
      }
      if (end_date < start_date) {
        return redirect(res, '/dashboard?error=' + encodeURIComponent('End date must be on or after the start date.'));
      }
      const typed = parseFloat(body.hours);
      const explicitHours = !isNaN(typed) && typed > 0 ? typed : null;
      const computedHours = db.calcRequestHours(user.id, start_date, end_date, explicitHours);
      if (computedHours <= 0) {
        return redirect(res, '/dashboard?error=' + encodeURIComponent("Couldn't work out hours for those dates — try entering the hours directly."));
      }
      if (type === 'overtime') {
        const available = user.overtime.banked_hours - user.overtime.used_hours;
        if (computedHours > available) {
          return redirect(res, '/dashboard?error=' + encodeURIComponent(`You only have ${available.toFixed(2)} banked overtime hours available.`));
        }
      } else {
        const b = user.balances[type];
        const available = b.total_hours - b.used_hours;
        if (computedHours > available) {
          return redirect(res, '/dashboard?error=' + encodeURIComponent(`You only have ${available.toFixed(2)} ${type} hours available.`));
        }
      }
      db.createRequest({ user_id: user.id, type, start_date, end_date, hours_count: explicitHours, reason });
      return redirect(res, '/dashboard?success=' + encodeURIComponent('Request submitted for approval.'));
    }

    const cancelMatch = pathname.match(/^\/requests\/(\d+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const r = db.getRequestById(cancelMatch[1]);
      if (!r || r.user_id !== user.id) return notFound(res);
      if (r.status !== 'pending') {
        return redirect(res, '/dashboard?error=' + encodeURIComponent('Only pending requests can be cancelled.'));
      }
      db.deleteRequest(r.id);
      return redirect(res, '/dashboard?success=' + encodeURIComponent('Request cancelled.'));
    }

    // ---- account ----
    if (method === 'GET' && pathname === '/account') {
      return sendHtml(res, T.accountPage({ user, error: null, success: null }));
    }
    if (method === 'POST' && pathname === '/account/password') {
      const { current_password, new_password, confirm_password } = body;
      if (!db.verifyPassword(current_password || '', user.password_hash)) {
        return sendHtml(res, T.accountPage({ user, error: 'Current password is incorrect.', success: null }));
      }
      if (!new_password || new_password.length < 8) {
        return sendHtml(res, T.accountPage({ user, error: 'New password must be at least 8 characters.', success: null }));
      }
      if (new_password !== confirm_password) {
        return sendHtml(res, T.accountPage({ user, error: 'New passwords do not match.', success: null }));
      }
      db.updatePassword(user.id, new_password);
      return sendHtml(res, T.accountPage({ user, error: null, success: 'Password updated.' }));
    }

    // ---- my schedule (employee + admin can both view their own) ----
    if (method === 'GET' && pathname === '/schedule') {
      const periodStart = db.payPeriodStart(url.searchParams.get('period'));
      const days = db.scheduleForUserPeriod(user.id, periodStart);
      return sendHtml(
        res,
        T.mySchedulePage({
          user,
          periodStart,
          periodEndLabel: db.payPeriodEnd(periodStart),
          paydayLabel: db.paydayForPeriod(periodStart),
          days
        })
      );
    }

    // ---- weekly HR check-in ----
    if (method === 'GET' && pathname === '/checkin') {
      const weekStart = db.isoWeekStart();
      const existing = db.getCheckin(user.id, weekStart);
      const settings = db.getSettings();
      return sendHtml(
        res,
        T.checkinPage({
          user,
          weekStart,
          questions: settings.weeklyQuestions,
          existingAnswers: existing ? existing.answers : null,
          pastCheckins: db.checkinsForUser(user.id)
        })
      );
    }
    if (method === 'POST' && pathname === '/checkin') {
      const weekStart = db.isoWeekStart();
      const settings = db.getSettings();
      const answers = settings.weeklyQuestions.map((_, i) => body['q' + i] || '');
      db.upsertCheckin(user.id, weekStart, answers);
      return redirect(res, '/checkin');
    }

    // ---- annual review (employee self-assessment + view manager review) ----
    if (method === 'GET' && pathname === '/review') {
      const year = new Date().getFullYear();
      const settings = db.getSettings();
      const review = db.getReview(user.id, year);
      return sendHtml(
        res,
        T.reviewPage({ user, year, questions: settings.annualQuestions, managerQuestions: settings.managerQuestions, review })
      );
    }
    if (method === 'POST' && pathname === '/review') {
      const year = new Date().getFullYear();
      const settings = db.getSettings();
      const answers = settings.annualQuestions.map((_, i) => body['q' + i] || '');
      db.upsertSelfReview(user.id, year, answers);
      return redirect(res, '/review');
    }

    // ---- calendar ----
    if (method === 'GET' && pathname === '/calendar') {
      return sendHtml(res, T.calendarPage({ user }));
    }
    if (method === 'GET' && pathname === '/api/calendar-events') {
      const events = db.allApprovedRequests().map((r) => {
        const u = db.getUserById(r.user_id);
        return { id: r.id, type: r.type, start_date: r.start_date, end_date: r.end_date, employee_name: u ? u.name : 'Unknown' };
      });
      return sendJson(res, events);
    }

    // ---- admin ----
    if (pathname.startsWith('/admin')) {
      if (!requireAdmin()) return forbidden(res);

      if (method === 'GET' && pathname === '/admin') {
        db.processOvertimeForAllUsers();
        db.processVacationAccrualForAllUsers();
        const pending = db.pendingRequests().map((r) => {
          const u = db.getUserById(r.user_id);
          return { ...r, employee_name: u ? u.name : 'Unknown' };
        });
        const employees = db.allUsers().sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1));
        return sendHtml(
          res,
          T.adminPage({
            user,
            pending,
            employees,
            types: TYPES,
            error: url.searchParams.get('error'),
            success: url.searchParams.get('success')
          })
        );
      }

      const approveMatch = pathname.match(/^\/admin\/requests\/(\d+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const r = db.getRequestById(approveMatch[1]);
        if (!r || r.status !== 'pending') {
          return redirect(res, '/admin?error=' + encodeURIComponent('Request not found or already decided.'));
        }
        db.decideRequest(r.id, 'approved', user.id);
        return redirect(res, '/admin?success=' + encodeURIComponent('Request approved.'));
      }

      const denyMatch = pathname.match(/^\/admin\/requests\/(\d+)\/deny$/);
      if (method === 'POST' && denyMatch) {
        const r = db.getRequestById(denyMatch[1]);
        if (!r || r.status !== 'pending') {
          return redirect(res, '/admin?error=' + encodeURIComponent('Request not found or already decided.'));
        }
        db.decideRequest(r.id, 'denied', user.id);
        return redirect(res, '/admin?success=' + encodeURIComponent('Request denied.'));
      }

      if (method === 'POST' && pathname === '/admin/employees') {
        const {
          name, email, password, role,
          vacation_hours, wellness_hours, personal_hours,
          hours_per_day, overtime_hours,
          hourly_wage, vacation_percent, accrued_vacation_pay
        } = body;
        if (!name || !email || !password) {
          return redirect(res, '/admin?error=' + encodeURIComponent('Name, email, and password are required.'));
        }
        if (db.getUserByEmail(email)) {
          return redirect(res, '/admin?error=' + encodeURIComponent('An account with that email already exists.'));
        }
        db.createUser({
          name,
          email,
          password,
          role,
          hours_per_day: parseFloat(hours_per_day) || 8,
          hourly_wage: parseFloat(hourly_wage) || 0,
          vacation_percent: parseFloat(vacation_percent) || 0,
          accrued_vacation_pay: parseFloat(accrued_vacation_pay) || 0,
          allotments: {
            vacation: parseFloat(vacation_hours) || 0,
            wellness: parseFloat(wellness_hours) || 0,
            personal: parseFloat(personal_hours) || 0
          },
          overtime_hours: parseFloat(overtime_hours) || 0
        });
        return redirect(res, '/admin?success=' + encodeURIComponent('Employee added.'));
      }

      const balMatch = pathname.match(/^\/admin\/employees\/(\d+)\/balances$/);
      if (method === 'POST' && balMatch) {
        const totals = {};
        for (const t of TYPES) {
          const v = parseFloat(body[t]);
          if (!isNaN(v)) totals[t] = v;
        }
        db.updateBalances(balMatch[1], totals);
        if (body.overtime != null) db.updateOvertimeBanked(balMatch[1], parseFloat(body.overtime));
        db.updateWageAndAccrual(balMatch[1], {
          hourly_wage: parseFloat(body.hourly_wage),
          vacation_percent: parseFloat(body.vacation_percent),
          accrued_vacation_pay: parseFloat(body.accrued_vacation_pay)
        });
        return redirect(res, '/admin?success=' + encodeURIComponent('Balances updated.'));
      }

      const delMatch = pathname.match(/^\/admin\/employees\/(\d+)\/delete$/);
      if (method === 'POST' && delMatch) {
        if (Number(delMatch[1]) === user.id) {
          return redirect(res, '/admin?error=' + encodeURIComponent('You cannot delete your own account.'));
        }
        db.deleteUser(delMatch[1]);
        return redirect(res, '/admin?success=' + encodeURIComponent('Employee removed.'));
      }

      // ---- team schedule ----
      if (method === 'GET' && pathname === '/admin/schedule') {
        db.processOvertimeForAllUsers();
        db.processVacationAccrualForAllUsers();
        const periodStart = db.payPeriodStart(url.searchParams.get('period'));
        const rows = db.teamScheduleForPeriod(periodStart);
        return sendHtml(
          res,
          T.teamSchedulePage({
            user,
            periodStart,
            periodEndLabel: db.payPeriodEnd(periodStart),
            paydayLabel: db.paydayForPeriod(periodStart),
            rows,
            error: url.searchParams.get('error'),
            success: url.searchParams.get('success')
          })
        );
      }

      const editScheduleMatch = pathname.match(/^\/admin\/schedule\/(\d+)$/);
      if (method === 'GET' && editScheduleMatch) {
        const emp = db.getUserById(editScheduleMatch[1]);
        if (!emp) return notFound(res);
        const periodStart = db.payPeriodStart(url.searchParams.get('period'));
        const employee = { ...emp, overrides: db.overridesForUser(emp.id) };
        return sendHtml(
          res,
          T.editSchedulePage({
            user,
            employee,
            periodStart,
            periodEndLabel: db.payPeriodEnd(periodStart),
            paydayLabel: db.paydayForPeriod(periodStart),
            periodDays: db.scheduleForUserPeriod(emp.id, periodStart),
            error: url.searchParams.get('error'),
            success: url.searchParams.get('success')
          })
        );
      }

      const templateMatch = pathname.match(/^\/admin\/schedule\/(\d+)\/template$/);
      if (method === 'POST' && templateMatch) {
        const empId = templateMatch[1];
        const template = {};
        for (let i = 0; i < 7; i++) {
          template[String(i)] = { start_time: body['start_' + i], end_time: body['end_' + i] };
        }
        db.updateScheduleTemplate(empId, template);
        return redirect(res, `/admin/schedule/${empId}?success=` + encodeURIComponent('Weekly hours saved.'));
      }

      const copyWeekMatch = pathname.match(/^\/admin\/schedule\/(\d+)\/copy-week$/);
      if (method === 'POST' && copyWeekMatch) {
        const empId = copyWeekMatch[1];
        const periodStart = db.payPeriodStart(url.searchParams.get('period'));
        db.copyWeekForward(empId, periodStart);
        return redirect(res, `/admin/schedule/${empId}?period=${periodStart}&success=` + encodeURIComponent('Week 1 copied to Week 2.'));
      }

      const overrideAddMatch = pathname.match(/^\/admin\/schedule\/(\d+)\/override$/);
      if (method === 'POST' && overrideAddMatch) {
        const empId = overrideAddMatch[1];
        const { date, start_time, end_time, is_off } = body;
        if (!date) {
          return redirect(res, `/admin/schedule/${empId}?error=` + encodeURIComponent('Please choose a date.'));
        }
        if (!is_off && (!start_time || !end_time)) {
          return redirect(res, `/admin/schedule/${empId}?error=` + encodeURIComponent('Set a start/end time, or check "Day off".'));
        }
        db.addOverride({ user_id: empId, date, is_off: !!is_off, start_time, end_time });
        return redirect(res, `/admin/schedule/${empId}?success=` + encodeURIComponent('Change added.'));
      }

      const overrideDelMatch = pathname.match(/^\/admin\/schedule\/(\d+)\/override\/(\d+)\/delete$/);
      if (method === 'POST' && overrideDelMatch) {
        db.deleteOverride(overrideDelMatch[2]);
        return redirect(res, `/admin/schedule/${overrideDelMatch[1]}?success=` + encodeURIComponent('Change removed.'));
      }

      // ---- statutory holidays ----
      if (method === 'GET' && pathname === '/admin/stat-holidays') {
        return sendHtml(
          res,
          T.statHolidaysPage({
            user,
            holidays: db.listStatHolidays(),
            error: url.searchParams.get('error'),
            success: url.searchParams.get('success')
          })
        );
      }
      if (method === 'POST' && pathname === '/admin/stat-holidays') {
        const { date, name } = body;
        if (!date || !name) {
          return redirect(res, '/admin/stat-holidays?error=' + encodeURIComponent('Please enter a date and name.'));
        }
        db.addStatHoliday(date, name);
        return redirect(res, '/admin/stat-holidays?success=' + encodeURIComponent('Holiday added.'));
      }
      const statDelMatch = pathname.match(/^\/admin\/stat-holidays\/(\d+)\/delete$/);
      if (method === 'POST' && statDelMatch) {
        db.deleteStatHoliday(statDelMatch[1]);
        return redirect(res, '/admin/stat-holidays?success=' + encodeURIComponent('Holiday removed.'));
      }
      const statCsvMatch = pathname.match(/^\/admin\/stat-holidays\/(\d+)\/export\.csv$/);
      if (method === 'GET' && statCsvMatch) {
        const holiday = db.listStatHolidays().find((h) => h.id === Number(statCsvMatch[1]));
        if (!holiday) return notFound(res);
        const header = ['Employee Name', 'Employee Email', 'Eligible', 'Regular Workday', 'Hours Worked', 'Average Daily Wage', 'Basis', 'Pay Owed'];
        const csvLines = [header.join(',')];
        for (const u of db.allUsers()) {
          const b = db.computeStatHolidayPay(u.id, holiday.date);
          csvLines.push(
            [
              u.name, u.email, b.eligible ? 'Yes' : 'No',
              b.eligible ? (b.regularWorkday ? 'Yes' : 'No') : '',
              b.eligible ? b.workedHours.toFixed(2) : '',
              b.eligible ? b.averageDailyWage.toFixed(2) : '',
              b.breakdown, (b.pay || 0).toFixed(2)
            ].map(csvField).join(',')
          );
        }
        const csv = csvLines.join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="stat-holiday-${holiday.date}.csv"`
        });
        return res.end(csv);
      }
      const statDetailMatch = pathname.match(/^\/admin\/stat-holidays\/(\d+)$/);
      if (method === 'GET' && statDetailMatch) {
        const holiday = db.listStatHolidays().find((h) => h.id === Number(statDetailMatch[1]));
        if (!holiday) return notFound(res);
        const breakdown = db.allUsers().map((u) => ({ ...db.computeStatHolidayPay(u.id, holiday.date), name: u.name }));
        return sendHtml(res, T.statHolidayDetailPage({ user, holiday, breakdown }));
      }

      // ---- weekly check-ins (admin view) ----
      if (method === 'GET' && pathname === '/admin/checkins') {
        const weekStart = db.isoWeekStart(url.searchParams.get('week'));
        const settings = db.getSettings();
        const checkins = db.checkinsForWeek(weekStart).map((c) => {
          const u = db.getUserById(c.user_id);
          return { ...c, employee_name: u ? u.name : 'Unknown' };
        });
        return sendHtml(res, T.adminCheckinsPage({ user, weekStart, questions: settings.weeklyQuestions, checkins }));
      }

      // ---- annual reviews (admin) ----
      if (method === 'GET' && pathname === '/admin/reviews') {
        const year = parseInt(url.searchParams.get('year'), 10) || new Date().getFullYear();
        const rows = db.allUsers().map((u) => {
          const r = db.getReview(u.id, year);
          return { userId: u.id, name: u.name, self_answers: r ? r.self_answers : null, manager_answers: r ? r.manager_answers : null };
        });
        return sendHtml(res, T.adminReviewsListPage({ user, year, rows }));
      }

      const reviewDetailMatch = pathname.match(/^\/admin\/reviews\/(\d+)$/);
      if (method === 'GET' && reviewDetailMatch) {
        const year = parseInt(url.searchParams.get('year'), 10) || new Date().getFullYear();
        const emp = db.getUserById(reviewDetailMatch[1]);
        if (!emp) return notFound(res);
        const settings = db.getSettings();
        const review = db.getReview(emp.id, year);
        return sendHtml(
          res,
          T.adminReviewDetailPage({
            user,
            employee: emp,
            year,
            questions: settings.annualQuestions,
            managerQuestions: settings.managerQuestions,
            review,
            error: url.searchParams.get('error'),
            success: url.searchParams.get('success')
          })
        );
      }
      if (method === 'POST' && reviewDetailMatch) {
        const year = parseInt(url.searchParams.get('year'), 10) || new Date().getFullYear();
        const settings = db.getSettings();
        const answers = settings.managerQuestions.map((_, i) => body['mq' + i] || '');
        db.upsertManagerReview(reviewDetailMatch[1], year, answers, user.id);
        return redirect(res, `/admin/reviews/${reviewDetailMatch[1]}?year=${year}&success=` + encodeURIComponent('Manager review saved.'));
      }

      // ---- settings (editable question sets) ----
      if (method === 'GET' && pathname === '/admin/settings') {
        const settings = db.getSettings();
        return sendHtml(
          res,
          T.settingsPage({
            user,
            weeklyQuestions: settings.weeklyQuestions,
            annualQuestions: settings.annualQuestions,
            managerQuestions: settings.managerQuestions,
            success: url.searchParams.get('success')
          })
        );
      }
      const settingsMatch = pathname.match(/^\/admin\/settings\/(weekly|annual|manager)$/);
      if (method === 'POST' && settingsMatch) {
        const lines = (body.questions || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const key = { weekly: 'weeklyQuestions', annual: 'annualQuestions', manager: 'managerQuestions' }[settingsMatch[1]];
        if (lines.length > 0) db.updateSettings({ [key]: lines });
        return redirect(res, '/admin/settings?success=' + encodeURIComponent('Questions updated.'));
      }

      // ---- Jane Payroll export ----
      if (method === 'GET' && pathname === '/admin/export') {
        return sendHtml(res, T.exportPage({ user, error: url.searchParams.get('error') }));
      }
      if (method === 'GET' && pathname === '/admin/export.csv') {
        const start_date = url.searchParams.get('start_date');
        const end_date = url.searchParams.get('end_date');
        if (!start_date || !end_date) {
          return redirect(res, '/admin/export?error=' + encodeURIComponent('Please choose a start and end date.'));
        }
        const rows = db.approvedRequestsInRange(start_date, end_date).sort((a, b) => a.start_date.localeCompare(b.start_date));
        const header = ['Employee Name', 'Employee Email', 'Time Off Type', 'Start Date', 'End Date', 'Hours', 'Notes'];
        const csvLines = [header.join(',')];
        for (const r of rows) {
          const u = db.getUserById(r.user_id);
          const fields = [
            u ? u.name : 'Unknown',
            u ? u.email : '',
            T.cap(r.type),
            r.start_date,
            r.end_date,
            (r.hours_count || 0).toFixed(2),
            r.reason || ''
          ].map(csvField);
          csvLines.push(fields.join(','));
        }
        const csv = csvLines.join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="jane-payroll-timeoff-${start_date}_to_${end_date}.csv"`
        });
        return res.end(csv);
      }

      return notFound(res);
    }

    return notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`Time-off tracker running on port ${PORT}`);
});
