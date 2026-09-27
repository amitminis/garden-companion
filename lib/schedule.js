// Ported from garden-companion.html's materializeScheduledTasksForYear().
// Same behavior, same comments — only the storage calls changed (db.collection
// -> sql). Turns a plant's yearly_schedule (the care-guide template) into
// real, due-dated "scheduled" tasks for the remaining months of `year`.

const sql = require('./db');
const { isoDate, todayISO } = require('./dates');

async function materializeScheduledTasksForYear(plant, schedule, year) {
  const today = todayISO();

  // Clear out this plant's still-PENDING future scheduled tasks for `year`
  // first, so re-running this (e.g. after "Update research") doesn't leave
  // stale entries alongside the new ones. Completed tasks are left alone
  // as history.
  await sql`
    delete from tasks
    where plant_id = ${plant.id}
      and kind = 'scheduled'
      and year = ${year}
      and status <> 'done'
      and due_date >= ${today}
  `;

  for (const entry of schedule) {
    const dueDate = isoDate(year, entry.month, 15);
    if (dueDate < today) continue; // never create a task for a month that's already passed
    const doneThisYear = entry.lastDone && new Date(entry.lastDone).getFullYear() === year;
    await sql`
      insert into tasks
        (title, description, plant_id, plant_name, schedule_entry_id, due_date, status, completed_at, reason, severity, kind, year, requests_photo)
      values
        (${entry.title}, ${entry.note}, ${plant.id}, ${plant.name}, ${entry.id}, ${dueDate},
         ${doneThisYear ? 'done' : 'pending'}, ${doneThisYear ? entry.lastDone : null},
         'care guide', 'info', 'scheduled', ${year}, ${!!entry.requestsPhoto})
    `;
  }
}

module.exports = { materializeScheduledTasksForYear };
