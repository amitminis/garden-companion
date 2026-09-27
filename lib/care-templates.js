// Ported unchanged from garden-companion.html (v13). Kept as its own module
// since it's used both by plant creation (api/plants/index.js) and by the
// research prompt (lib/sandbox-agent.js).
function careTemplateFor(type) {
  return (type === 'tree' || type === 'bush' || type === 'flower') ? type : 'other';
}

module.exports = { careTemplateFor };
