-- Garden Companion — Neon Postgres schema
--
-- Mirrors the shape of the current Claude Artifact's `db` collections
-- (plants, tasks, settings/profile, weather/latest) closely enough that the
-- one-time export/import from the Artifact is a near-direct field mapping.
--
-- Design note: the Artifact's `db` is a schemaless document store. Rather
-- than force every nested field (careProfile, yearlySchedule, photos,
-- comments, plantDetails, activeIssue, ...) into its own column, this keeps
-- those as JSONB — same flexibility the app's JS already assumes — while
-- promoting the columns that are actually filtered/sorted/joined on
-- (status, due_date, plant_id, kind, created_at) to real indexed columns.
-- If a query ever needs to reach inside the JSONB in a hot path, add a
-- generated column + index for that one field rather than normalizing
-- everything up front.

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- plants
-- ---------------------------------------------------------------------
create table if not exists plants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  species          text not null default '',
  type             text not null default 'other',        -- careTemplateFor() key, e.g. "citrus", "flower"
  spot             text not null default '',
  notes            text not null default '',

  researched       boolean not null default false,
  care_template_type text not null default 'other',
  care_profile     jsonb,                                  -- {sun, watering, soil, ...} once researched
  yearly_schedule  jsonb not null default '[]'::jsonb,      -- [{id, month/dueDate info, title, requestsPhoto, lastDone}, ...]

  photos           jsonb not null default '[]'::jsonb,      -- [{dataUrl|blobUrl, date, summary, healthStatus, issues, userNote}, ...] (max 6, capped client/API-side)
  size_info        text not null default '',
  health_status     text not null default 'unknown',        -- unknown | healthy | issue
  active_issue      jsonb,                                   -- {description, since} | null

  plant_details    jsonb not null default '{}'::jsonb,      -- { age|yieldPerYear|groundType|watering|sunExposure: {raw, display} }
  age_estimate      text not null default '',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_plants_created_at on plants (created_at asc);

-- ---------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  plant_id         uuid references plants(id) on delete cascade,
  plant_name       text not null default '',

  title            text not null,
  description      text not null default '',
  due_date         date not null,
  status           text not null default 'pending',        -- pending | done
  completed_at     timestamptz,

  kind             text not null,                           -- scheduled | issue | tip (added from a dashboard garden tip)
  reason           text not null default '',                -- e.g. "weekly checkin", "health tracking", free text
  severity         text not null default 'info',             -- info | warning
  year             int not null,
  requests_photo   boolean not null default false,
  tracking_for     uuid references plants(id) on delete set null, -- set on the follow-up check-in task created after a diagnosis
  schedule_entry_id text,                                    -- links back to an entry in plants.yearly_schedule

  comments         jsonb not null default '[]'::jsonb,       -- [{text, date}, ...]
  photo            jsonb,                                     -- {dataUrl|blobUrl, date, analysis} | null

  created_at       timestamptz not null default now()
);

create index if not exists idx_tasks_due_date on tasks (due_date desc);
create index if not exists idx_tasks_plant_id on tasks (plant_id);
create index if not exists idx_tasks_status_due on tasks (status, due_date);
create index if not exists idx_tasks_kind_status on tasks (kind, status);

-- ---------------------------------------------------------------------
-- settings — single-row table, mirrors the Artifact's settings/profile doc
-- ---------------------------------------------------------------------
create table if not exists settings (
  id                 boolean primary key default true check (id), -- enforces exactly one row
  location           jsonb not null default '{"label":"Unspecified"}'::jsonb,
  onboarded          boolean not null default false,
  reminder_hour      int not null default 7,
  photo_checkin_day  text not null default 'Friday',
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- weather — single-row table, mirrors the Artifact's weather/latest doc
-- ---------------------------------------------------------------------
create table if not exists weather (
  id           boolean primary key default true check (id),
  data         jsonb not null default '{}'::jsonb,          -- whatever shape the daily cron job stores (forecast summary, alert flag, etc.)
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- device_tokens — new table, not present in the Artifact.
-- Holds push registrations once the Capacitor iOS app exists; harmless to
-- create now so the schema doesn't need a second migration later. Unused
-- until the native app phase.
-- ---------------------------------------------------------------------
create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique,
  platform     text not null default 'ios',
  created_at   timestamptz not null default now()
);
