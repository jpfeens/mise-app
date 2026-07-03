// api.js  —  drop this next to index.html in /public
// Replace all fetch('https://api.anthropic.com/...') calls in index.html
// with api.claude(...), and all direct Supabase calls with api.recipes.*

// ── Claude proxy ──────────────────────────────────────────────────────────
export async function claude({ messages, system, tools, max_tokens = 1024 }) {
  const res = await _post('/api/claude', {
    model: 'claude-sonnet-4-6',
    max_tokens,
    messages,
    ...(system && { system }),
    ...(tools  && { tools  }),
  });
  return res;   // same shape as Anthropic's response
}

// Helper: pull all text blocks out of a Claude response
export function extractText(claudeResponse) {
  return (claudeResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ── Recipes ───────────────────────────────────────────────────────────────
export const recipes = {
  async list()         { return _get('/api/recipes'); },
  async create(r)      { return _post('/api/recipes', r); },
  async update(id, r)  { return _patch(`/api/recipes/${id}`, r); },
  async remove(id)     { return _del(`/api/recipes/${id}`); },
};

// ── Profiles ─────────────────────────────────────────────────────────────
export const profiles = {
  async list()   { return _get('/api/profiles'); },
  async create(p){ return _post('/api/profiles', p); },
};

// ── Grocery list ─────────────────────────────────────────────────────────
export const grocery = {
  async list()          { return _get('/api/grocery'); },
  async addItems(items) { return _post('/api/grocery', { items }); },
  async toggle(id, checked) { return _patch(`/api/grocery/${id}`, { checked }); },
  async clearChecked()  { return _del('/api/grocery/checked'); },
};

// ── Meal planner ─────────────────────────────────────────────────────────
export const planner = {
  async list(week)               { return _get(`/api/planner?week=${week}`); },
  async set(week, day, meal, recipe_id) {
    return _put(`/api/planner/${week}/${day}/${meal}`, { recipe_id });
  },
  async clear(week, day, meal)   { return _del(`/api/planner/${week}/${day}/${meal}`); },
};

// ── Internal fetch helpers ────────────────────────────────────────────────
async function _get(url) {
  const res = await fetch(url);
  return _handle(res);
}
async function _post(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return _handle(res);
}
async function _patch(url, body) {
  const res = await fetch(url, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return _handle(res);
}
async function _put(url, body) {
  const res = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return _handle(res);
}
async function _del(url) {
  const res = await fetch(url, { method: 'DELETE' });
  return _handle(res);
}
async function _handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}
