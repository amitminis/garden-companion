// Consolidated Vercel Function for /api/tasks/:id and its /photo sub-action
// — see api/plant-detail.js for why (staying under the Hobby plan's
// 12-function-per-deployment cap). vercel.json rewrites both
// "/api/tasks/:id" and "/api/tasks/:id/:action" here.

const base = require('../lib/handlers/task-base');
const photo = require('../lib/handlers/task-photo');

module.exports = async function handler(req, res) {
  const action = req.query.action;
  if (!action) return base(req, res);
  if (action === 'photo') return photo(req, res);
  res.status(404).json({ error: 'Not found' });
};
