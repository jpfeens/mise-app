import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌  Missing env vars: ${missing.join(', ')}\n`);
  process.exit(1);
}

// Service-role client for admin ops (user profile creation on signup)
// Falls back to anon key if service key not set
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) console.log(`${req.method} ${req.path}`);
  next();
});

// ── Auth middleware ───────────────────────────────────────────
// Reads the Bearer token from Authorization header, validates with Supabase,
// attaches user to req.user. Routes that need auth call requireAuth().
async function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  req._supabaseClient = client; // reuse authed client for RLS queries
  return user;
}

function requireAuth(handler) {
  return async (req, res) => {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    req.user = user;
    return handler(req, res);
  };
}

// Supabase client scoped to the authed user (respects RLS)
function userClient(req) {
  return req._supabaseClient || supabaseAdmin;
}

// ══════════════════════════════════════════════════════════════
// CLAUDE PROXY
// ══════════════════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  const { model, messages, system, max_tokens, tools } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const hasPdf = messages.some(m =>
    Array.isArray(m.content) && m.content.some(b =>
      b.type === 'document' && b.source?.media_type === 'application/pdf'
    )
  );

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    ...(hasPdf && { 'anthropic-beta': 'pdfs-2024-09-25' }),
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1500,
        messages,
        ...(system && { system }),
        ...(tools && { tools }),
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Anthropic error', details: data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Anthropic API.' });
  }
});

// ══════════════════════════════════════════════════════════════
// AUTH — sign up / sign in / sign out / me
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await anonClient.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  // Create user_profile row (use admin client to bypass RLS on new user)
  if (data.user) {
    await supabaseAdmin.from('user_profiles').upsert({
      id: data.user.id,
      display_name: displayName || email.split('@')[0],
      onboarding_done: false,
    });
  }

  res.json({ session: data.session, user: data.user });
});

app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session, user: data.user });
});

app.post('/api/auth/signout', requireAuth(async (req, res) => {
  await userClient(req).auth.signOut();
  res.json({ success: true });
}));

app.get('/api/auth/me', requireAuth(async (req, res) => {
  const { data, error } = await userClient(req)
    .from('user_profiles').select('*').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json({ user: req.user, profile: data });
}));

// ══════════════════════════════════════════════════════════════
// USER PROFILE — preferences & onboarding
// ══════════════════════════════════════════════════════════════
app.patch('/api/auth/profile', requireAuth(async (req, res) => {
  const allowed = ['display_name','diet','household','default_private','onboarding_done'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { data, error } = await userClient(req)
    .from('user_profiles').update(updates).eq('id', req.user.id).select().single();
  if (error) return res.status(500).json({ error: 'Could not update profile.' });
  res.json(data);
}));

// ══════════════════════════════════════════════════════════════
// RECIPES — user-scoped
// ══════════════════════════════════════════════════════════════
app.get('/api/recipes', requireAuth(async (req, res) => {
  const { data, error } = await userClient(req)
    .from('recipes').select('*').eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load recipes.' });
  res.json(data);
}));

app.post('/api/recipes', requireAuth(async (req, res) => {
  const recipe = { ...sanitiseRecipe(req.body), user_id: req.user.id };
  if (!recipe.name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await userClient(req).from('recipes').insert(recipe).select().single();
  if (error) return res.status(500).json({ error: 'Could not save recipe.' });
  res.status(201).json(data);
}));

app.post('/api/recipes/bulk', requireAuth(async (req, res) => {
  const { recipes } = req.body;
  if (!Array.isArray(recipes) || !recipes.length) return res.status(400).json({ error: 'recipes array required' });
  const rows = recipes.map(r => ({ ...sanitiseRecipe(r), user_id: req.user.id }));
  const { data, error } = await userClient(req).from('recipes').insert(rows).select();
  if (error) return res.status(500).json({ error: 'Could not save recipes.' });
  res.status(201).json(data);
}));

app.patch('/api/recipes/:id', requireAuth(async (req, res) => {
  const updates = { ...sanitiseRecipe(req.body), updated_at: new Date().toISOString() };
  const { data, error } = await userClient(req)
    .from('recipes').update(updates).eq('id', req.params.id).eq('user_id', req.user.id)
    .select().single();
  if (error) return res.status(500).json({ error: 'Could not update recipe.' });
  if (!data) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(data);
}));

app.delete('/api/recipes/:id', requireAuth(async (req, res) => {
  const { error } = await userClient(req)
    .from('recipes').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Could not delete recipe.' });
  res.json({ success: true });
}));

// Toggle public/private on own recipe
app.patch('/api/recipes/:id/visibility', requireAuth(async (req, res) => {
  const { is_public } = req.body;
  const { data, error } = await userClient(req)
    .from('recipes').update({ is_public: !!is_public }).eq('id', req.params.id)
    .eq('user_id', req.user.id).select().single();
  if (error) return res.status(500).json({ error: 'Could not update visibility.' });
  res.json(data);
}));

// ══════════════════════════════════════════════════════════════
// COMMUNITY — public recipes browsing + liking
// ══════════════════════════════════════════════════════════════
app.get('/api/community', requireAuth(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;

  // Get public recipes (excluding the user's own)
  const { data: recipes, error } = await supabaseAdmin
    .from('recipes')
    .select('id,name,cats,emoji,time,base_servings,tags,photo_url,public_likes,user_id,source_label')
    .eq('is_public', true)
    .neq('user_id', req.user.id)
    .order('public_likes', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: 'Could not load community recipes.' });

  // Get this user's likes so we can mark which they've liked
  const ids = recipes.map(r => r.id);
  let likedIds = new Set();
  if (ids.length) {
    const { data: likes } = await userClient(req)
      .from('public_recipe_likes').select('recipe_id').eq('user_id', req.user.id).in('recipe_id', ids);
    if (likes) likes.forEach(l => likedIds.add(l.recipe_id));
  }

  res.json(recipes.map(r => ({ ...r, liked_by_me: likedIds.has(r.id) })));
}));

// Like a public recipe
app.post('/api/community/:id/like', requireAuth(async (req, res) => {
  const { id } = req.params;
  // Check it exists and is public
  const { data: recipe } = await supabaseAdmin.from('recipes').select('id,public_likes,user_id').eq('id', id).eq('is_public', true).single();
  if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
  if (recipe.user_id === req.user.id) return res.status(400).json({ error: "Can't like your own recipe." });

  // Upsert like row
  const { error: likeErr } = await userClient(req)
    .from('public_recipe_likes').upsert({ user_id: req.user.id, recipe_id: id });
  if (likeErr) return res.status(400).json({ error: 'Already liked.' });

  // Increment counter
  await supabaseAdmin.from('recipes').update({ public_likes: recipe.public_likes + 1 }).eq('id', id);
  res.json({ success: true, public_likes: recipe.public_likes + 1 });
}));

// Unlike
app.delete('/api/community/:id/like', requireAuth(async (req, res) => {
  const { id } = req.params;
  const { data: recipe } = await supabaseAdmin.from('recipes').select('id,public_likes').eq('id', id).single();
  if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });

  const { error } = await userClient(req)
    .from('public_recipe_likes').delete().eq('user_id', req.user.id).eq('recipe_id', id);
  if (error) return res.status(500).json({ error: 'Could not unlike.' });

  const newCount = Math.max(0, recipe.public_likes - 1);
  await supabaseAdmin.from('recipes').update({ public_likes: newCount }).eq('id', id);
  res.json({ success: true, public_likes: newCount });
}));

// Save a community recipe to own library (copy it)
app.post('/api/community/:id/save', requireAuth(async (req, res) => {
  const { data: src, error } = await supabaseAdmin
    .from('recipes').select('*').eq('id', req.params.id).eq('is_public', true).single();
  if (error || !src) return res.status(404).json({ error: 'Recipe not found.' });

  const copy = {
    ...sanitiseRecipe(src),
    user_id: req.user.id,
    is_public: false,
    public_likes: 0,
    source_label: src.source_label || `From community`,
    time_made: 0,
    rating: 0,
    notes: '',
  };
  const { data, error: saveErr } = await userClient(req).from('recipes').insert(copy).select().single();
  if (saveErr) return res.status(500).json({ error: 'Could not save recipe.' });
  res.status(201).json(data);
}));

// ══════════════════════════════════════════════════════════════
// GROCERY
// ══════════════════════════════════════════════════════════════
app.get('/api/grocery', requireAuth(async (req, res) => {
  const { data, error } = await userClient(req)
    .from('grocery_items').select('*').eq('user_id', req.user.id).order('created_at');
  if (error) return res.status(500).json({ error: 'Could not load grocery list.' });
  res.json(data);
}));

app.post('/api/grocery', requireAuth(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const rows = items
    .map(i => ({ name: (i.name||'').trim(), amt: i.amt||'', cat: i.cat||'other', checked: false, user_id: req.user.id }))
    .filter(r => r.name);
  const { data, error } = await userClient(req)
    .from('grocery_items').upsert(rows, { onConflict: 'user_id,name' }).select();
  if (error) return res.status(500).json({ error: 'Could not save grocery items.' });
  res.status(201).json(data);
}));

app.patch('/api/grocery/:id', requireAuth(async (req, res) => {
  const { data, error } = await userClient(req)
    .from('grocery_items').update({ checked: req.body.checked })
    .eq('id', req.params.id).eq('user_id', req.user.id).select().single();
  if (error) return res.status(500).json({ error: 'Could not update item.' });
  res.json(data);
}));

app.delete('/api/grocery/checked', requireAuth(async (req, res) => {
  const { error } = await userClient(req)
    .from('grocery_items').delete().eq('checked', true).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Could not clear items.' });
  res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════
// PLANNER
// ══════════════════════════════════════════════════════════════
app.get('/api/planner', requireAuth(async (req, res) => {
  const q = userClient(req).from('planner_slots').select('*').eq('user_id', req.user.id);
  if (req.query.week) q.eq('week', req.query.week);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'Could not load planner.' });
  res.json(data);
}));

app.put('/api/planner/:week/:day/:meal', requireAuth(async (req, res) => {
  const { week, day, meal } = req.params;
  const { data, error } = await userClient(req)
    .from('planner_slots')
    .upsert({ week, day, meal, recipe_id: req.body.recipe_id, user_id: req.user.id }, { onConflict: 'user_id,week,day,meal' })
    .select().single();
  if (error) return res.status(500).json({ error: 'Could not save slot.' });
  res.json(data);
}));

app.delete('/api/planner/:week/:day/:meal', requireAuth(async (req, res) => {
  const { week, day, meal } = req.params;
  const { error } = await userClient(req)
    .from('planner_slots').delete().match({ week, day, meal, user_id: req.user.id });
  if (error) return res.status(500).json({ error: 'Could not clear slot.' });
  res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════════
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n🍴  Rish is running → http://localhost:${PORT}\n`);
});

// ── Helpers ───────────────────────────────────────────────────
function sanitiseRecipe(body) {
  const allowed = [
    'name','cats','emoji','src','time','base_servings','time_made','rating',
    'notes','tags','family_profiles','edits','ings','steps','photo_url',
    'source_label','source_url','macros','is_public','public_likes',
  ];
  return Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
}
