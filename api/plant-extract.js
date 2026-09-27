// POST /api/plants/extract   body: {text}
//
// Ported from garden-companion.html's extractPlants() (onboarding) — the
// same endpoint also serves the dashboard's quick-add modal (openAddPlant).
// Turns a gardener's free-form description into a JSON array of
// {name, species, type, spot, notes}. Does NOT create plants: the client
// POSTs each one to /api/plants (+ fire-and-forget research), exactly like
// the original.
//
// Never fails the request — returns [] on any error, since both callers
// need to keep working even if extraction is unavailable.

const { completeJson } = require('../lib/ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    res.status(200).json([]);
    return;
  }

  try {
    const result = await completeJson(
      'A home gardener described their garden in their own words below. Extract every distinct plant, tree, bush or flower they mentioned as a JSON array. ' +
      'Each item: {"name": short common name, "species": your best guess at species/cultivar or "" if unclear, "type": one of "tree","bush","flower","vegetable","herb","other", "spot": where in the garden or "" if unspecified, "notes": any other detail they gave or ""}. ' +
      'Reply with only the JSON array, nothing else.\n\nGardener\'s description:\n' + text,
      { timeoutMs: 90_000 }
    );
    res.status(200).json(Array.isArray(result) ? result.filter((p) => p && typeof p === 'object') : []);
  } catch (e) {
    res.status(200).json([]);
  }
};
