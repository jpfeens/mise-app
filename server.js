import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) { console.error(`Missing env vars: ${missing.join(', ')}`); process.exit(1); }

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Admin client — uses service key if available, otherwise anon key
// Used only for operations that genuinely need to bypass RLS (cross-user reads)
const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY);

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) console.log(`${req.method} ${req.path}`);
  next();
});

// ── Auth middleware ────────────────────────────────────────────
// Creates a Supabase client authenticated as the user.
// This client has full RLS access to the user's own rows.
async function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  const token = auth.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) { res.status(401).json({ error: 'Invalid token' }); return null; }
  return { user, client };
}

// ══════════════════════════════════════════════════════════════
// CLAUDE PROXY
// ══════════════════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  const { model, messages, system, max_tokens } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });
  const hasPdf = messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'document' && b.source?.media_type === 'application/pdf'));
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', ...(hasPdf && { 'anthropic-beta': 'pdfs-2024-09-25' }) },
      body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: max_tokens || 1500, messages, ...(system && { system }) })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Anthropic error' });
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Could not reach Anthropic API' }); }
});

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  // Create profile row using admin client (new user has no session yet)
  if (data.user) {
    const { error: profileErr } = await adminClient.from('user_profiles').upsert({
      id: data.user.id,
      display_name: displayName || email.split('@')[0],
      onboarding_done: false,
    }, { onConflict: 'id' });
    if (profileErr) console.error('Profile creation error on signup:', profileErr.message);
  }
  res.json({ session: data.session, user: data.user });
});

app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session, user: data.user });
});

app.post('/api/auth/signout', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  await auth.client.auth.signOut();
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { user, client } = auth;

  // Try fetching profile with user's own client
  let { data: profile } = await client.from('user_profiles').select('*').eq('id', user.id).single();

  // If not found, create it via admin client
  if (!profile) {
    console.log('Profile not found for', user.id, '— creating via admin');
    const { data: created, error: createErr } = await adminClient.from('user_profiles')
      .upsert({ id: user.id, display_name: user.email?.split('@')[0] || 'User', onboarding_done: false }, { onConflict: 'id' })
      .select().single();
    if (createErr) { console.error('Create profile error:', createErr.message); return res.status(500).json({ error: 'Could not create profile' }); }
    profile = created;
  }
  res.json({ user, profile });
});

// ── Profile update ─────────────────────────────────────────────
// By the time this is called, the profile row always exists (created in /api/auth/me)
// Use the user's own client — RLS allows users to update their own row
app.patch('/api/auth/profile', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const allowed = ['display_name','diet','household','default_private','onboarding_done'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  console.log('Updating profile for', auth.user.id, updates);

  // Try with user's own client first
  const { data, error } = await auth.client.from('user_profiles')
    .update(updates).eq('id', auth.user.id).select().single();

  if (data) { console.log('Profile updated OK'); return res.json(data); }

  // Fallback: upsert via admin client (handles missing row edge case)
  console.log('User client update failed:', error?.message, '— trying admin upsert');
  const { data: d2, error: e2 } = await adminClient.from('user_profiles')
    .upsert({ id: auth.user.id, display_name: auth.user.email?.split('@')[0] || 'User', ...updates }, { onConflict: 'id' })
    .select().single();
  if (e2) { console.error('Admin upsert also failed:', e2.message); return res.status(500).json({ error: e2.message }); }
  console.log('Profile upserted via admin OK');
  res.json(d2);
});

// ══════════════════════════════════════════════════════════════
// RECIPES
// ══════════════════════════════════════════════════════════════
app.get('/api/recipes', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data, error } = await auth.client.from('recipes').select('*').eq('user_id', auth.user.id).order('created_at', { ascending: false });
  if (error) { console.error('GET recipes error:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data);
});

app.post('/api/recipes', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const recipe = { ...sanitiseRecipe(req.body), user_id: auth.user.id };
  if (!recipe.name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await auth.client.from('recipes').insert(recipe).select().single();
  if (error) { console.error('POST recipe error:', error.message); return res.status(500).json({ error: error.message }); }
  res.status(201).json(data);
});

app.post('/api/recipes/bulk', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { recipes } = req.body;
  if (!Array.isArray(recipes) || !recipes.length) return res.status(400).json({ error: 'recipes array required' });
  const rows = recipes.map(r => ({ ...sanitiseRecipe(r), user_id: auth.user.id }));
  console.log(`Bulk inserting ${rows.length} recipes for user ${auth.user.id}, first: ${rows[0]?.name}`);
  const { data, error } = await auth.client.from('recipes').insert(rows).select();
  if (error) {
    console.error('Bulk insert error:', error.message, error.details, error.hint);
    return res.status(500).json({ error: error.message });
  }
  console.log(`Bulk insert OK: ${data?.length} recipes saved`);
  res.status(201).json(data);
});

app.patch('/api/recipes/:id', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const updates = { ...sanitiseRecipe(req.body), updated_at: new Date().toISOString() };
  const { data, error } = await auth.client.from('recipes').update(updates).eq('id', req.params.id).eq('user_id', auth.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.delete('/api/recipes/:id', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { error } = await auth.client.from('recipes').delete().eq('id', req.params.id).eq('user_id', auth.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.patch('/api/recipes/:id/visibility', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data, error } = await auth.client.from('recipes').update({ is_public: !!req.body.is_public }).eq('id', req.params.id).eq('user_id', auth.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// COMMUNITY
// ══════════════════════════════════════════════════════════════
app.get('/api/community', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;
  const { data: recipes, error } = await adminClient.from('recipes')
    .select('id,name,cats,emoji,time,base_servings,tags,photo_url,public_likes,user_id,source_label')
    .eq('is_public', true).neq('user_id', auth.user.id)
    .order('public_likes', { ascending: false }).range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  const ids = recipes.map(r => r.id);
  let likedIds = new Set();
  if (ids.length) {
    const { data: likes } = await auth.client.from('public_recipe_likes').select('recipe_id').eq('user_id', auth.user.id).in('recipe_id', ids);
    if (likes) likes.forEach(l => likedIds.add(l.recipe_id));
  }
  res.json(recipes.map(r => ({ ...r, liked_by_me: likedIds.has(r.id) })));
});

app.post('/api/community/:id/like', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data: recipe } = await adminClient.from('recipes').select('id,public_likes,user_id').eq('id', req.params.id).eq('is_public', true).single();
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  if (recipe.user_id === auth.user.id) return res.status(400).json({ error: "Can't like your own" });
  const { error } = await auth.client.from('public_recipe_likes').upsert({ user_id: auth.user.id, recipe_id: req.params.id });
  if (error) return res.status(400).json({ error: 'Already liked' });
  await adminClient.from('recipes').update({ public_likes: recipe.public_likes + 1 }).eq('id', req.params.id);
  res.json({ success: true, public_likes: recipe.public_likes + 1 });
});

app.delete('/api/community/:id/like', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data: recipe } = await adminClient.from('recipes').select('id,public_likes').eq('id', req.params.id).single();
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  await auth.client.from('public_recipe_likes').delete().eq('user_id', auth.user.id).eq('recipe_id', req.params.id);
  const newCount = Math.max(0, recipe.public_likes - 1);
  await adminClient.from('recipes').update({ public_likes: newCount }).eq('id', req.params.id);
  res.json({ success: true, public_likes: newCount });
});

app.post('/api/community/:id/save', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data: src } = await adminClient.from('recipes').select('*').eq('id', req.params.id).eq('is_public', true).single();
  if (!src) return res.status(404).json({ error: 'Not found' });
  const copy = { ...sanitiseRecipe(src), user_id: auth.user.id, is_public: false, public_likes: 0, time_made: 0, rating: 0, notes: '' };
  const { data, error } = await auth.client.from('recipes').insert(copy).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ══════════════════════════════════════════════════════════════
// GROCERY
// ══════════════════════════════════════════════════════════════
app.get('/api/grocery', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data, error } = await auth.client.from('grocery_items').select('*').eq('user_id', auth.user.id).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/grocery', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
  const rows = items.map(i => ({ name: (i.name||'').trim(), amt: i.amt||'', cat: i.cat||'other', checked: false, user_id: auth.user.id })).filter(r => r.name);
  const { data, error } = await auth.client.from('grocery_items').upsert(rows, { onConflict: 'user_id,name' }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/api/grocery/:id', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data, error } = await auth.client.from('grocery_items').update({ checked: req.body.checked }).eq('id', req.params.id).eq('user_id', auth.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/grocery/checked', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { error } = await auth.client.from('grocery_items').delete().eq('checked', true).eq('user_id', auth.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// PLANNER
// ══════════════════════════════════════════════════════════════
app.get('/api/planner', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  let q = auth.client.from('planner_slots').select('*').eq('user_id', auth.user.id);
  if (req.query.week) q = q.eq('week', req.query.week);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/planner/:week/:day/:meal', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { week, day, meal } = req.params;
  const { data, error } = await auth.client.from('planner_slots')
    .upsert({ week, day, meal, recipe_id: req.body.recipe_id, user_id: auth.user.id }, { onConflict: 'user_id,week,day,meal' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/planner/:week/:day/:meal', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { week, day, meal } = req.params;
  const { error } = await auth.client.from('planner_slots').delete().match({ week, day, meal, user_id: auth.user.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// HEALTH + FALLBACK
// ══════════════════════════════════════════════════════════════
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => { console.error('Unhandled:', err); res.status(500).json({ error: 'Internal server error' }); });

app.listen(PORT, () => console.log(`\n🍴  Rish → http://localhost:${PORT}\n`));

function sanitiseRecipe(body) {
  const allowed = ['name','cats','emoji','src','time','base_servings','time_made','rating','notes','tags','family_profiles','edits','ings','steps','photo_url','source_label','source_url','macros','is_public','public_likes'];
  return Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
}
