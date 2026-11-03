# Consistency Clock

A personal challenge countdown installed on iPhone as a Home Screen web app (PWA).
One person, one active challenge, one check-in per local calendar day, a streak, history,
completion screen, and a push reminder on days without a check-in.

## Layout

- `index.html`, `styles.css`, `app.js`: the whole app. Plain HTML/CSS/JS, no build step.
- `config.js`: Supabase URL and publishable key (public by design; RLS protects data).
- `sw.js`: service worker. Offline app shell, push display, notification tap.
- `manifest.webmanifest`, `icons/`: install metadata. Regenerate PNGs from `icons/icon.svg`.
- `vendor/supabase-2.117.3.js`: pinned supabase-js UMD build (global `supabase`).
- `supabase/migrations/`: database schema, RLS policies, RPCs, reminder cron job.
- `supabase/functions/push/index.ts`: Edge Function that sends Web Push (VAPID keys live in `public.app_secrets`).
- `.github/workflows/pages.yml`: deploys the site to GitHub Pages on every push to `main`.

## Rules that must not break

- The big clock shows exactly `HH:MM:SS`, numeric, zero-padded, computed directly
  (`daysRemaining = ceil(total/86400)`, `hours = floor(total%86400/3600)`, …), clamped at 0.
  No days in the clock, no AM/PM, no date-format strings. `N DAYS LEFT` sits directly below it.
- Dates are the person's local calendar date (`keyOf(new Date())`). One check-in per day is
  enforced by the `checkins` primary key `(challenge_id, day)`.
- Never claim a check-in succeeded before the Supabase write resolves.
- No social features: no community counts, leaderboards, teams, or other people's activity.
- The clock screen stays still; richer motion only on setup/sign-in. Respect reduced motion.

## Supabase

- Project ref `ectmsbjzwnazymjsucyb` (region eu-central-1).
- Tables: `challenges`, `checkins`, `reminder_settings`, `push_subscriptions`, `app_secrets` (service role only).
- RPCs: `start_challenge` (replace active challenge), `save_push_subscription`, `due_reminders` (service role only).
- `pg_cron` job `send-reminders` runs every 10 minutes and POSTs `{action:"cron"}` to the `push` function
  with header `x-cron-secret` from `app_secrets`.
- The `push` function is deployed with `verify_jwt = false`; it authenticates callers itself.
- Schema changes: add a new file in `supabase/migrations/` and apply it to the project.
  Run the Supabase security advisors afterwards.

## Shipping a change

1. Edit files, then bump `VERSION` in `sw.js` so installed apps fetch the new build.
2. Push to `main`; GitHub Actions deploys to Pages in about a minute.
3. If `supabase/functions/push/index.ts` changed, redeploy the `push` Edge Function.
