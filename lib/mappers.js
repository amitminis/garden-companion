// Converts between Postgres's snake_case rows and the camelCase shape the
// frontend already speaks (it was written against the Artifact's `db`,
// which returned documents in that shape). Keeping the API's JSON output
// camelCase-identical to the old `db` documents means the frontend port
// is "swap db.collection(...) for fetch(...)", not a data-shape rewrite.

function plantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    type: row.type,
    spot: row.spot,
    notes: row.notes,
    researched: row.researched,
    careTemplateType: row.care_template_type,
    careProfile: row.care_profile,
    yearlySchedule: row.yearly_schedule,
    photos: row.photos,
    sizeInfo: row.size_info,
    healthStatus: row.health_status,
    activeIssue: row.active_issue,
    plantDetails: row.plant_details,
    ageEstimate: row.age_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Maps a partial camelCase patch (as sent by the frontend, e.g.
// {careProfile: {...}, researched: true}) to the snake_case columns used
// in an UPDATE. Only known fields are mapped; unknown keys are dropped
// rather than erroring, so the frontend can send a slightly-too-broad
// patch object without needing to know the exact column list.
const PLANT_FIELD_MAP = {
  name: 'name',
  species: 'species',
  type: 'type',
  spot: 'spot',
  notes: 'notes',
  researched: 'researched',
  careTemplateType: 'care_template_type',
  careProfile: 'care_profile',
  yearlySchedule: 'yearly_schedule',
  photos: 'photos',
  sizeInfo: 'size_info',
  healthStatus: 'health_status',
  activeIssue: 'active_issue',
  plantDetails: 'plant_details',
  ageEstimate: 'age_estimate',
};

// Postgres `date` columns come back from the Neon driver as JS Date objects
// (local midnight), which would JSON-serialize as a full timestamp. The
// frontend compares/keys due dates as plain "YYYY-MM-DD" strings (exactly
// what the Artifact's `db` stored), so normalize back to that here.
function dateOnly(v) {
  if (!v) return v;
  if (v instanceof Date) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  }
  return String(v).slice(0, 10);
}

// The Neon driver (node-postgres param prep) encodes JS ARRAYS as Postgres
// array literals ('{...}'), not JSON — so an array bound to a jsonb column
// either errors or (for []) silently becomes the object {}. Stringify any
// object/array bound for a jsonb column; strings/numbers/booleans/null pass
// through untouched.
function jsonParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    plantId: row.plant_id,
    plantName: row.plant_name,
    title: row.title,
    description: row.description,
    dueDate: dateOnly(row.due_date),
    status: row.status,
    completedAt: row.completed_at,
    kind: row.kind,
    reason: row.reason,
    severity: row.severity,
    year: row.year,
    requestsPhoto: row.requests_photo,
    trackingFor: row.tracking_for,
    scheduleEntryId: row.schedule_entry_id,
    comments: row.comments,
    photo: row.photo,
    createdAt: row.created_at,
  };
}

const TASK_FIELD_MAP = {
  plantId: 'plant_id',
  plantName: 'plant_name',
  title: 'title',
  description: 'description',
  dueDate: 'due_date',
  status: 'status',
  completedAt: 'completed_at',
  kind: 'kind',
  reason: 'reason',
  severity: 'severity',
  year: 'year',
  requestsPhoto: 'requests_photo',
  trackingFor: 'tracking_for',
  scheduleEntryId: 'schedule_entry_id',
  comments: 'comments',
  photo: 'photo',
};

function settingsFromRow(row) {
  if (!row) return null;
  return {
    location: row.location,
    onboarded: row.onboarded,
    reminderHour: row.reminder_hour,
    photoCheckinDay: row.photo_checkin_day,
    createdAt: row.created_at,
  };
}

const SETTINGS_FIELD_MAP = {
  location: 'location',
  onboarded: 'onboarded',
  reminderHour: 'reminder_hour',
  photoCheckinDay: 'photo_checkin_day',
};

module.exports = {
  dateOnly,
  jsonParam,
  plantFromRow,
  PLANT_FIELD_MAP,
  taskFromRow,
  TASK_FIELD_MAP,
  settingsFromRow,
  SETTINGS_FIELD_MAP,
};
