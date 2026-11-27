-- ============================================================================
-- SoundWave — Supabase setup  (safe to run more than once)
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Only needed if your `songs` table / bucket don't already have these policies.
-- Without them: guests can't read the feed, or logged-in users can't upload.
-- ============================================================================

-- 1) Songs table ------------------------------------------------------------
create table if not exists public.songs (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  artist      text not null,
  audio_url   text not null,
  cover_url   text,
  uploaded_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

alter table public.songs enable row level security;

-- Everyone (guests included) can read the feed
drop policy if exists "songs are public" on public.songs;
create policy "songs are public"
  on public.songs for select
  using (true);

-- Logged-in users can add songs, only as themselves
drop policy if exists "logged in users add own songs" on public.songs;
create policy "logged in users add own songs"
  on public.songs for insert
  to authenticated
  with check (auth.uid()::text = uploaded_by::text);

-- 2) Public storage bucket "songs" -------------------------------------------
insert into storage.buckets (id, name, public)
values ('songs', 'songs', true)
on conflict (id) do update set public = true;

-- Anyone can stream / view files
drop policy if exists "songs bucket is public to read" on storage.objects;
create policy "songs bucket is public to read"
  on storage.objects for select
  using (bucket_id = 'songs');

-- Logged-in users can upload into their own folder (<user id>/...), which is what the app does
drop policy if exists "logged in users upload to songs bucket" on storage.objects;
create policy "logged in users upload to songs bucket"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'songs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 3) Optional: live updates so new uploads appear for everyone without a refresh
do $$
begin
  alter publication supabase_realtime add table public.songs;
exception
  when duplicate_object then null;
end $$;
