// POST /api/plants/:id/photo   body: {dataUrl, note}
//
// Ported from garden-companion.html's analyzeAndApplyPlantPhoto() (via
// lib/plant-photo.js). Analyzes a new photo of this plant (size, health,
// issues) and applies the diagnosis (status + follow-up tasks, see
// lib/issue-diagnosis.js). The photo is ALWAYS saved, even when analysis is
// unavailable or fails.
//
// Responses (all HTTP 200 once the plant exists — same graceful pattern as
// research.js, never crash the request):
//   {plant, result}                                  analysis applied
//   {plant, result:{...,__photoOnly:true}, __photoOnly:true}
//                                                    no ANTHROPIC_API_KEY — photo saved only
//   {plant, result:{...}, __photoOnly:true, error}   analysis failed — photo saved only
//   {error}                                          couldn't even save the photo

const sql = require('../db');
const { plantFromRow } = require('../mappers');
const { analyzeAndApplyPlantPhoto } = require('../plant-photo');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const body = req.body || {};
  if (!body.dataUrl || !/^data:image\//.test(String(body.dataUrl))) {
    res.status(400).json({ error: 'dataUrl (a data:image/... URL) is required' });
    return;
  }

  const [row] = await sql`select * from plants where id = ${id}`;
  const plant = plantFromRow(row);
  if (!plant) {
    res.status(404).json({ error: 'Plant not found' });
    return;
  }

  try {
    const out = await analyzeAndApplyPlantPhoto(plant, body.dataUrl, String(body.note || '').trim());
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
};
