# Team App — Leduc City Centre Physio

A small, self-contained web app covering:

- **Time off** — employees request it, you approve/deny it, everyone sees a shared calendar.
- **Payroll Export** — a CSV built specifically for entering approved time off into Jane Payroll.
- **Schedule** — weekly working hours per employee, plus one-off changes (holidays, swaps), with a warning when someone's scheduled to work on an approved time-off day.
- **Weekly HR check-in** — employees answer a short set of questions each week to help you prep for the team meeting.
- **Annual review** — employee self-assessment plus your manager review, viewable side by side.

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
form. Set their starting vacation/sick/personal day balances there — you can
always adjust balances later from the same page.

## The Jane Payroll connection

Based on Jane's own docs, Jane Payroll doesn't currently offer a live API to
sync time off automatically — approved time still needs to be entered into
Jane's own Time Off policies (**Billing > Payroll > Account > Time Off**) or
timesheets by hand when you run payroll.

So this app's **Payroll Export** page (admin only) generates a CSV for any
date range (e.g. your pay period) listing every approved request — employee
name, type, dates, days, and hours (calculated from each employee's
hours-per-day setting, since Jane tracks vacation *time* in hours). That
turns "digging back through requests" into copying a few numbers from a
spreadsheet.

If Jane later adds a payroll API, this export step could be replaced with an
automatic push — happy to build that once it's available.

## Scheduling

Jane's own "Shifts" feature is for booking availability (it controls what
patients can book online), not staff scheduling — there's no request/approval
flow and it doesn't check against time off. So this app has its own
**Schedule** section:

- Admin sets a repeating weekly schedule per employee (start/end time per
  day, or blank for a day off) at **Schedule > [employee name]**.
- One-off changes (a holiday closure, a swapped shift) can be added for a
  specific date without touching the weekly pattern.
- The team schedule view flags in red any day where someone's scheduled to
  work but also has approved time off — worth a second look before the week
  starts.
- Employees see their own hours under **My Schedule**.

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
