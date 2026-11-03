-- Consistency Clock: one person's challenges, daily check-ins, reminder settings, push subscriptions.

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  title text not null check (char_length(btrim(title)) between 1 and 60),
  days integer not null check (days between 1 and 3650),
  start_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index challenges_one_active_per_user on public.challenges (user_id) where active;
create index challenges_user_idx on public.challenges (user_id);

create table public.checkins (
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  day date not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (challenge_id, day)
);
create index checkins_user_idx on public.checkins (user_id);

create table public.reminder_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  remind_at time not null default '20:00',
  timezone text not null default 'Europe/Berlin' check (char_length(timezone) between 1 and 64),
  last_sent_on date,
  updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Server-only key/value store (VAPID keys, cron token). RLS on, no policies, no grants.
create table public.app_secrets (
  key text primary key,
  value text not null
);

alter table public.challenges enable row level security;
alter table public.checkins enable row level security;
alter table public.reminder_settings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_secrets enable row level security;

revoke all on public.app_secrets from anon, authenticated;
revoke all on public.challenges, public.checkins, public.reminder_settings, public.push_subscriptions from anon;

create policy "challenges: own select" on public.challenges for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "challenges: own insert" on public.challenges for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "challenges: own update" on public.challenges for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "challenges: own delete" on public.challenges for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "checkins: own select" on public.checkins for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "checkins: own insert" on public.checkins for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.challenges c where c.id = challenge_id and c.user_id = (select auth.uid()))
  );
create policy "checkins: own delete" on public.checkins for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "reminders: own select" on public.reminder_settings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "reminders: own insert" on public.reminder_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "reminders: own update" on public.reminder_settings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "push: own select" on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "push: own delete" on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Replace the active challenge atomically (runs with the caller's rights, so RLS applies).
create or replace function public.start_challenge(p_name text, p_title text, p_days integer, p_start date)
returns public.challenges
language plpgsql
security invoker
set search_path = ''
as $$
declare r public.challenges;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.challenges set active = false where user_id = auth.uid() and active;
  insert into public.challenges (user_id, name, title, days, start_date)
    values (auth.uid(), btrim(p_name), btrim(p_title), p_days, p_start)
    returning * into r;
  return r;
end $$;
revoke execute on function public.start_challenge(text, text, integer, date) from public, anon;
grant execute on function public.start_challenge(text, text, integer, date) to authenticated;

-- Register this device for push. An endpoint belongs to one account at a time.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint !~ '^https://' or char_length(p_endpoint) > 2048 then raise exception 'invalid endpoint'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end $$;
revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- Who needs a reminder right now: reminders on, inside the 3-hour window after their
-- reminder time (in their own time zone), not reminded yet today, an active challenge
-- running today, no check-in for today, and at least one registered device.
create or replace function public.due_reminders()
returns table (user_id uuid, title text, name text, day_number integer, days integer, local_day date)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, c.title, c.name, (l.ts::date - c.start_date + 1)::integer, c.days, l.ts::date
  from public.reminder_settings r
  cross join lateral (select (now() at time zone r.timezone) as ts) l
  join public.challenges c on c.user_id = r.user_id and c.active
  where r.enabled
    and r.timezone in (select tz.name from pg_catalog.pg_timezone_names tz)
    and l.ts >= l.ts::date + r.remind_at
    and l.ts <  l.ts::date + r.remind_at + interval '3 hours'
    and (r.last_sent_on is null or r.last_sent_on < l.ts::date)
    and l.ts::date >= c.start_date
    and l.ts::date <  c.start_date + c.days
    and not exists (select 1 from public.checkins k where k.challenge_id = c.id and k.day = l.ts::date)
    and exists (select 1 from public.push_subscriptions s where s.user_id = r.user_id);
$$;
revoke execute on function public.due_reminders() from public, anon, authenticated;
grant execute on function public.due_reminders() to service_role;

insert into public.app_secrets (key, value)
values ('cron_secret', encode(extensions.gen_random_bytes(24), 'hex'));
