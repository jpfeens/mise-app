-- ============================================================
-- Rish — Supabase schema v3 (user auth + public recipes)
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- NOTE: Supabase Auth must be enabled (it is by default)
-- ============================================================

-- ── user_profiles ─────────────────────────────────────────────
-- One row per authenticated user, storing onboarding prefs
create table if not exists user_profiles (
  id              uuid        primary key references auth.users(id) on delete cascade,
  display_name    text        not null default '',
  diet            text        not null default 'omnivore'
                              check (diet in ('vegan','vegetarian','pescatarian','omnivore','keto','paleo')),
  household       text        not null default 'family'
                              check (household in ('solo','couple','family','large')),
  default_private boolean     not null default true,
  onboarding_done boolean     not null default false,
  created_at      timestamptz default now()
);

-- ── recipes ───────────────────────────────────────────────────
create table if not exists recipes (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  name          text        not null,
  cats          text[]      not null default '{dinner}',
  emoji         text        not null default '🍽️',
  src           text        not null default 'manual'
                            check (src in ('photo','screenshot','url','manual')),
  time          text        not null default '30 min',
  base_servings integer     not null default 2,
  time_made     integer     not null default 0,
  rating        integer     default 0 check (rating between 0 and 5),
  notes         text        default '',
  tags          text[]      default '{}',
  family_profiles text[]    default '{}',
  edits         jsonb       default '[]',
  ings          jsonb       default '[]',
  steps         jsonb       default '[]',
  photo_url     text        default '',
  source_label  text        default '',
  source_url    text        default '',
  macros        jsonb       default null,
  is_public     boolean     not null default false,
  public_likes  integer     not null default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists recipes_user_idx on recipes (user_id);
create index if not exists recipes_public_idx on recipes (is_public) where is_public = true;
create index if not exists recipes_name_fts on recipes using gin (to_tsvector('english', name));
create index if not exists recipes_tags_idx on recipes using gin (tags);

-- ── public_recipe_likes ───────────────────────────────────────
-- Tracks which users liked a public recipe (prevents double-liking)
create table if not exists public_recipe_likes (
  user_id   uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, recipe_id)
);

-- ── grocery_items ─────────────────────────────────────────────
create table if not exists grocery_items (
  id          uuid    primary key default gen_random_uuid(),
  user_id     uuid    not null references auth.users(id) on delete cascade,
  name        text    not null,
  amt         text    default '',
  cat         text    default 'other',
  checked     boolean default false,
  created_at  timestamptz default now(),
  unique (user_id, name)
);

-- ── planner_slots ─────────────────────────────────────────────
create table if not exists planner_slots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  week       text not null,
  day        text not null,
  meal       text not null check (meal in ('Breakfast','Lunch','Dinner')),
  recipe_id  uuid references recipes(id) on delete set null,
  unique (user_id, week, day, meal)
);

-- ── updated_at trigger ────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists recipes_updated_at on recipes;
create trigger recipes_updated_at
  before update on recipes
  for each row execute procedure set_updated_at();

-- ── Row Level Security ────────────────────────────────────────
alter table user_profiles     enable row level security;
alter table recipes           enable row level security;
alter table public_recipe_likes enable row level security;
alter table grocery_items     enable row level security;
alter table planner_slots     enable row level security;

-- user_profiles: own row only
create policy "users manage own profile"
  on user_profiles for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- recipes: own recipes always; public recipes readable by all
create policy "users manage own recipes"
  on recipes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "public recipes readable by all"
  on recipes for select
  using (is_public = true);

-- likes: own rows only
create policy "users manage own likes"
  on public_recipe_likes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- grocery: own items only
create policy "users manage own grocery"
  on grocery_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- planner: own slots only
create policy "users manage own planner"
  on planner_slots for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
