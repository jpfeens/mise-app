# 🍴 Mise

> AI-powered recipe library — import from photos, screenshots, or URLs. Discover recipes by mood or pantry. Plan your week. Generate grocery lists.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Backend | Node.js + Express |
| AI | Anthropic Claude (`claude-sonnet-4-6`) |
| Database | Supabase (Postgres) |

---

## Local setup (5 minutes)

### 1 — Clone

```bash
git clone https://github.com/YOUR_USERNAME/mise-app.git
cd mise-app
npm install
```

### 2 — Environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com/account/keys](https://console.anthropic.com/account/keys) |
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → anon public key |

### 3 — Create the database

1. Go to [supabase.com](https://supabase.com), create a free project
2. Open **SQL Editor → New query**
3. Paste the entire contents of `supabase/schema.sql`
4. Click **Run**

This creates four tables (`recipes`, `profiles`, `grocery_items`, `planner_slots`) and seeds three starter recipes.

### 4 — Add your frontend

Copy (or move) your `index.html` into the `public/` folder:

```bash
cp ~/Downloads/mise_v4_full.html public/index.html
```

Then do a single find-and-replace inside `index.html`:

- **Find:** `https://api.anthropic.com/v1/messages`
- **Replace:** `/api/claude`

That's the only change needed — all AI calls now route through the server proxy.

### 5 — Run

```bash
npm run dev      # auto-restarts on file changes (Node 18+)
# or
npm start        # production
```

Open [http://localhost:3000](http://localhost:3000) 🎉

---

## Connecting the frontend to persistence

`public/api.js` is a thin client module you can import in `index.html` to load/save recipes from Supabase instead of keeping them in memory. Add this to the top of your `<script>` block:

```html
<script type="module">
import { recipes, grocery, planner, claude, extractText } from '/api.js';

// Load recipes on startup instead of using the hardcoded RECIPES array:
const data = await recipes.list();
// data is an array of recipe objects from Supabase

// Save a new recipe:
await recipes.create({ name: 'My recipe', cat: 'dinner', ... });

// Update a recipe (e.g. after changing rating):
await recipes.update(id, { rating: 5 });

// Claude calls go through the proxy automatically:
const response = await claude({ messages: [...] });
const text = extractText(response);
</script>
```

See `public/api.js` for the full API surface.

---

## Deploying to Railway (free beta hosting)

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. In **Variables**, add all three env vars from your `.env`
5. Railway auto-detects Node and runs `npm start`

Your app gets a public URL (`https://mise-app-production.up.railway.app`) in about 2 minutes.

---

## Project structure

```
mise-app/
├── server.js           ← Express server + API routes
├── public/
│   ├── index.html      ← The full frontend (copy yours here)
│   └── api.js          ← Client module for server routes
├── supabase/
│   └── schema.sql      ← Run once in Supabase SQL editor
├── package.json
├── .env.example        ← Copy to .env and fill in
└── .gitignore
```

## API routes

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/claude` | Proxies to Anthropic (keeps key server-side) |
| `GET` | `/api/recipes` | List all recipes |
| `POST` | `/api/recipes` | Create a recipe |
| `PATCH` | `/api/recipes/:id` | Update a recipe |
| `DELETE` | `/api/recipes/:id` | Delete a recipe |
| `GET` | `/api/profiles` | List family profiles |
| `POST` | `/api/profiles` | Create a profile |
| `GET` | `/api/grocery` | List grocery items |
| `POST` | `/api/grocery` | Add items (deduplicates) |
| `PATCH` | `/api/grocery/:id` | Toggle checked |
| `DELETE` | `/api/grocery/checked` | Clear checked items |
| `GET` | `/api/planner?week=2025-W24` | Get week's plan |
| `PUT` | `/api/planner/:week/:day/:meal` | Set a slot |
| `DELETE` | `/api/planner/:week/:day/:meal` | Clear a slot |
| `GET` | `/api/health` | Health check |

---

## Before going public

- [ ] Add authentication (Supabase Auth is the easiest path — magic links or Google OAuth)
- [ ] Tighten Row Level Security policies so users only see their own recipes
- [ ] Add rate limiting to `/api/claude` (the `express-rate-limit` package)
- [ ] Store images in Supabase Storage instead of as base64 strings
