// Consolidated Vercel Function for /api/plants/:id and its sub-actions
// (research, details, issue, photo). The Hobby plan caps a deployment at
// 12 Serverless Functions; splitting each of these into its own file (as
// api/plants/[id].js, api/plants/[id]/research.js, etc.) pushed the total
// past that limit. vercel.json rewrites both "/api/plants/:id" and
// "/api/plants/:id/:action" to this single file, passing id/action as
// query params — the handler logic itself (in lib/handlers/) is otherwise
// byte-for-byte the same as when each lived in its own api/ file.

const base = require('../lib/handlers/plant-base');
const research = require('../lib/handlers/plant-research');
const details = require('../lib/handlers/plant-details');
const issue = require('../lib/handlers/plant-issue');
const photo = require('../lib/handlers/plant-photo-endpoint');

module.exports = async function handler(req, res) {
  const action = req.query.action;
  if (!action) return base(req, res);
  if (action === 'research') return research(req, res);
  if (action === 'details') return details(req, res);
  if (action === 'issue') return issue(req, res);
  if (action === 'photo') return photo(req, res);
  res.status(404).json({ error: 'Not found' });
};
