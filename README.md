# Team App — Leduc City Centre Physio

A small, self-contained web app covering:

- **Time off** — employees request it (in hours), you approve/deny it, everyone sees a shared calendar.
- **Punch clock** — a punch in/out button on the employee dashboard, used as the source of "hours worked" wherever this app needs it (overtime, vacation-pay accrual, stat holiday pay) — falling back to scheduled hours if someone forgets to punch.
- **Payroll Export** — a CSV built specifically for entering approved time off into Jane Payroll.
- **Schedule** — a biweekly (14-day) working schedule per employee, plus one-off changes (holidays, swaps) and a "copy Week 1 to Week 2" shortcut, with a warning when someone's scheduled to work on an approved time-off day.
- **Weekly HR check-in** — employees answer a short set of questions each week to help you prep for the team meeting.
- **Annual review** — employee self-assessment plus your manager review, viewable side by side.
- **Overtime banking** — hours scheduled over 40/week are automatically banked and can be requested back like any other time off.
- **Vacation pay accrual** — a second, dollar-based vacation bank that accrues automatically as a % of wages earned, separate from the hours-based vacation bank employees request time off against.
- **Statutory holiday pay** — calculates what's owed for each employee on an Alberta general (stat) holiday, per Alberta's employment standards formula.

It has **zero external dependencies** — just Node.js. No `npm install`
needed. Data is stored in a single JSON file (`data/db.json`), which is
plenty for a small team.

## Running it locally

```
node server.js
```

Then visit http://localhost:3000

The first time it runs, it creates an admin account:

- email: `leduccitycentrephysio@gmail.com`
- password: `changeme123`

**Log in and change this password immediately** (Account page, top right).

## Adding employees

Log in as admin, go to **Requests & Team**, and use the "Add an employee"
form. Set their starting vacation/wellness/personal balances (in **hours**)
there, along with their hourly wage and vacation accrual % — you can always
adjust any of these later from the same page.

## The Jane Payroll connection

Based on Jane's own docs, Jane Payroll doesn't currently offer a live API to
sync time off automatically — approved time still needs to be entered into
Jane's own Time Off policies (**Billing > Payroll > Account > Time Off**) or
timesheets by hand when you run payroll.

So this app's **Payroll Export** page (admin only) generates a CSV for any
date range (e.g. your pay period) listing every approved request — employee
name, type, dates, and hours (Jane tracks vacation *time* in hours, and so
does this app now — see **Time off is tracked in hours** below). That turns
"digging back through requests" into copying a few numbers from a
spreadsheet.

If Jane later adds a payroll API, this export step could be replaced with an
automatic push — happy to build that once it's available.

## Time off is tracked in hours, not days

Vacation, wellness, personal, and overtime are all tracked and requested in
**hours**. When an employee submits a time off request, they only pick a
type and a date range — they don't need to enter specific start/end times.
The app automatically calculates the hours by looking at their normal
schedule for those dates (falling back to their hours-per-day setting if
nothing's scheduled yet, e.g. a brand-new employee). They can still type an
exact number of hours instead if they want to override the calculated
amount.

Note: **wellness** is what used to be called "sick days" — same balance,
new name, renamed everywhere including in old data.

## Scheduling

Jane's own "Shifts" feature is for booking availability (it controls what
patients can book online), not staff scheduling — there's no request/approval
flow and it doesn't check against time off. So this app has its own
**Schedule** section, based on your actual pay periods:

- Schedules are **biweekly** (14 days), matching your pay period. The
  current pay period runs Aug 2–15, 2026 with payday Aug 21 — every other
  pay period follows the same 14-day cadence automatically.
- Admin sets a repeating weekly pattern per employee (start/end time per
  day, or blank for a day off) at **Schedule > [employee name]**. That
  pattern repeats every week going forward.
- **Copy Week 1 to Week 2** takes whatever's in effect for the first week of
  the current pay period and applies it as one-off changes to the second
  week, without touching the recurring weekly pattern — handy when a
  two-week schedule isn't perfectly repeating.
- One-off changes (a holiday closure, a swapped shift, scheduling someone to
  work — or not work — a stat holiday) can be added for a specific date
  without touching the weekly pattern.
- The team schedule view flags in red any day where someone's scheduled to
  work but also has approved time off — worth a second look before the
  period starts.
- Employees see their own schedule (plus a punch clock) right on their
  **My Dashboard** page, and under **My Schedule**.

## Weekly HR check-in & annual reviews

- **Weekly Check-in**: employees answer a short set of questions each week
  (defaults: what got done, blockers, workload, anything for the meeting).
  You review everyone's answers for a given week at **Check-ins** — handy
  prep before your weekly meeting.
- **Annual Review**: employees fill out a self-assessment once a year. You
  fill out a separate manager review on the same employee at
  **Reviews > [employee name]** — once saved, the employee can see it
  alongside their own answers.
- All three question sets (weekly, self-assessment, manager review) are
  editable any time at **Settings** — one question per line.

## Punch clock

Employees have a **Punch in / Punch out** button right on their dashboard.
Punched hours are what this app uses as "hours worked" for overtime,
vacation pay accrual, and stat holiday pay — if someone forgets to punch on
a given day, it falls back to their scheduled hours for that day instead, so
nothing breaks. If actual hours worked differ from both punches and
schedule, you can always correct someone's balances manually from the
**Requests & Team** page.

## Overtime banking

Every payroll week (Sun–Sat), this app adds up each employee's hours worked
(punched, or scheduled as a fallback) — days already covered by approved
time off don't count. Any hours over 40 in a week are automatically added to
that employee's banked overtime balance. This runs automatically in the
background whenever anyone loads a page — no separate step needed.

Employees can then request to use their banked hours the same way they
request other time off: pick "Overtime" as the type, choose dates, and
optionally enter an exact number of hours (otherwise it defaults to their
normal scheduled hours for those dates). You approve/deny it like any other
request, and it deducts from their banked balance.

Note: turning this on for an existing employee does *not* retroactively bank
overtime from before the feature existed — it only starts counting from
whenever it was switched on.

## Wage, vacation accrual %, and accrued vacation pay

Each employee has an hourly wage and a vacation accrual percentage, both
editable from **Requests & Team**. Every pay period, this app automatically
adds `hours worked in the period × hourly wage × vacation %` to that
employee's **accrued vacation pay** — a running dollar total shown on their
dashboard, separate from their hours-based "vacation (available)" balance
that they request time off against. Think of it as two independent
vacation numbers: one is what they can book off, the other is what they've
earned in vacation pay so far. You can always adjust either manually.
Same no-retroactive-backfill behavior as overtime — turning this on doesn't
create a surprise lump sum from before it was switched on.

## Statutory holiday pay (Alberta)

Alberta's 2026 general holidays are pre-loaded under **Stat Holidays**
(admin only), and you can add others (e.g. Easter Monday, which some
employers observe). To have someone work — or explicitly have off — a stat
holiday, set their hours for that date the same way as any other one-off
schedule change, at **Schedule > [employee name] > One-off changes**.

Opening a holiday's **pay breakdown** page calculates what's owed for every
employee, following Alberta's actual employment standards rules (confirmed
against alberta.ca — the 30-day figure is an *eligibility* threshold, not
the pay formula itself):

- **Eligible** if they've worked 30+ days in the past 12 months (using the
  punch/schedule "hours worked" logic above).
- If eligible and it's a **regular workday they did *not* work**: average
  daily wage (their total wages over the 4 weeks before the holiday ÷ days
  worked in that window).
- If eligible and it's a **regular workday they *did* work**: 1.5× wages for
  the hours worked, plus their average daily wage.
- If eligible and it's **not a regular workday but they worked it**: 1.5×
  wages for the hours worked only.
- If eligible and it's **not a regular workday and they didn't work it**:
  nothing owed.
- If **not eligible**: nothing owed, regardless of the above.

A CSV of the full breakdown is available from the same page.

## Deploying so employees can reach it with a link

This is a single, long-running Node process (not something you can drop on
static hosting like Netlify/Vercel as-is, since it needs to keep the JSON
file and login sessions in memory). The simplest option is a small always-on
web service, e.g. **Render** (free/low-cost tier, supports persistent disk):

1. Push this folder to a GitHub repo (or I can help with that).
2. On Render: New > Web Service > connect the repo.
3. Build command: (leave blank — nothing to build)
4. Start command: `node server.js`
5. Add a persistent disk mounted at `/opt/render/project/src/data` (or set
   the `DATA_DIR` environment variable to wherever the disk is mounted) so
   the JSON database survives restarts/deploys.
6. Deploy — Render gives you a `https://your-app.onrender.com` URL to share
   with employees.

I can walk through this step-by-step, or do it directly if you connect a
Render (or similar) account to this session.

[README_2.md](https://github.com/user-attachments/files/31041592/README_2.md)
