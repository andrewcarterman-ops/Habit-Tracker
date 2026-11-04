// Consistency Clock push sender (Supabase Edge Function "push").
//
// POST { action: "vapid" }  -> { publicKey }            (public; creates the VAPID key pair on first use)
// POST { action: "test" }   -> { sent }                 (signed-in user; pushes to their own devices)
// POST { action: "cron" }   -> { due, sent, removed }   (pg_cron only; header x-cron-secret must match)
//
// VAPID keys and the cron token live in public.app_secrets, which only the service role can read.
// Deployed with verify_jwt = false because this function checks callers itself.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const SUBJECT = "https://andrewcarterman-ops.github.io/Habit-Tracker/";
const APP_URL = "./";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function secret(key: string): Promise<string | null> {
  const { data, error } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

let vapid: { publicKey: string; privateKey: string } | null = null;
async function getVapid() {
  if (vapid) return vapid;
  let pub = await secret("vapid_public");
  let priv = await secret("vapid_private");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // ignoreDuplicates: if two cold starts race, the first pair wins and both re-read it
    const { error } = await admin.from("app_secrets").upsert(
      [{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }],
      { onConflict: "key", ignoreDuplicates: true },
    );
    if (error) throw error;
    pub = await secret("vapid_public");
    priv = await secret("vapid_private");
  }
  vapid = { publicKey: pub!, privateKey: priv! };
  return vapid;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendToUser(userId: string, payload: Record<string, unknown>) {
  const keys = await getVapid();
  const { data: subs, error } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", userId);
  if (error) throw error;
  let sent = 0, removed = 0;
  for (const s of (subs ?? []) as Sub[]) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 4 * 3600, urgency: "high", vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey } },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { // device unsubscribed or app removed
        await admin.from("push_subscriptions").delete().eq("id", s.id);
        removed++;
      } else {
        console.error("push failed", code, (e as Error).message);
      }
    }
  }
  return { sent, removed };
}

async function runCron() {
  const { data: due, error } = await admin.rpc("due_reminders");
  if (error) throw error;
  let sent = 0, removed = 0;
  for (const r of due ?? []) {
    const res = await sendToUser(r.user_id, {
      title: r.title,
      body: `Day ${r.day_number} of ${r.days}: you haven’t checked in yet. Open the clock and tap to keep your streak.`,
      tag: "daily-reminder",
      url: APP_URL,
    });
    sent += res.sent; removed += res.removed;
    if (res.sent > 0) {
      await admin.from("reminder_settings").update({ last_sent_on: r.local_day }).eq("user_id", r.user_id);
    }
  }
  return { due: (due ?? []).length, sent, removed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  try {
    if (body.action === "vapid") {
      const { publicKey } = await getVapid();
      return json({ publicKey });
    }

    if (body.action === "cron") {
      const expected = await secret("cron_secret");
      if (!expected || req.headers.get("x-cron-secret") !== expected) return json({ error: "Forbidden." }, 403);
      return json(await runCron());
    }

    if (body.action === "test") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) return json({ error: "Sign in first." }, 401);
      const res = await sendToUser(data.user.id, {
        title: "Consistency Clock",
        body: "Test notification. Your daily reminder will look like this.",
        tag: "test",
        url: APP_URL,
        badge: false,
      });
      return json(res);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error." }, 500);
  }
});
