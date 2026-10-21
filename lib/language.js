// The gardener's language (settings.language: 'he' | 'en', Hebrew by
// default) — the app's UI is translated client-side (public/js/i18n.js);
// this is the server's half: what language the AI writes care guides,
// tips, diagnoses and answers in (via lib/garden-context.js), and the few
// strings the server writes itself (lib/messages.js).
//
// The column is added on first use, so existing databases pick it up
// without a migration step (the same statement is in schema.sql).

const sql = require('./db');

const LANGUAGES = { he: 'Hebrew', en: 'English' };
const DEFAULT_LANGUAGE = 'he';

let columnReady = null;
function ensureLanguageColumn() {
  if (!columnReady) {
    columnReady = sql`alter table settings add column if not exists language text not null default 'he'`
      .catch((e) => { columnReady = null; throw e; });
  }
  return columnReady;
}

function normalizeLanguage(v) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, v) ? v : DEFAULT_LANGUAGE;
}

async function getLanguage() {
  try {
    await ensureLanguageColumn();
    const [row] = await sql`select language from settings where id = true`;
    return normalizeLanguage(row && row.language);
  } catch (e) {
    return DEFAULT_LANGUAGE;
  }
}

// Appended to every advice prompt (through the garden context text).
function languageInstruction(lang) {
  const name = LANGUAGES[normalizeLanguage(lang)];
  let s = 'Write every piece of text meant for the gardener (titles, notes, descriptions, summaries, answers) in ' + name + '. ' +
    'Keep JSON keys and fixed values such as "healthy" / "needs_attention" exactly as specified.';
  if (lang === 'he') {
    s += ' Use natural, everyday Israeli Hebrew and the plant names Israeli gardeners use; address the gardener in gender-neutral forms (plural or infinitive).';
  }
  return s;
}

module.exports = { LANGUAGES, DEFAULT_LANGUAGE, ensureLanguageColumn, normalizeLanguage, getLanguage, languageInstruction };
