function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function money(n) {
  const v = Math.round((n || 0) * 100) / 100;
  return '$' + v.toFixed(2);
}
function fmtNum(n) {
  return (Math.round((n || 0) * 100) / 100).toString();
}

const HEAD = (title) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>`;

function nav(user, active) {
  const link = (href, label) =>
    `<a href="${href}"${active === href ? ' style="text-decoration:underline"' : ''}>${label}</a>`;
  const isAdmin = user.role === 'admin';
  const homeLink = isAdmin ? link('/admin', 'Requests &amp; Team') : link('/dashboard', 'My Dashboard');
  const myDashLink = isAdmin ? link('/dashboard', 'My Dashboard') : '';
  const scheduleLink = isAdmin ? link('/admin/schedule', 'Schedule') : '';
  const checkinLink = isAdmin ? link('/admin/checkins', 'Check-ins') : link('/checkin', 'Weekly Check-in');
  const reviewLink = isAdmin ? link('/admin/reviews', 'Reviews') : link('/review', 'Annual Review');
  const statLink = isAdmin ? link('/admin/stat-holidays', 'Stat Holidays') : '';
  const exportLink = isAdmin ? link('/admin/export', 'Payroll Export') : '';
  const settingsLink = isAdmin ? link('/admin/settings', 'Settings') : '';
  return `<nav>
  <div><span class="brand">Leduc City Centre Physio</span></div>
  <div>
    ${homeLink}
    ${myDashLink}
    ${scheduleLink}
    ${checkinLink}
    ${reviewLink}
    ${statLink}
    ${link('/calendar', 'Team Calendar')}
    ${exportLink}
    ${settingsLink}
    ${link('/account', 'Account')}
    <form method="POST" action="/logout" style="display:inline"><button type="submit" class="linklike">Log out</button></form>
  </div>
</nav>`;
}

function alerts(error, success) {
  let out = '';
  if (error) out += `<div class="alert error">${esc(error)}</div>`;
  if (success) out += `<div class="alert success">${esc(success)}</div>`;
  return out;
}

function loginPage({ error }) {
  return `${HEAD('Log in — Time Off Tracker')}
  <div class="login-wrap">
    <div class="card login-card">
      <h1>Time Off Tracker</h1>
      <p class="subtitle">Leduc City Centre Physio</p>
      ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
      <form method="POST" action="/login">
        <div class="field"><label for="email">Email</label><input type="email" id="email" name="email" required autofocus /></div>
        <div class="field"><label for="password">Password</label><input type="password" id="password" name="password" required /></div>
        <button type="submit" class="btn" style="width:100%">Log in</button>
      </form>
    </div>
  </div>
</body></html>`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function periodNavLinks(baseUrl, periodStart, periodEndLabel, paydayLabel) {
  const start = new Date(periodStart + 'T00:00:00');
  const prev = new Date(start); prev.setDate(prev.getDate() - 14);
  const next = new Date(start); next.setDate(next.getDate() + 14);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return `<div class="cal-nav">
    <a class="btn secondary small" href="${baseUrl}?period=${fmt(prev)}">&larr; Prev period</a>
    <h2 style="margin:0">${esc(periodStart)} – ${esc(periodEndLabel)}</h2>
    <a class="btn secondary small" href="${baseUrl}?period=${fmt(next)}">Next period &rarr;</a>
  </div>
  <p class="pay-period-banner">Payday for this pay period: ${esc(paydayLabel)}</p>`;
}

// Renders a 14-day (two-week) effective schedule as two week-blocks. `days`
// is an array of {date, working, start_time, end_time, timeOffConflict}.
function scheduleWeekBlocks(days) {
  const week1 = days.slice(0, 7);
  const week2 = days.slice(7, 14);
  const block = (weekDays, label) => {
    const rows = weekDays
      .map((d) => {
        const dayName = DAY_NAMES[new Date(d.date + 'T00:00:00').getDay()];
        const hours = d.working ? `${esc(d.start_time)} – ${esc(d.end_time)}` : `<span class="muted">Off</span>`;
        const conflict = d.timeOffConflict
          ? `<span class="badge denied" style="margin-left:0.5rem">Approved time off this day</span>`
          : '';
        return `<tr><td>${dayName}</td><td>${esc(d.date)}</td><td>${hours}${conflict}</td></tr>`;
      })
      .join('');
    return `<div class="week-block"><h3>${label}</h3><table><tbody>${rows}</tbody></table></div>`;
  };
  return block(week1, 'Week 1') + block(week2, 'Week 2');
}

function totalScheduledHours(days) {
  let total = 0;
  for (const d of days) {
    if (!d.working) continue;
    const [sh, sm] = (d.start_time || '0:0').split(':').map(Number);
    const [eh, em] = (d.end_time || '0:0').split(':').map(Number);
    const mins = eh * 60 + em - (sh * 60 + sm);
    if (mins > 0) total += mins / 60;
  }
  return total;
}

function dashboardPage({
  user, balances, overtime, accruedVacationPay, myRequests, types, requestTypes,
  punchStatus, scheduleDays, periodStart, periodEndLabel, paydayLabel, error, success
}) {
  const nonVacationTiles = types
    .filter((t) => t !== 'vacation')
    .map((t) => {
      const b = balances[t];
      const remaining = fmtNum(b.total_hours - b.used_hours);
      return `<div class="balance-tile">
        <div class="type">${esc(t)}</div>
        <div class="amount">${remaining} hrs</div>
        <div class="sub">${fmtNum(b.used_hours)} used of ${fmtNum(b.total_hours)}</div>
      </div>`;
    })
    .join('');

  const vb = balances.vacation;
  const vacationAvailableTile = `<div class="balance-tile">
    <div class="type">vacation (available)</div>
    <div class="amount">${fmtNum(vb.total_hours - vb.used_hours)} hrs</div>
    <div class="sub">${fmtNum(vb.used_hours)} used of ${fmtNum(vb.total_hours)}</div>
  </div>`;
  const vacationAccruedTile = `<div class="balance-tile">
    <div class="type">vacation pay (accrued)</div>
    <div class="amount">${money(accruedVacationPay)}</div>
    <div class="sub">earned to date — separate from your available days above</div>
  </div>`;

  const otRemaining = fmtNum(overtime.banked_hours - overtime.used_hours);
  const overtimeTile = `<div class="balance-tile">
    <div class="type">overtime</div>
    <div class="amount">${otRemaining} hrs</div>
    <div class="sub">${overtime.used_hours} used of ${overtime.banked_hours} banked</div>
  </div>`;

  const typeOptions = requestTypes.map((t) => `<option value="${t}">${cap(t)}</option>`).join('');

  const rows = myRequests
    .map(
      (r) => `<tr>
      <td>${esc(r.type)}</td>
      <td>${esc(r.start_date)} – ${esc(r.end_date)}</td>
      <td>${fmtNum(r.hours_count)} hrs</td>
      <td><span class="badge ${r.status}">${esc(r.status)}</span></td>
      <td>${esc(r.reason)}</td>
      <td>${
        r.status === 'pending'
          ? `<form method="POST" action="/requests/${r.id}/cancel"><button type="submit" class="btn small secondary">Cancel</button></form>`
          : ''
      }</td>
    </tr>`
    )
    .join('');

  const punchCard = punchStatus.isOpen
    ? `<div class="punch-card">
        <div class="punch-status">Punched <span class="state in">in</span> since ${esc(punchStatus.sinceLabel)} · ${fmtNum(punchStatus.hoursToday)} hrs so far today</div>
        <form method="POST" action="/punch/out"><button type="submit" class="btn large punch-out">Punch out</button></form>
      </div>`
    : `<div class="punch-card">
        <div class="punch-status">Currently <span class="state out">punched out</span>${punchStatus.hoursToday ? ` · ${fmtNum(punchStatus.hoursToday)} hrs today so far` : ''}</div>
        <form method="POST" action="/punch/in"><button type="submit" class="btn large">Punch in</button></form>
      </div>`;

  return `${HEAD('My Dashboard')}
  ${nav(user, '/dashboard')}
  <div class="container">
    <h1>Hi ${esc(user.name)}</h1>
    <p class="subtitle">Your schedule, punch clock, and time off — all in one place.</p>
    ${alerts(error, success)}

    <div class="card">
      <h2>Punch clock</h2>
      ${punchCard}
    </div>

    <div class="card">
      <h2>Your shift schedule</h2>
      ${periodNavLinks('/dashboard', periodStart, periodEndLabel, paydayLabel)}
      ${scheduleWeekBlocks(scheduleDays)}
      <p class="muted" style="margin-top:0.75rem">Scheduled this pay period: ${fmtNum(totalScheduledHours(scheduleDays))} hours.</p>
    </div>

    <div class="card">
      <h2>Your time off balances</h2>
      <div class="grid balances-grid">${vacationAvailableTile}${vacationAccruedTile}${nonVacationTiles}${overtimeTile}</div>
      <p class="muted" style="margin-top:0.75rem">Overtime banks automatically: any week you're scheduled over 40 hours, the extra hours are added here.</p>
    </div>

    <div class="card">
      <h2>Request time off</h2>
      <form method="POST" action="/requests" id="requestForm">
        <div class="row">
          <div class="field"><label for="type">Type</label><select id="type" name="type" required>${typeOptions}</select></div>
          <div class="field"><label for="start_date">Start date</label><input type="date" id="start_date" name="start_date" required /></div>
          <div class="field"><label for="end_date">End date</label><input type="date" id="end_date" name="end_date" required /></div>
        </div>
        <div class="field">
          <label for="hours">Hours (optional)</label>
          <input type="number" id="hours" name="hours" step="0.25" min="0.25" />
          <p class="muted">Leave blank to automatically use your normal scheduled hours for these dates.</p>
        </div>
        <div class="field"><label for="reason">Note (optional)</label><textarea id="reason" name="reason" rows="2"></textarea></div>
        <button type="submit" class="btn">Submit request</button>
      </form>
    </div>

    <div class="card">
      <h2>Your requests</h2>
      <table>
        <thead><tr><th>Type</th><th>Dates</th><th>Amount</th><th>Status</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="muted">No requests yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
}

function adminPage({ user, pending, employees, types, error, success }) {
  const pendingRows = pending
    .map(
      (r) => `<tr>
      <td>${esc(r.employee_name)}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.start_date)} – ${esc(r.end_date)}</td>
      <td>${fmtNum(r.hours_count)} hrs</td>
      <td>${esc(r.reason)}</td>
      <td>
        <form method="POST" action="/admin/requests/${r.id}/approve" style="display:inline"><button type="submit" class="btn small">Approve</button></form>
        <form method="POST" action="/admin/requests/${r.id}/deny" style="display:inline"><button type="submit" class="btn small danger">Deny</button></form>
      </td>
    </tr>`
    )
    .join('');

  const empRows = employees
    .map((e) => {
      const b = e.balances;
      const ot = e.overtime;
      return `<tr>
        <td>${esc(e.name)}</td>
        <td>${esc(e.email)}</td>
        <td>${esc(e.role)}</td>
        <td><input type="number" name="vacation" form="balform-${e.id}" value="${fmtNum(b.vacation.total_hours)}" step="0.25" min="0" style="width:65px" /> <span class="muted">(${fmtNum(b.vacation.used_hours)} used)</span></td>
        <td><input type="number" name="wellness" form="balform-${e.id}" value="${fmtNum(b.wellness.total_hours)}" step="0.25" min="0" style="width:65px" /> <span class="muted">(${fmtNum(b.wellness.used_hours)} used)</span></td>
        <td><input type="number" name="personal" form="balform-${e.id}" value="${fmtNum(b.personal.total_hours)}" step="0.25" min="0" style="width:65px" /> <span class="muted">(${fmtNum(b.personal.used_hours)} used)</span></td>
        <td><input type="number" name="overtime" form="balform-${e.id}" value="${ot.banked_hours}" step="0.25" min="0" style="width:65px" /> <span class="muted">(${ot.used_hours} used)</span></td>
        <td><input type="number" name="hourly_wage" form="balform-${e.id}" value="${e.hourly_wage}" step="0.25" min="0" style="width:65px" /></td>
        <td><input type="number" name="vacation_percent" form="balform-${e.id}" value="${e.vacation_percent}" step="0.5" min="0" max="100" style="width:60px" /></td>
        <td><input type="number" name="accrued_vacation_pay" form="balform-${e.id}" value="${e.accrued_vacation_pay}" step="0.01" min="0" style="width:75px" /></td>
        <td>
          <form id="balform-${e.id}" method="POST" action="/admin/employees/${e.id}/balances" style="display:inline"></form>
          <button type="submit" form="balform-${e.id}" class="btn small secondary">Save</button>
          ${
            e.id !== user.id
              ? `<form method="POST" action="/admin/employees/${e.id}/delete" style="display:inline"><button type="submit" class="btn small danger">Remove</button></form>`
              : ''
          }
        </td>
      </tr>`;
    })
    .join('');

  return `${HEAD('Team & Requests')}
  ${nav(user, '/admin')}
  <div class="container">
    <h1>Team & Requests</h1>
    <p class="subtitle">Review requests, manage employees, and keep balances current.</p>
    ${alerts(error, success)}
    <div class="card">
      <h2>Pending requests</h2>
      <table>
        <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Amount</th><th>Note</th><th>Decision</th></tr></thead>
        <tbody>${pendingRows || `<tr><td colspan="6" class="muted">No pending requests.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Add an employee</h2>
      <form method="POST" action="/admin/employees">
        <div class="row">
          <div class="field"><label for="name">Full name</label><input type="text" id="name" name="name" required /></div>
          <div class="field"><label for="email">Email</label><input type="email" id="email" name="email" required /></div>
          <div class="field"><label for="password">Temporary password</label><input type="text" id="password" name="password" required /></div>
        </div>
        <div class="row">
          <div class="field"><label for="role">Role</label><select id="role" name="role"><option value="employee">Employee</option><option value="admin">Admin</option></select></div>
          <div class="field"><label for="hours_per_day">Hours per work day</label><input type="number" id="hours_per_day" name="hours_per_day" value="8" step="0.5" min="1" max="24" /></div>
          <div class="field"><label for="hourly_wage">Hourly wage ($)</label><input type="number" id="hourly_wage" name="hourly_wage" value="0" step="0.25" min="0" /></div>
          <div class="field"><label for="vacation_percent">Vacation accrual %</label><input type="number" id="vacation_percent" name="vacation_percent" value="0" step="0.5" min="0" max="100" /></div>
        </div>
        <p class="muted">Starting balances (in hours) — Jane Payroll tracks vacation/wellness time in hours too:</p>
        <div class="row">
          <div class="field"><label for="vacation_hours">Vacation hours (available)</label><input type="number" id="vacation_hours" name="vacation_hours" value="0" step="0.25" min="0" /></div>
          <div class="field"><label for="wellness_hours">Wellness hours</label><input type="number" id="wellness_hours" name="wellness_hours" value="0" step="0.25" min="0" /></div>
          <div class="field"><label for="personal_hours">Personal hours</label><input type="number" id="personal_hours" name="personal_hours" value="0" step="0.25" min="0" /></div>
          <div class="field"><label for="overtime_hours">Starting banked overtime (hours)</label><input type="number" id="overtime_hours" name="overtime_hours" value="0" step="0.25" min="0" /></div>
          <div class="field"><label for="accrued_vacation_pay">Starting accrued vacation pay ($)</label><input type="number" id="accrued_vacation_pay" name="accrued_vacation_pay" value="0" step="0.01" min="0" /></div>
        </div>
        <button type="submit" class="btn">Add employee</button>
      </form>
    </div>
    <div class="card">
      <h2>Employees</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Vacation (hrs)</th><th>Wellness (hrs)</th><th>Personal (hrs)</th><th>Overtime (hrs)</th><th>Wage ($/hr)</th><th>Vac %</th><th>Accrued vac pay</th><th></th></tr></thead>
        <tbody>${empRows}</tbody>
      </table>
      <p class="muted" style="margin-top:0.75rem">Overtime and accrued vacation pay both update automatically in the background (overtime weekly, vacation pay every pay period) — you can still adjust any of these manually if needed.</p>
    </div>
  </div>
</body></html>`;
}

function calendarPage({ user }) {
  return `${HEAD('Team Calendar')}
  ${nav(user, '/calendar')}
  <div class="container">
    <h1>Team Calendar</h1>
    <p class="subtitle">Approved time off across the whole team.</p>
    <div class="card">
      <div class="cal-nav">
        <button class="btn secondary small" id="prevMonth">&larr; Prev</button>
        <h2 id="monthLabel" style="margin:0"></h2>
        <button class="btn secondary small" id="nextMonth">Next &rarr;</button>
      </div>
      <div id="calendar-grid"></div>
    </div>
  </div>
  <script>
    let current = new Date(); current.setDate(1);
    let events = [];
    function fetchEvents() {
      fetch('/api/calendar-events').then(r => r.json()).then(data => { events = data; render(); });
    }
    function render() {
      const grid = document.getElementById('calendar-grid');
      const label = document.getElementById('monthLabel');
      const year = current.getFullYear(); const month = current.getMonth();
      label.textContent = current.toLocaleString('default', { month: 'long', year: 'numeric' });
      grid.innerHTML = '';
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
        const el = document.createElement('div'); el.className = 'cal-header'; el.textContent = d; grid.appendChild(el);
      });
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div'); empty.className = 'cal-cell'; empty.style.visibility = 'hidden'; grid.appendChild(empty);
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div'); cell.className = 'cal-cell';
        const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const dayNum = document.createElement('div'); dayNum.className = 'daynum'; dayNum.textContent = d; cell.appendChild(dayNum);
        events.filter(e => dateStr >= e.start_date && dateStr <= e.end_date).forEach(e => {
          const ev = document.createElement('div'); ev.className = 'event';
          ev.textContent = e.employee_name + ' (' + e.type + ')'; ev.title = e.employee_name + ' — ' + e.type;
          cell.appendChild(ev);
        });
        grid.appendChild(cell);
      }
    }
    document.getElementById('prevMonth').addEventListener('click', () => { current.setMonth(current.getMonth() - 1); render(); });
    document.getElementById('nextMonth').addEventListener('click', () => { current.setMonth(current.getMonth() + 1); render(); });
    fetchEvents();
  </script>
</body></html>`;
}

function accountPage({ user, error, success }) {
  return `${HEAD('Account')}
  ${nav(user, '/account')}
  <div class="container">
    <h1>Account</h1>
    <p class="subtitle">${esc(user.name)} · ${esc(user.email)}</p>
    ${alerts(error, success)}
    <div class="card">
      <h2>Change password</h2>
      <form method="POST" action="/account/password">
        <div class="field"><label for="current_password">Current password</label><input type="password" id="current_password" name="current_password" required /></div>
        <div class="field"><label for="new_password">New password</label><input type="password" id="new_password" name="new_password" required minlength="8" /></div>
        <div class="field"><label for="confirm_password">Confirm new password</label><input type="password" id="confirm_password" name="confirm_password" required minlength="8" /></div>
        <button type="submit" class="btn">Update password</button>
      </form>
    </div>
  </div>
</body></html>`;
}

function exportPage({ user, error }) {
  return `${HEAD('Payroll Export')}
  ${nav(user, '/admin/export')}
  <div class="container">
    <h1>Payroll Export</h1>
    <p class="subtitle">A pay-period-ready CSV of approved time off, for entering into Jane Payroll.</p>
    ${alerts(error, null)}
    <div class="card">
      <p class="muted">
        Jane Payroll doesn't currently offer a live sync for time off, so approved
        vacation, wellness, and personal time still needs to be keyed into Jane's own
        Time Off policies (Billing &gt; Payroll &gt; Account &gt; Time Off) or
        timesheets when you run payroll. This export lists everything approved
        in a date range, in <strong>hours</strong> (Jane tracks vacation time in
        hours) — so you can copy it in quickly instead of hunting back through
        requests.
      </p>
      <form method="GET" action="/admin/export.csv">
        <div class="row">
          <div class="field"><label for="start_date">Pay period start</label><input type="date" id="start_date" name="start_date" required /></div>
          <div class="field"><label for="end_date">Pay period end</label><input type="date" id="end_date" name="end_date" required /></div>
        </div>
        <button type="submit" class="btn">Download CSV</button>
      </form>
      <p class="muted" style="margin-top:0.75rem">Looking for statutory holiday pay? That's calculated separately under <a href="/admin/stat-holidays">Stat Holidays</a>.</p>
    </div>
  </div>
</body></html>`;
}

// ---------- employee/admin: shift schedule for the current pay period ----------
function mySchedulePage({ user, periodStart, periodEndLabel, paydayLabel, days }) {
  return `${HEAD('My Schedule')}
  ${nav(user, '/schedule')}
  <div class="container">
    <h1>My Schedule</h1>
    <p class="subtitle">Your working hours for this pay period.</p>
    <div class="card">
      ${periodNavLinks('/schedule', periodStart, periodEndLabel, paydayLabel)}
      ${scheduleWeekBlocks(days)}
    </div>
  </div>
</body></html>`;
}

// ---------- admin: team schedule for a pay period ----------
function teamSchedulePage({ user, periodStart, periodEndLabel, paydayLabel, rows, error, success }) {
  const dayHeader = (d) => `<th>${DAY_NAMES[new Date(d.date + 'T00:00:00').getDay()].slice(0, 3)}<br><span class="muted">${esc(d.date.slice(5))}</span></th>`;
  const week1Headers = rows.length ? rows[0].days.slice(0, 7).map(dayHeader).join('') : '';
  const week2Headers = rows.length ? rows[0].days.slice(7, 14).map(dayHeader).join('') : '';

  const cellsFor = (dayList) =>
    dayList
      .map((d) => {
        if (!d.working) return `<td class="muted">Off</td>`;
        const conflictClass = d.timeOffConflict ? 'style="background:var(--danger-bg)"' : '';
        const conflictNote = d.timeOffConflict ? `<br><span class="badge denied">time off</span>` : '';
        return `<td ${conflictClass}>${esc(d.start_time)}-${esc(d.end_time)}${conflictNote}</td>`;
      })
      .join('');

  const week1Rows = rows.map((r) => `<tr><td><a href="/admin/schedule/${r.userId}">${esc(r.name)}</a></td>${cellsFor(r.days.slice(0, 7))}</tr>`).join('');
  const week2Rows = rows.map((r) => `<tr><td><a href="/admin/schedule/${r.userId}">${esc(r.name)}</a></td>${cellsFor(r.days.slice(7, 14))}</tr>`).join('');

  return `${HEAD('Team Schedule')}
  ${nav(user, '/admin/schedule')}
  <div class="container">
    <h1>Team Schedule</h1>
    <p class="subtitle">Click an employee's name to edit their weekly hours, copy a week, or add a one-off change.</p>
    ${alerts(error, success)}
    <div class="card">
      ${periodNavLinks('/admin/schedule', periodStart, periodEndLabel, paydayLabel)}
      <div class="week-block">
        <h3>Week 1</h3>
        <table><thead><tr><th>Employee</th>${week1Headers}</tr></thead><tbody>${week1Rows || `<tr><td colspan="8" class="muted">No employees yet.</td></tr>`}</tbody></table>
      </div>
      <div class="week-block">
        <h3>Week 2</h3>
        <table><thead><tr><th>Employee</th>${week2Headers}</tr></thead><tbody>${week2Rows || `<tr><td colspan="8" class="muted">No employees yet.</td></tr>`}</tbody></table>
      </div>
      <p class="muted" style="margin-top:0.75rem">Cells highlighted in red are scheduled to work but have approved time off that day — worth double-checking.</p>
    </div>
  </div>
</body></html>`;
}

// ---------- admin: edit one employee's schedule ----------
function editSchedulePage({ user, employee, periodStart, periodEndLabel, paydayLabel, periodDays, error, success }) {
  const dayRows = DAY_NAMES
    .map((name, i) => {
      const entry = employee.schedule_template[String(i)];
      return `<div class="row" style="align-items:flex-end">
        <div class="field" style="flex:0 0 110px"><label>${name}</label></div>
        <div class="field"><label for="start_${i}">Start</label><input type="time" id="start_${i}" name="start_${i}" value="${entry ? esc(entry.start_time) : ''}" /></div>
        <div class="field"><label for="end_${i}">End</label><input type="time" id="end_${i}" name="end_${i}" value="${entry ? esc(entry.end_time) : ''}" /></div>
      </div>`;
    })
    .join('');

  const overrideRows = employee.overrides
    .map(
      (o) => `<tr>
        <td>${esc(o.date)}</td>
        <td>${o.is_off ? '<span class="badge denied">Off</span>' : `${esc(o.start_time)} – ${esc(o.end_time)}`}</td>
        <td><form method="POST" action="/admin/schedule/${employee.id}/override/${o.id}/delete"><button type="submit" class="btn small danger">Remove</button></form></td>
      </tr>`
    )
    .join('');

  return `${HEAD('Edit Schedule — ' + employee.name)}
  ${nav(user, '/admin/schedule')}
  <div class="container">
    <h1>${esc(employee.name)}'s Schedule</h1>
    <p class="subtitle"><a href="/admin/schedule">&larr; Back to team schedule</a></p>
    ${alerts(error, success)}
    <div class="card">
      <h2>This pay period</h2>
      ${periodNavLinks(`/admin/schedule/${employee.id}`, periodStart, periodEndLabel, paydayLabel)}
      ${scheduleWeekBlocks(periodDays)}
      <form method="POST" action="/admin/schedule/${employee.id}/copy-week?period=${periodStart}" style="margin-top:0.75rem">
        <button type="submit" class="btn secondary">Copy Week 1 to Week 2</button>
        <p class="muted">Takes this period's Week 1 hours and applies them to Week 2 as one-off changes, without touching the recurring weekly pattern below.</p>
      </form>
    </div>
    <div class="card">
      <h2>Weekly hours (recurring pattern)</h2>
      <p class="muted">Leave both times blank for a day off. This repeats every week unless overridden by a one-off change or a copied week below.</p>
      <form method="POST" action="/admin/schedule/${employee.id}/template">
        ${dayRows}
        <button type="submit" class="btn">Save weekly hours</button>
      </form>
    </div>
    <div class="card">
      <h2>One-off changes</h2>
      <p class="muted">For a specific date only — e.g. a holiday closure or a swapped shift. Overrides the weekly hours above for that date.</p>
      <form method="POST" action="/admin/schedule/${employee.id}/override">
        <div class="row" style="align-items:flex-end">
          <div class="field"><label for="date">Date</label><input type="date" id="date" name="date" required /></div>
          <div class="field"><label for="ov_start">Start</label><input type="time" id="ov_start" name="start_time" /></div>
          <div class="field"><label for="ov_end">End</label><input type="time" id="ov_end" name="end_time" /></div>
          <div class="field" style="flex:0 0 auto"><label><input type="checkbox" name="is_off" value="1" style="width:auto;display:inline-block" /> Day off</label></div>
        </div>
        <button type="submit" class="btn secondary">Add change</button>
      </form>
      <table style="margin-top:1rem">
        <thead><tr><th>Date</th><th>Hours</th><th></th></tr></thead>
        <tbody>${overrideRows || `<tr><td colspan="3" class="muted">No one-off changes.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
}

// ---------- admin: statutory holidays ----------
function statHolidaysPage({ user, holidays, error, success }) {
  const rows = holidays
    .map(
      (h) => `<tr>
      <td>${esc(h.date)}</td>
      <td>${esc(h.name)}</td>
      <td><a class="btn small secondary" href="/admin/stat-holidays/${h.id}">View pay breakdown</a></td>
      <td><form method="POST" action="/admin/stat-holidays/${h.id}/delete"><button type="submit" class="btn small danger">Remove</button></form></td>
    </tr>`
    )
    .join('');
  return `${HEAD('Stat Holidays')}
  ${nav(user, '/admin/stat-holidays')}
  <div class="container">
    <h1>Statutory Holidays</h1>
    <p class="subtitle">Alberta's 2026 general holidays are pre-loaded. Who's off vs. working each one is controlled from each employee's Schedule page (one-off changes) — this page just calculates what's owed.</p>
    ${alerts(error, success)}
    <div class="card">
      <h2>Add a holiday</h2>
      <form method="POST" action="/admin/stat-holidays">
        <div class="row" style="align-items:flex-end">
          <div class="field"><label for="date">Date</label><input type="date" id="date" name="date" required /></div>
          <div class="field"><label for="name">Name</label><input type="text" id="name" name="name" placeholder="e.g. Easter Monday" required /></div>
        </div>
        <button type="submit" class="btn secondary">Add</button>
      </form>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Name</th><th></th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">No holidays yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
}

function statHolidayDetailPage({ user, holiday, breakdown }) {
  const rows = breakdown
    .map((b) => {
      if (!b.eligible) {
        return `<tr><td>${esc(b.name)}</td><td colspan="4" class="muted">${esc(b.breakdown)}</td><td>${money(0)}</td></tr>`;
      }
      return `<tr>
        <td>${esc(b.name)}</td>
        <td>${b.regularWorkday ? 'Yes' : 'No'}</td>
        <td>${fmtNum(b.workedHours)} hrs</td>
        <td>${money(b.averageDailyWage)}</td>
        <td>${esc(b.breakdown)}</td>
        <td><strong>${money(b.pay)}</strong></td>
      </tr>`;
    })
    .join('');
  const total = breakdown.reduce((sum, b) => sum + (b.pay || 0), 0);
  return `${HEAD(holiday.name + ' — Stat Pay')}
  ${nav(user, '/admin/stat-holidays')}
  <div class="container">
    <h1>${esc(holiday.name)} — ${esc(holiday.date)}</h1>
    <p class="subtitle"><a href="/admin/stat-holidays">&larr; Back to Stat Holidays</a></p>
    <div class="card">
      <p class="muted">Calculated per Alberta employment standards: average daily wage = total wages over the 4 weeks before the holiday ÷ days worked in that window. Eligibility requires 30+ workdays in the past 12 months.</p>
      <table>
        <thead><tr><th>Employee</th><th>Regular workday?</th><th>Hours worked</th><th>Avg daily wage</th><th>Basis</th><th>Pay owed</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="muted">No employees yet.</td></tr>`}</tbody>
      </table>
      <p style="margin-top:0.75rem"><strong>Total: ${money(total)}</strong></p>
      <a class="btn secondary" style="margin-top:0.5rem" href="/admin/stat-holidays/${holiday.id}/export.csv">Download CSV</a>
    </div>
  </div>
</body></html>`;
}

// ---------- employee: weekly HR check-in ----------
function checkinPage({ user, weekStart, questions, existingAnswers, pastCheckins }) {
  const fields = questions
    .map((q, i) => {
      const val = existingAnswers ? esc(existingAnswers[i] || '') : '';
      return `<div class="field"><label for="q${i}">${esc(q)}</label><textarea id="q${i}" name="q${i}" rows="2">${val}</textarea></div>`;
    })
    .join('');
  const pastRows = pastCheckins
    .map((c) => `<tr><td>${esc(c.week_start)}</td><td>${new Date(c.submitted_at).toLocaleDateString()}</td></tr>`)
    .join('');
  return `${HEAD('Weekly Check-in')}
  ${nav(user, '/checkin')}
  <div class="container">
    <h1>Weekly Check-in</h1>
    <p class="subtitle">For the week of ${esc(weekStart)} — used to prep our weekly meeting.</p>
    <div class="card">
      <form method="POST" action="/checkin">
        ${fields}
        <button type="submit" class="btn">${existingAnswers ? 'Update answers' : 'Submit'}</button>
      </form>
    </div>
    <div class="card">
      <h2>Past check-ins</h2>
      <table>
        <thead><tr><th>Week of</th><th>Submitted</th></tr></thead>
        <tbody>${pastRows || `<tr><td colspan="2" class="muted">None yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
}

// ---------- admin: weekly check-ins for a chosen week ----------
function adminCheckinsPage({ user, weekStart, questions, checkins }) {
  const blocks = checkins
    .map((c) => {
      const answers = questions
        .map((q, i) => `<p><strong>${esc(q)}</strong><br>${esc(c.answers[i] || '(no answer)')}</p>`)
        .join('');
      return `<div class="card"><h2>${esc(c.employee_name)}</h2>${answers}<p class="muted">Submitted ${new Date(c.submitted_at).toLocaleString()}</p></div>`;
    })
    .join('');
  return `${HEAD('Weekly Check-ins')}
  ${nav(user, '/admin/checkins')}
  <div class="container">
    <h1>Weekly Check-ins</h1>
    <p class="subtitle">Everyone's answers for the selected week — handy for meeting prep.</p>
    <div class="card">
      <form method="GET" action="/admin/checkins">
        <div class="row" style="align-items:flex-end">
          <div class="field"><label for="week">Week of (any date in that week)</label><input type="date" id="week" name="week" value="${esc(weekStart)}" /></div>
          <div class="field" style="flex:0 0 auto"><button type="submit" class="btn secondary">Go</button></div>
        </div>
      </form>
    </div>
    ${blocks || `<div class="card muted">No check-ins submitted for this week yet.</div>`}
  </div>
</body></html>`;
}

// ---------- employee: annual review ----------
function reviewPage({ user, year, questions, managerQuestions, review }) {
  const selfAnswers = review && review.self_answers ? review.self_answers : [];
  const selfFields = questions
    .map((q, i) => `<div class="field"><label for="q${i}">${esc(q)}</label><textarea id="q${i}" name="q${i}" rows="3">${esc(selfAnswers[i] || '')}</textarea></div>`)
    .join('');

  let managerSection = '';
  if (review && review.manager_answers) {
    const mBlocks = managerQuestions
      .map((q, i) => `<p><strong>${esc(q)}</strong><br>${esc(review.manager_answers[i] || '(no answer)')}</p>`)
      .join('');
    managerSection = `<div class="card"><h2>Manager review</h2>${mBlocks}<p class="muted">Shared ${new Date(review.manager_submitted_at).toLocaleDateString()}</p></div>`;
  } else {
    managerSection = `<div class="card"><h2>Manager review</h2><p class="muted">Not shared yet.</p></div>`;
  }

  return `${HEAD('Annual Review — ' + year)}
  ${nav(user, '/review')}
  <div class="container">
    <h1>Annual Review — ${year}</h1>
    <p class="subtitle">Your self-assessment, plus your manager's review once it's shared.</p>
    <div class="card">
      <h2>Your self-assessment</h2>
      <form method="POST" action="/review">
        ${selfFields}
        <button type="submit" class="btn">${review && review.self_answers ? 'Update my answers' : 'Submit'}</button>
      </form>
    </div>
    ${managerSection}
  </div>
</body></html>`;
}

// ---------- admin: review list for a year ----------
function adminReviewsListPage({ user, year, rows }) {
  const body = rows
    .map(
      (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td><span class="badge ${r.self_answers ? 'approved' : 'pending'}">${r.self_answers ? 'Submitted' : 'Not yet'}</span></td>
      <td><span class="badge ${r.manager_answers ? 'approved' : 'pending'}">${r.manager_answers ? 'Submitted' : 'Not yet'}</span></td>
      <td><a class="btn small secondary" href="/admin/reviews/${r.userId}?year=${year}">Open</a></td>
    </tr>`
    )
    .join('');
  const prevYear = year - 1;
  const nextYear = year + 1;
  return `${HEAD('Annual Reviews')}
  ${nav(user, '/admin/reviews')}
  <div class="container">
    <h1>Annual Reviews — ${year}</h1>
    <p class="subtitle">
      <a href="/admin/reviews?year=${prevYear}">&larr; ${prevYear}</a> &nbsp;|&nbsp;
      <a href="/admin/reviews?year=${nextYear}">${nextYear} &rarr;</a>
    </p>
    <div class="card">
      <table>
        <thead><tr><th>Employee</th><th>Self-assessment</th><th>Manager review</th><th></th></tr></thead>
        <tbody>${body || `<tr><td colspan="4" class="muted">No employees yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
}

// ---------- admin: review detail (view self, fill manager) ----------
function adminReviewDetailPage({ user, employee, year, questions, managerQuestions, review, error, success }) {
  const selfAnswers = review && review.self_answers ? review.self_answers : null;
  const selfBlock = selfAnswers
    ? questions.map((q, i) => `<p><strong>${esc(q)}</strong><br>${esc(selfAnswers[i] || '(no answer)')}</p>`).join('')
    : `<p class="muted">Not submitted yet.</p>`;

  const managerAnswers = review && review.manager_answers ? review.manager_answers : [];
  const managerFields = managerQuestions
    .map((q, i) => `<div class="field"><label for="mq${i}">${esc(q)}</label><textarea id="mq${i}" name="mq${i}" rows="3">${esc(managerAnswers[i] || '')}</textarea></div>`)
    .join('');

  return `${HEAD('Review — ' + employee.name)}
  ${nav(user, '/admin/reviews')}
  <div class="container">
    <h1>${esc(employee.name)} — ${year} Review</h1>
    <p class="subtitle"><a href="/admin/reviews?year=${year}">&larr; Back to all reviews</a></p>
    ${alerts(error, success)}
    <div class="card">
      <h2>Employee self-assessment</h2>
      ${selfBlock}
    </div>
    <div class="card">
      <h2>Manager review</h2>
      <p class="muted">Visible to the employee once you save it here.</p>
      <form method="POST" action="/admin/reviews/${employee.id}?year=${year}">
        ${managerFields}
        <button type="submit" class="btn">${review && review.manager_answers ? 'Update manager review' : 'Save manager review'}</button>
      </form>
    </div>
  </div>
</body></html>`;
}

// ---------- admin: settings (editable question sets) ----------
function settingsPage({ user, weeklyQuestions, annualQuestions, managerQuestions, success }) {
  return `${HEAD('Settings')}
  ${nav(user, '/admin/settings')}
  <div class="container">
    <h1>Settings</h1>
    <p class="subtitle">Edit the questions used for weekly check-ins and annual reviews. One question per line.</p>
    ${alerts(null, success)}
    <div class="card">
      <h2>Weekly check-in questions</h2>
      <form method="POST" action="/admin/settings/weekly">
        <textarea name="questions" rows="5">${esc(weeklyQuestions.join('\n'))}</textarea>
        <button type="submit" class="btn" style="margin-top:0.75rem">Save</button>
      </form>
    </div>
    <div class="card">
      <h2>Annual self-assessment questions</h2>
      <form method="POST" action="/admin/settings/annual">
        <textarea name="questions" rows="5">${esc(annualQuestions.join('\n'))}</textarea>
        <button type="submit" class="btn" style="margin-top:0.75rem">Save</button>
      </form>
    </div>
    <div class="card">
      <h2>Manager review questions</h2>
      <form method="POST" action="/admin/settings/manager">
        <textarea name="questions" rows="5">${esc(managerQuestions.join('\n'))}</textarea>
        <button type="submit" class="btn" style="margin-top:0.75rem">Save</button>
      </form>
    </div>
  </div>
</body></html>`;
}

module.exports = {
  esc,
  cap,
  money,
  loginPage,
  dashboardPage,
  adminPage,
  calendarPage,
  accountPage,
  exportPage,
  mySchedulePage,
  teamSchedulePage,
  editSchedulePage,
  statHolidaysPage,
  statHolidayDetailPage,
  checkinPage,
  adminCheckinsPage,
  reviewPage,
  adminReviewsListPage,
  adminReviewDetailPage,
  settingsPage
};
