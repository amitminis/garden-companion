// The few user-facing strings the server writes itself (follow-up tasks
// after a diagnosis, the weekly check-in, fallbacks), in the gardener's
// language — see lib/language.js. Everything else the server writes comes
// from the model, already in that language.

const { normalizeLanguage } = require('./language');

const MESSAGES = {
  en: {
    checkOn: 'Check on {name}',
    careFor: 'Care for {name} — {n} steps',
    recovering: 'Check on {name} — is it recovering?',
    followUp: 'Follow-up on: {issues}',
    superseded: 'Superseded by a newer check-in.',
    resolved: 'Resolved — latest photo looks healthy.',
    checkinTitle: 'Weekly check-in: {name}',
    checkinDesc: "A quick photo to keep track of how it's doing.",
    weatherHeadsUp: 'Weather heads-up',
    issueWithPhoto: 'Issue reported with photo',
    photoOnlySummary: "Photo saved, but I can't analyze images in this view right now — no tasks were created. Try describing the problem in words instead.",
    photoNotAnalyzedKept: "Couldn't analyze that photo — it's saved, but try again for a diagnosis.",
    photoNotAnalyzed: "Couldn't analyze that photo — try again.",
  },
  he: {
    checkOn: 'לבדוק את {name}',
    careFor: 'טיפול ב{name} — {n} צעדים',
    recovering: 'לבדוק את {name} — האם הוא מתאושש?',
    followUp: 'מעקב אחרי: {issues}',
    superseded: 'הוחלף בבדיקה חדשה יותר.',
    resolved: 'נפתר — התמונה האחרונה נראית בריאה.',
    checkinTitle: 'צילום שבועי: {name}',
    checkinDesc: 'תמונה מהירה כדי לעקוב אחרי מצבו.',
    weatherHeadsUp: 'התראת מזג אוויר',
    issueWithPhoto: 'בעיה שדווחה עם תמונה',
    photoOnlySummary: 'התמונה נשמרה, אבל כרגע אין אפשרות לנתח כאן תמונות — לא נוצרו משימות. כדאי לנסות לתאר את הבעיה במילים.',
    photoNotAnalyzedKept: 'לא הצלחתי לנתח את התמונה — היא נשמרה, אבל כדאי לנסות שוב כדי לקבל אבחון.',
    photoNotAnalyzed: 'לא הצלחתי לנתח את התמונה — כדאי לנסות שוב.',
  },
};

// msg('he', 'checkOn', {name: 'הלימון'})
function msg(lang, key, vars) {
  const s = MESSAGES[normalizeLanguage(lang)][key] || MESSAGES.en[key] || key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

module.exports = { msg };
