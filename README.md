# 🍴 Mise

> AI-powered recipe library — import from photos, screenshots, or URLs. Discover real recipes. Plan your week. Generate grocery lists.

---

## What's in this repo

| File | Purpose |
|---|---|
| `server.js` | Express server — Claude API proxy + all CRUD routes |
| `public/index.html` | The full frontend (paste the latest widget here) |
| `public/api.js` | Client module for calling server routes |
| `supabase/schema.sql` | Run once in Supabase SQL Editor to create tables |
| `package.json` | Node dependencies |
| `.env.example` | Copy to `.env` and fill in your keys |

---

## Quick start

### 1 — Install

```bash
git clone https://github.com/YOUR_USERNAME/mise-app.git
cd mise-app
npm install
cp .env.example .env   # then fill in your three keys
```

### 2 — Set up the database

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New query**
3. Paste the contents of `supabase/schema.sql` and click **Run**

### 3 — Add the frontend

Save the latest widget from the Claude conversation as `public/index.html`, then do one find-and-replace:

- **Find:** `https://api.anthropic.com/v1/messages`
- **Replace:** `/api/claude`

### 4 — Run

```bash
npm run dev    # auto-restarts on changes (Node 18+)
# open http://localhost:3000
```

### 5 — Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add three environment variables: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
4. Railway auto-deploys — live URL in ~60 seconds

---

## Wiring up persistence

The frontend currently uses an in-memory recipe array. To make recipes survive page refreshes, add this to the top of your `<script>` block in `index.html`:

```js
// Load recipes from Supabase on startup
async function loadRecipesFromDB() {
  try {
    const data = await fetch('/api/recipes').then(r => r.json());
    if (data && data.length) {
      recipes = data.map(r => ({
        ...r,
        ings: r.ings || [], steps: r.steps || [],
        tags: r.tags || [], profiles: r.profiles || [], edits: r.edits || [],
      }));
      filterRecipes();
    }
  } catch(e) { console.error('Could not load recipes:', e); }
}
loadRecipesFromDB();
```

Then update `saveExtracted()` to also POST to `/api/recipes`, and update `saveCbEdit()` to PATCH to `/api/recipes/:id`. See `public/api.js` for the full client API.

---

## API routes

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/claude` | Proxies to Anthropic |
| `GET` | `/api/recipes` | List all recipes |
| `POST` | `/api/recipes` | Create a recipe |
| `PATCH` | `/api/recipes/:id` | Update a recipe |
| `DELETE` | `/api/recipes/:id` | Delete a recipe |
| `GET` | `/api/profiles` | List profiles |
| `POST` | `/api/profiles` | Create a profile |
| `GET` | `/api/grocery` | Grocery list |
| `POST` | `/api/grocery` | Add items (deduplicates) |
| `PATCH` | `/api/grocery/:id` | Toggle checked |
| `DELETE` | `/api/grocery/checked` | Clear checked items |
| `GET` | `/api/planner?week=2025-W24` | Get week's plan |
| `PUT` | `/api/planner/:week/:day/:meal` | Set a slot |
| `DELETE` | `/api/planner/:week/:day/:meal` | Clear a slot |
| `GET` | `/api/health` | Health check |

---

## Features

- **Multi-screenshot import** — queue multiple screenshots, Claude compiles them into one recipe
- **Real food photos** — auto-fetched from Unsplash on import; replaceable with your own
- **Discover mode** — Claude finds a real highly-rated recipe matching your mood and imports it fully
- **Cookbook view** — full-screen recipe page with two-column layout
- **Serving scaler** — scales all ingredient amounts; green highlights show what changed
- **Selective grocery list** — tick which ingredients you need before adding to list
- **Meal planner** — 7-day grid with searchable recipe picker per slot
- **Wear marks** — heavily-used recipes show coffee rings and stains on their card
- **Handwriting edits** — crossed-out originals with Caveat-font annotations
- **"I made this"** — distinct cook-logging button separate from just viewing
- **Responsive** — works on desktop, tablet, and mobile

---

## Before going public

- [ ] Add Supabase Auth (email magic links or Google OAuth)
- [ ] Tighten Row Level Security so users only see their own data
- [ ] Add rate limiting to `/api/claude` (`express-rate-limit` package)
- [ ] Switch to Unsplash API (free, 50 req/hr) for proper photo attribution
- [ ] Store uploaded photos in Supabase Storage instead of as base64 strings
