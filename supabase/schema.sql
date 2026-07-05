-- ============================================================
-- Mise — Supabase schema  (v2 — adds photo_url column)
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── recipes ──────────────────────────────────────────────────
create table if not exists recipes (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  cat           text        not null default 'dinner'
                            check (cat in ('breakfast','lunch','dinner','snack','dessert')),
  emoji         text        not null default '🍽️',
  src           text        not null default 'manual'
                            check (src in ('photo','screenshot','url','manual')),
  time          text        not null default '30 min',
  base_servings integer     not null default 2,
  time_made     integer     not null default 0,
  rating        integer     default 0 check (rating between 0 and 5),
  notes         text        default '',
  tags          text[]      default '{}',
  profiles      text[]      default '{}',
  edits         jsonb       default '[]',
  ings          jsonb       default '[]',
  steps         jsonb       default '[]',
  photo_url     text        default '',   -- real food photo URL
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists recipes_name_fts
  on recipes using gin (to_tsvector('english', name));

create index if not exists recipes_tags_idx
  on recipes using gin (tags);

-- ── profiles ─────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key default gen_random_uuid(),
  name        text   not null,
  emoji       text   not null default '👤',
  preferences jsonb  default '{}',
  created_at  timestamptz default now()
);

-- ── grocery_items ─────────────────────────────────────────────
create table if not exists grocery_items (
  id          uuid    primary key default gen_random_uuid(),
  name        text    not null unique,
  amt         text    default '',
  cat         text    default 'other',
  checked     boolean default false,
  created_at  timestamptz default now()
);

-- ── planner_slots ─────────────────────────────────────────────
create table if not exists planner_slots (
  id         uuid primary key default gen_random_uuid(),
  week       text not null,
  day        text not null,
  meal       text not null check (meal in ('Breakfast','Lunch','Dinner')),
  recipe_id  uuid references recipes(id) on delete set null,
  unique (week, day, meal)
);

-- ── updated_at trigger ────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recipes_updated_at on recipes;
create trigger recipes_updated_at
  before update on recipes
  for each row execute procedure set_updated_at();

-- ── Row Level Security (open for beta — tighten before public launch) ──
alter table recipes       enable row level security;
alter table profiles      enable row level security;
alter table grocery_items enable row level security;
alter table planner_slots enable row level security;

create policy "public read/write recipes"
  on recipes for all using (true) with check (true);
create policy "public read/write profiles"
  on profiles for all using (true) with check (true);
create policy "public read/write grocery"
  on grocery_items for all using (true) with check (true);
create policy "public read/write planner"
  on planner_slots for all using (true) with check (true);

-- ── Seed data ─────────────────────────────────────────────────
insert into recipes (name, cat, emoji, src, time, base_servings, time_made, rating, tags, profiles, photo_url, ings, steps)
values
  (
    'Avocado toast with poached egg', 'breakfast', '🥑', 'manual', '15 min', 2, 8, 5,
    array['quick','weeknight'], array['maya','luca'],
    'https://images.unsplash.com/photo-1541519227354-08fa5d50c820?w=400&q=80',
    '[{"amt":"2 slices","unit":null,"qty":2,"name":"sourdough"},{"amt":"1","unit":null,"qty":1,"name":"avocado"},{"amt":"2","unit":null,"qty":2,"name":"eggs"},{"amt":"1 tsp","unit":"tsp","qty":1,"name":"lemon juice"},{"amt":"to taste","unit":null,"qty":null,"name":"chili flakes"}]',
    '["Toast sourdough until golden and crisp.","Mash avocado with lemon juice, salt, and chili flakes.","Poach eggs in gently simmering water for 3 minutes.","Spread avocado on toast, top with egg."]'
  ),
  (
    'Salmon teriyaki', 'dinner', '🐟', 'manual', '25 min', 2, 7, 5,
    array['asian','quick'], array['dad','maya'],
    'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400&q=80',
    '[{"amt":"2 fillets","unit":null,"qty":2,"name":"salmon"},{"amt":"3 tbsp","unit":"tbsp","qty":3,"name":"soy sauce"},{"amt":"2 tbsp","unit":"tbsp","qty":2,"name":"mirin"},{"amt":"1 tbsp","unit":"tbsp","qty":1,"name":"honey"},{"amt":"1 tsp","unit":"tsp","qty":1,"name":"sesame oil"}]',
    '["Mix soy, mirin, honey, sesame oil into a glaze.","Marinate salmon 15 min.","Sear skin-side down 4 min, flip and glaze.","Serve over steamed rice."]'
  ),
  (
    'Chocolate lava cake', 'dessert', '🍫', 'manual', '20 min', 4, 6, 5,
    array['family-favourite'], array['dad','maya','luca'],
    'https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=400&q=80',
    '[{"amt":"100g","unit":"g","qty":100,"name":"dark chocolate"},{"amt":"100g","unit":"g","qty":100,"name":"butter"},{"amt":"4","unit":null,"qty":4,"name":"eggs"},{"amt":"100g","unit":"g","qty":100,"name":"powdered sugar"},{"amt":"2 tbsp","unit":"tbsp","qty":2,"name":"flour"}]',
    '["Melt chocolate and butter together.","Whisk in eggs, yolks, and sugar.","Fold in flour gently.","Bake at 200°C for exactly 12 min."]'
  )
on conflict do nothing;
