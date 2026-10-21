// Turns a plant's yearly_schedule (the care guide's month-by-month plan)
// into real, due-dated "scheduled" tasks over a rolling 12-month window:
// each entry's next occurrence is the 15th of its month this year if that's
// still ahead, otherwise next year. (The original only looked at the rest
// of the current calendar year, so a guide built in October produced one or
// two tasks and nothing after December.)
//
// Idempotent per occurrence: an entry never gets a second task for the same
// year, whatever that task's status or due date, so it's safe to run every
// day (api/cron/daily.js tops the window up) and an edited or completed
// task is never duplicated.

const sql = require('./db');
const { isoDate, todayISO } = require('./dates');

// opts.replace: first delete this plant's still-pending, not-yet-due
// scheduled tasks (used after a care guide is rebuilt, since the new guide's
// entries replace the old ones). Completed and past tasks stay as history.
async function materializeScheduledTasks(plant, schedule, opts = {}) {
  const today = todayISO();
  const thisYear = Number(today.slice(0, 4));

  if (opts.replace) {
    await sql`
      delete from tasks
      where plant_id = ${plant.id}
        and kind = 'scheduled'
        and status <> 'done'
        and due_date >= ${today}
    `;
  }

  let created = 0;
  for (const entry of schedule || []) {
    const month = Number(entry.month);
    if (!(month >= 1 && month <= 12)) continue;
    let year = thisYear;
    let dueDate = isoDate(year, month, 15);
    if (dueDate < today) { year += 1; dueDate = isoDate(year, month, 15); }

    const [existing] = await sql`
      select id from tasks
      where plant_id = ${plant.id} and kind = 'scheduled'
        and schedule_entry_id = ${entry.id} and year = ${year}
      limit 1
    `;
    if (existing) continue;

    const doneThisYear = entry.lastDone && new Date(entry.lastDone).getFullYear() === year;
    await sql`
      insert into tasks
        (title, description, plant_id, plant_name, schedule_entry_id, due_date, status, completed_at, reason, severity, kind, year, requests_photo)
      values
        (${entry.title}, ${entry.note}, ${plant.id}, ${plant.name}, ${entry.id}, ${dueDate},
         ${doneThisYear ? 'done' : 'pending'}, ${doneThisYear ? entry.lastDone : null},
         'care guide', 'info', 'scheduled', ${year}, ${!!entry.requestsPhoto})
    `;
    created++;
  }
  return created;
}

module.exports = { materializeScheduledTasks };
