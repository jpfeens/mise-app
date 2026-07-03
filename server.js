import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));     // large enough for base64 images
app.use(express.static(join(__dirname, 'public')));

// ── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Validate env on startup ────────────────────────────────────────────────
const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌  Missing environment variables: ${missing.join(', ')}`);
  console.error('    Copy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

// ── Request logger ─────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ══════════════════════════════════════════════════════════════════════════
// CLAUDE API PROXY
// POST /api/claude  →  forwards to Anthropic, never exposes the key
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  // Basic shape validation — prevent empty / malformed bodies
  const { model, messages, system, max_tokens, tools } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const payload = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: max_tokens || 1024,
    messages,
    ...(system && { system }),
    ...(tools  && { tools }),
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    console.error('Network error reaching Anthropic:', networkErr.message);
    return res.status(502).json({
      error: 'Could not reach Anthropic API. Check your internet connection.',
    });
  }

  // Forward Anthropic's status code and body verbatim
  const data = await anthropicRes.json();
  if (!anthropicRes.ok) {
    console.error(`Anthropic error ${anthropicRes.status}:`, data);
    return res.status(anthropicRes.status).json({
      error: data?.error?.message || 'Anthropic API error',
      details: data,
    });
  }

  res.json(data);
});

// ══════════════════════════════════════════════════════════════════════════
// RECIPES  (CRUD via Supabase)
// ══════════════════════════════════════════════════════════════════════════

// GET /api/recipes  — list all
app.get('/api/recipes', async (req, res) => {
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase fetch error:', error.message);
    return res.status(500).json({ error: 'Could not load recipes.' });
  }
  res.json(data);
});

// POST /api/recipes  — create one
app.post('/api/recipes', async (req, res) => {
  const recipe = sanitiseRecipe(req.body);
  if (!recipe.name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const { data, error } = await supabase
    .from('recipes')
    .insert(recipe)
    .select()
    .single();

  if (error) {
    console.error('Supabase insert error:', error.message);
    return res.status(500).json({ error: 'Could not save recipe.' });
  }
  res.status(201).json(data);
});

// PATCH /api/recipes/:id  — update one
app.patch('/api/recipes/:id', async (req, res) => {
  const { id } = req.params;
  const updates = sanitiseRecipe(req.body);

  const { data, error } = await supabase
    .from('recipes')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Supabase update error:', error.message);
    return res.status(500).json({ error: 'Could not update recipe.' });
  }
  if (!data) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(data);
});

// DELETE /api/recipes/:id
app.delete('/api/recipes/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('recipes').delete().eq('id', id);
  if (error) {
    console.error('Supabase delete error:', error.message);
    return res.status(500).json({ error: 'Could not delete recipe.' });
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// PROFILES  (family member profiles)
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/profiles', async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Could not load profiles.' });
  res.json(data);
});

app.post('/api/profiles', async (req, res) => {
  const { name, emoji, preferences } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await supabase
    .from('profiles')
    .insert({ name, emoji: emoji || '👤', preferences: preferences || {} })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Could not create profile.' });
  res.status(201).json(data);
});

// ══════════════════════════════════════════════════════════════════════════
// GROCERY LIST
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/grocery', async (req, res) => {
  const { data, error } = await supabase
    .from('grocery_items')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Could not load grocery list.' });
  res.json(data);
});

app.post('/api/grocery', async (req, res) => {
  const { items } = req.body;   // array of { name, amt, cat }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const rows = items.map(i => ({
    name:    (i.name || '').trim(),
    amt:     i.amt  || '',
    cat:     i.cat  || 'other',
    checked: false,
  })).filter(r => r.name);

  const { data, error } = await supabase
    .from('grocery_items')
    .upsert(rows, { onConflict: 'name' })
    .select();

  if (error) return res.status(500).json({ error: 'Could not save grocery items.' });
  res.status(201).json(data);
});

app.patch('/api/grocery/:id', async (req, res) => {
  const { id } = req.params;
  const { checked } = req.body;
  const { data, error } = await supabase
    .from('grocery_items')
    .update({ checked })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Could not update item.' });
  res.json(data);
});

app.delete('/api/grocery/checked', async (req, res) => {
  const { error } = await supabase
    .from('grocery_items')
    .delete()
    .eq('checked', true);

  if (error) return res.status(500).json({ error: 'Could not clear items.' });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// MEAL PLANNER
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/planner', async (req, res) => {
  const { week } = req.query;   // ISO week string, e.g. "2025-W24"
  const query = supabase.from('planner_slots').select('*');
  if (week) query.eq('week', week);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Could not load planner.' });
  res.json(data);
});

app.put('/api/planner/:week/:day/:meal', async (req, res) => {
  const { week, day, meal } = req.params;
  const { recipe_id } = req.body;

  const { data, error } = await supabase
    .from('planner_slots')
    .upsert({ week, day, meal, recipe_id }, { onConflict: 'week,day,meal' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Could not save planner slot.' });
  res.json(data);
});

app.delete('/api/planner/:week/:day/:meal', async (req, res) => {
  const { week, day, meal } = req.params;
  const { error } = await supabase
    .from('planner_slots')
    .delete()
    .match({ week, day, meal });

  if (error) return res.status(500).json({ error: 'Could not clear slot.' });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Catch-all: serve index.html for client-side routing ───────────────────
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n🍴  Mise is running → http://localhost:${PORT}`);
  console.log(`    Anthropic proxy  → POST /api/claude`);
  console.log(`    Supabase URL     → ${process.env.SUPABASE_URL}\n`);
});

// ── Helpers ───────────────────────────────────────────────────────────────
function sanitiseRecipe(body) {
  const allowed = [
    'name', 'cat', 'emoji', 'src', 'time', 'base_servings',
    'time_made', 'rating', 'notes', 'tags', 'profiles',
    'edits', 'ings', 'steps',
  ];
  return Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  );
}
