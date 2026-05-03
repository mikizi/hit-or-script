-- Hit or Script — global leaderboard (Supabase SQL editor)
-- Run once per project, then set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in the app build.

create table if not exists public.leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  score integer not null,
  max_possible integer not null,
  flag text not null,
  created_at timestamptz not null default now()
);

create index if not exists leaderboard_entries_score_created_idx
  on public.leaderboard_entries (score desc, created_at desc);

alter table public.leaderboard_entries enable row level security;

-- Drop if you re-run this file during setup
drop policy if exists "leaderboard_select_all" on public.leaderboard_entries;
drop policy if exists "leaderboard_insert_anon" on public.leaderboard_entries;

create policy "leaderboard_select_all"
  on public.leaderboard_entries
  for select
  to anon, authenticated
  using (true);

-- Tight bounds reduce obvious spam; tune max if you change rounds/points.
create policy "leaderboard_insert_anon"
  on public.leaderboard_entries
  for insert
  to anon, authenticated
  with check (
    length(btrim(label)) between 1 and 40
    and score >= 0
    and score <= 999
    and max_possible >= 1
    and max_possible <= 999
    and length(btrim(flag)) between 1 and 16
  );

grant usage on schema public to anon, authenticated;
grant select, insert on public.leaderboard_entries to anon, authenticated;
