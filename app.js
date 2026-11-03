(() => {
"use strict";

const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

/* ======================= date helpers (local calendar) ======================= */
const pad2 = (n) => {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) n = 0;
  return n < 10 ? "0" + n : String(n);
};
const keyOf = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
const parseKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) ? d : null;
};
const addDays = (k, n) => { const d = parseKey(k); return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
const todayKey = () => keyOf(new Date());
const dayIndex = (startKey, k) => { // whole calendar days between two keys (DST safe)
  const a = parseKey(startKey), b = parseKey(k);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
};
const endTime = (ch) => { const s = parseKey(ch.startDate); return new Date(s.getFullYear(), s.getMonth(), s.getDate() + ch.days).getTime(); };
const fmtShort = (k) => parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtLong = (k) => parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/* ======================= challenge math ======================= */
function remaining(ch, now) {
  let total = Math.floor((endTime(ch) - now) / 1000);
  if (!Number.isFinite(total) || total < 0) total = 0;
  return {
    total,
    days: Math.ceil(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}
const lastDayKey = (ch) => addDays(ch.startDate, ch.days - 1);
const isActiveDay = (ch, k) => { const i = dayIndex(ch.startDate, k); return i >= 0 && i < ch.days; };
function currentStreak(set, today) {
  let k = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(k)) { n++; k = addDays(k, -1); }
  return n;
}
function longestStreak(set) {
  const keys = [...set].sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) { run = (prev && addDays(prev, 1) === k) ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  return best;
}

/* ======================= storage: Supabase + local cache ======================= */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const check = ({ data, error }) => { if (error) throw error; return data; };
const fromRow = (r) => r && { id: r.id, name: r.name, title: r.title, days: r.days, startDate: r.start_date };

const cache = {
  key: () => "consistency-clock.cache." + (S.user ? S.user.id : "anon"),
  read() {
    try {
      const o = JSON.parse(localStorage.getItem(this.key()) || "null");
      if (!o || !validChallenge(o.challenge)) return null;
      return { challenge: o.challenge, checkins: new Set((o.checkins || []).filter((k) => parseKey(k))) };
    } catch (e) { return null; }
  },
  write() {
    try {
      if (!S.challenge) { localStorage.removeItem(this.key()); return; }
      localStorage.setItem(this.key(), JSON.stringify({ challenge: S.challenge, checkins: [...S.checkins] }));
    } catch (e) {}
  },
  clearAll() {
    try { Object.keys(localStorage).filter((k) => k.startsWith("consistency-clock.")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
  },
};

const store = {
  async load() {
    const row = check(await withTimeout(
      sb.from("challenges").select("id,name,title,days,start_date").eq("active", true).maybeSingle(), 12000));
    const ch = fromRow(row);
    const set = new Set();
    if (ch) {
      const rows = check(await withTimeout(sb.from("checkins").select("day").eq("challenge_id", ch.id), 12000));
      rows.forEach((r) => { if (parseKey(r.day)) set.add(r.day); });
    }
    return { challenge: ch, checkins: set };
  },
  async startChallenge({ name, title, days, startDate }) {
    const row = check(await withTimeout(
      sb.rpc("start_challenge", { p_name: name, p_title: title, p_days: days, p_start: startDate }), 12000));
    return fromRow(Array.isArray(row) ? row[0] : row);
  },
  async addCheckin(ch, day) {
    // primary key (challenge_id, day): a repeated save can never create a second row
    check(await withTimeout(
      sb.from("checkins").upsert({ challenge_id: ch.id, day }, { onConflict: "challenge_id,day", ignoreDuplicates: true }), 12000));
  },
};

function validChallenge(c) {
  return !!(c && typeof c === "object" && typeof c.id === "string" && c.id &&
    typeof c.name === "string" && c.name.trim() &&
    typeof c.title === "string" && c.title.trim() &&
    Number.isInteger(c.days) && c.days > 0 && parseKey(c.startDate));
}

/* ======================= state ======================= */
const S = {
  user: null,
  challenge: null,
  checkins: new Set(),
  saving: false,
  lastError: null,
  view: null,
  today: todayKey(),
};
const $ = (id) => document.getElementById(id);
const reduceMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ======================= views ======================= */
const VIEWS = ["loading", "auth", "setup", "clock", "history", "complete"];
function show(name, { iris = true } = {}) {
  const prev = S.view;
  S.view = name;
  for (const v of VIEWS) $(v).hidden = v !== name;
  $("space").hidden = name === "setup" || name === "auth";
  const el = $(name);
  el.classList.remove("iris-in");
  if (iris && prev && prev !== name && prev !== "loading" && !reduceMotion()) { void el.offsetWidth; el.classList.add("iris-in"); }
  if (name === "clock") { renderClock(true); requestAnimationFrame(fitClock); }
  if (name === "history") renderHistory();
  if (name === "complete") renderComplete();
}
const homeView = () => (S.challenge ? (remaining(S.challenge, Date.now()).total === 0 ? "complete" : "clock") : "setup");

/* ---------- stars: sparse, static, deterministic ---------- */
(function stars() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const host = $("space");
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("i");
    const x = rnd() * 100, y = rnd() * 100;
    if (y > 34 && y < 66 && x > 8 && x < 92) continue; // keep the clock's band clear
    s.style.left = x + "%"; s.style.top = y + "%";
    const big = rnd() > .85;
    s.style.width = s.style.height = big ? "2.5px" : (rnd() > .5 ? "1.5px" : "1px");
    s.style.setProperty("--o", (0.25 + rnd() * 0.55).toFixed(2));
    host.appendChild(s);
  }
})();

/* ======================= auth ======================= */
let authMode = "signin";
function setAuthMode(mode) {
  authMode = mode;
  const up = mode === "signup";
  $("authTitle").textContent = up ? "Create account" : "Sign in";
  $("aSubmit").textContent = up ? "Create account" : "Sign in";
  $("aSwitchText").textContent = up ? "Already have an account?" : "New here?";
  $("aSwitch").textContent = up ? "Sign in" : "Create account";
  $("aPassword").autocomplete = up ? "new-password" : "current-password";
  $("aPassHint").hidden = !up;
  $("aError").textContent = "";
}
function openAuth(message) {
  setAuthMode(authMode);
  $("aInfo").textContent = message || "";
  show("auth");
}
$("aSwitch").addEventListener("click", () => { setAuthMode(authMode === "signup" ? "signin" : "signup"); $("aInfo").textContent = ""; });

function authErrorText(err) {
  const m = String((err && err.message) || "");
  if (/invalid login credentials/i.test(m)) return "That email and password don’t match. Check both and try again.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first: open the link in the message we sent you, then sign in here.";
  if (/already registered/i.test(m)) return "There’s already an account with this email. Sign in instead.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Wait a few minutes and try again.";
  if (/password/i.test(m)) return m;
  if (/fetch|network|timeout/i.test(m)) return "No connection. Check your internet and try again.";
  return m || "Something went wrong. Try again.";
}

$("authForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("aEmail").value.trim();
  const password = $("aPassword").value;
  $("aError").textContent = ""; $("aInfo").textContent = "";
  if (!/^\S+@\S+\.\S+$/.test(email)) { $("aError").textContent = "Enter a valid email address."; $("aEmail").focus(); return; }
  if (password.length < (authMode === "signup" ? 8 : 1)) { $("aError").textContent = authMode === "signup" ? "Use at least 8 characters for your password." : "Enter your password."; $("aPassword").focus(); return; }
  const btn = $("aSubmit");
  btn.disabled = true; btn.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
  try {
    if (authMode === "signup") {
      const data = check(await withTimeout(sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }), 15000));
      if (data.session) { await afterSignIn(data.session.user); return; }
      setAuthMode("signin");
      $("aInfo").textContent = "Check your inbox for a confirmation link and open it. Then come back here and sign in.";
    } else {
      const data = check(await withTimeout(sb.auth.signInWithPassword({ email, password }), 15000));
      await afterSignIn(data.user);
    }
  } catch (e) {
    $("aError").textContent = authErrorText(e);
  } finally {
    btn.disabled = false; btn.textContent = authMode === "signup" ? "Create account" : "Sign in";
  }
});

async function afterSignIn(user) {
  S.user = user;
  await loadData({ showLoading: true });
}

/* ======================= setup ======================= */
let chosenDays = "30";
function openSetup({ cancellable = false } = {}) {
  $("fStart").value = todayKey();
  clearSetupErrors();
  if (S.challenge) $("fName").value = S.challenge.name;
  $("fChallenge").value = "";
  setChip("30");
  $("setupCancel").hidden = !cancellable;
  show("setup");
  setTimeout(() => { (!$("fName").value ? $("fName") : $("fChallenge")).focus({ preventScroll: true }); }, reduceMotion() ? 0 : 500);
}
function clearSetupErrors() {
  ["eName", "eChallenge", "eDays", "eStart", "eSave"].forEach((id) => ($(id).textContent = ""));
  ["fName", "fChallenge", "fDays", "fStart"].forEach((id) => $(id).removeAttribute("aria-invalid"));
}
function setChip(v) {
  chosenDays = v;
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.days === v)));
  $("customDaysWrap").hidden = v !== "custom";
}
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
  setChip(c.dataset.days);
  if (c.dataset.days === "custom") $("fDays").focus();
}));
$("setupCancel").addEventListener("click", () => show(homeView()));

$("setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (S.saving) return;
  const name = $("fName").value.trim().replace(/\s+/g, " ");
  const title = $("fChallenge").value.trim().replace(/\s+/g, " ");
  const start = $("fStart").value || todayKey();
  const days = chosenDays === "custom" ? $("fDays").value.trim() : chosenDays;
  let ok = true;
  const fail = (f, e, msg) => { ok = false; $(e).textContent = msg; $(f).setAttribute("aria-invalid", "true"); };
  clearSetupErrors();
  if (!name) fail("fName", "eName", "Enter your name.");
  if (!title) fail("fChallenge", "eChallenge", "Describe the challenge you’re committing to.");
  if (!/^\d+$/.test(String(days)) || +days < 1 || +days > 3650) fail("fDays", "eDays", "Enter a whole number of days from 1 to 3650.");
  if (!parseKey(start)) fail("fStart", "eStart", "Choose a valid start date.");
  else if (/^\d+$/.test(String(days)) && endTime({ startDate: start, days: +days }) <= Date.now()) fail("fStart", "eStart", "That start date and length ended already. Pick a later start date.");
  if (!ok) { const first = document.querySelector("#setupForm [aria-invalid=true]"); if (first) first.focus(); return; }

  S.saving = true;
  $("setupSubmit").disabled = true;
  $("setupSubmit").textContent = "Saving…";
  try {
    const ch = await store.startChallenge({ name, title, days: +days, startDate: start });
    if (!validChallenge(ch)) throw new Error("bad response");
    S.challenge = ch; S.checkins = new Set(); S.lastError = null;
    cache.write();
    show("clock");
  } catch (e) {
    $("eSave").textContent = "Your challenge wasn’t saved. Check your connection and try again.";
  } finally {
    S.saving = false;
    $("setupSubmit").disabled = false;
    $("setupSubmit").textContent = "Start the clock";
  }
});

/* ======================= clock ======================= */
const digitEls = [...document.querySelectorAll("#clockRow .d")];
let lastDigits = "";
let capRatio = 0.7, bearing = 0.03;

function measureFont() {
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.font = '600 100px "Barlow Condensed", "Arial Narrow", sans-serif';
    const m = c.measureText("0");
    if (m.actualBoundingBoxAscent) capRatio = m.actualBoundingBoxAscent / 100;
    if (m.actualBoundingBoxLeft !== undefined) bearing = Math.max(0, (m.width - (m.actualBoundingBoxRight + m.actualBoundingBoxLeft)) / 2 / 100);
  } catch (e) {}
  $("clockRow").style.setProperty("--cap", capRatio.toFixed(3));
}

function fitClock() {
  if (S.view !== "clock") return;
  const row = $("clockRow"), stage = $("stage");
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  row.style.setProperty("--fs", "100px");
  const w100 = row.getBoundingClientRect().width - 2 * bearing * 100; // visible ink width at 100px
  if (!w100) return;
  // where the baseline falls inside a digit box, so the colon dots track the numerals
  try {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    digitEls[0].appendChild(probe);
    const base = (probe.getBoundingClientRect().top - digitEls[0].getBoundingClientRect().top) / 100;
    probe.remove();
    if (base > 0.3 && base < 1.2) row.style.setProperty("--base", base.toFixed(3));
  } catch (e) {}
  const gutter = Math.max(16, (vw - $("clock").clientWidth) / 2 + 16);
  const target = vw >= 760 ? vw * 0.88 : vw - gutter * 2 + 6;
  let fs = (target / w100) * 100;
  // digit height: up to 68% of the viewport, leaving room for the DAYS LEFT label
  const daysH = $("daysLeft").getBoundingClientRect().height + 20;
  const maxCap = Math.min(vh * 0.68, Math.max(40, stage.clientHeight - daysH - 12));
  fs = Math.min(fs, maxCap / capRatio);
  row.style.setProperty("--fs", fs.toFixed(2) + "px");
}

function renderClock(force) {
  const ch = S.challenge;
  if (!ch) return;
  const r = remaining(ch, Date.now());
  const str = pad2(r.h) + pad2(r.m) + pad2(r.s);
  if (str !== lastDigits || force) {
    for (let i = 0; i < 6; i++) {
      const el = digitEls[i], v = str[i];
      if (el.dataset.v !== v || force) {
        el.textContent = v; el.dataset.v = v;
        if (!force && !reduceMotion()) { el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick"); }
      }
    }
    lastDigits = str;
    $("clockRow").setAttribute("aria-label", pad2(r.h) + ":" + pad2(r.m) + ":" + pad2(r.s) + " remaining");
  }
  $("daysNum").textContent = String(r.days);
  $("daysWord").textContent = r.days === 1 ? "DAY" : "DAYS";

  const tk = todayKey();
  if (force || tk !== S.today) { S.today = tk; renderStatus(); }
  if (r.total === 0 && S.view === "clock") show("complete");
}

function dayLabel(ch, tk) {
  const i = dayIndex(ch.startDate, tk);
  if (i < 0) return "Starts " + fmtShort(ch.startDate);
  if (i >= ch.days) return ch.days + "-day challenge";
  return "Day " + (i + 1) + " of " + ch.days;
}

function renderStatus() {
  const ch = S.challenge; if (!ch) return;
  const tk = S.today;
  $("cHello").textContent = ch.name + " · " + dayLabel(ch, tk);
  $("cTitle").textContent = ch.title;
  const streak = currentStreak(S.checkins, tk);
  $("streakNum").firstChild.nodeValue = String(streak);
  $("streakUnit").textContent = streak === 1 ? "DAY" : "DAYS";

  const btn = $("checkinBtn"), pill = $("todayPill");
  const idx = dayIndex(ch.startDate, tk);
  let s, label, pillText;
  if (S.saving) { s = "saving"; label = '<span class="spin" aria-hidden="true"></span>Saving check-in…'; pillText = "Saving"; }
  else if (S.checkins.has(tk)) { s = "done"; label = "You showed up today"; pillText = "Checked in"; }
  else if (idx < 0) { s = "locked"; label = "Starts " + fmtShort(ch.startDate); pillText = "Not started"; }
  else if (idx >= ch.days) { s = "locked"; label = "Challenge ended"; pillText = "Ended"; }
  else if (S.lastError) { s = "error"; label = "Not saved · Tap to retry"; pillText = "Not saved"; }
  else { s = "open"; label = "Tap anywhere to check in"; pillText = "Not yet"; }
  btn.dataset.s = s; btn.innerHTML = label;
  btn.setAttribute("aria-disabled", String(s === "saving" || s === "done" || s === "locked"));
  pill.dataset.s = s === "done" ? "done" : s === "error" ? "error" : s === "open" ? "open" : "idle";
  pill.textContent = pillText;
  $("clock").style.cursor = (s === "open" || s === "error") ? "pointer" : "default";
}

async function checkIn() {
  const ch = S.challenge;
  if (!ch || S.saving) return;
  const tk = todayKey();
  S.today = tk;
  if (S.checkins.has(tk) || !isActiveDay(ch, tk)) { renderStatus(); return; }
  S.saving = true; S.lastError = null;
  renderStatus();
  try {
    await store.addCheckin(ch, tk);
    S.checkins.add(tk);
    cache.write();
    S.saving = false;
    renderStatus();
    const streak = currentStreak(S.checkins, tk);
    toast(streak > 1 ? "Checked in · " + streak + "-day streak" : "Checked in · You showed up today");
    halo();
    if (navigator.setAppBadge) { try { navigator.clearAppBadge(); } catch (e) {} }
  } catch (e) {
    S.saving = false;
    S.lastError = e || new Error("unknown");
    renderStatus();
    toast(navigator.onLine === false ? "Not saved · You’re offline. Tap again when you’re back online" : "Check-in not saved · Check your connection and tap again", true);
  }
}

$("checkinBtn").addEventListener("click", (e) => { e.stopPropagation(); checkIn(); });
$("clock").addEventListener("click", (e) => {
  if (e.target.closest("button, a, input")) return;
  checkIn();
});
$("toHistory").addEventListener("click", (e) => { e.stopPropagation(); show("history"); });
$("toMenu").addEventListener("click", (e) => { e.stopPropagation(); openSettings(); });

let toastTimer;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 5200 : 3200);
}
function halo() {
  if (reduceMotion()) return;
  const h = $("halo"); h.classList.remove("go"); void h.offsetWidth; h.classList.add("go");
}

/* ======================= history ======================= */
$("hBack").addEventListener("click", () => show(homeView()));
function renderHistory() {
  const ch = S.challenge; if (!ch) return;
  const tk = todayKey();
  $("hHello").textContent = ch.name + " · " + dayLabel(ch, tk);
  $("hTitle").textContent = ch.title;
  $("hRange").textContent = ch.days + " days · " + fmtLong(ch.startDate) + " – " + fmtLong(lastDayKey(ch));
  const inRange = [...S.checkins].filter((k) => isActiveDay(ch, k));
  const todayIdx = dayIndex(ch.startDate, tk);
  let missed = 0;
  const grid = $("hGrid"); grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < ch.days; i++) {
    const k = addDays(ch.startDate, i);
    const li = document.createElement("li");
    const done = S.checkins.has(k);
    let cls = "cell", state;
    if (done) { cls += " done"; state = "Checked in"; }
    else if (i < todayIdx) { cls += " miss"; state = "Missed"; missed++; }
    else if (i === todayIdx) { state = "Today"; }
    else { cls += " future"; state = "Upcoming"; }
    if (i === todayIdx) cls += " today";
    li.className = cls;
    li.innerHTML = '<span class="n"></span><span class="dt"></span>';
    li.querySelector(".n").textContent = String(i + 1);
    li.querySelector(".dt").textContent = done ? "✓ " + fmtShort(k) : fmtShort(k);
    li.setAttribute("aria-label", "Day " + (i + 1) + ", " + fmtLong(k) + ": " + state);
    frag.appendChild(li);
  }
  grid.appendChild(frag);
  $("hCount").textContent = String(inRange.length);
  $("hStreak").textContent = String(currentStreak(S.checkins, tk));
  $("hLongest").textContent = String(longestStreak(new Set(inRange)));
  $("hMissed").textContent = String(missed);
  const empty = $("hEmpty");
  if (inRange.length === 0) {
    empty.hidden = false;
    empty.textContent = todayIdx < 0
      ? "Your challenge starts " + fmtLong(ch.startDate) + ". Check-ins open on day one."
      : "No check-ins yet. Go back to the clock and tap anywhere to log today.";
  } else empty.hidden = true;
}

/* ======================= completion ======================= */
function renderComplete() {
  const ch = S.challenge; if (!ch) return;
  const inRange = [...S.checkins].filter((k) => isActiveDay(ch, k));
  $("xHello").textContent = ch.name + " · Challenge complete";
  $("xTitle").textContent = ch.title;
  $("xLen").textContent = String(ch.days);
  $("xCount").textContent = String(inRange.length) + " / " + ch.days;
  $("xLongest").textContent = String(longestStreak(new Set(inRange)));
}
$("xNew").addEventListener("click", () => openSetup({ cancellable: true }));
$("xHistory").addEventListener("click", () => show("history"));

/* ======================= settings + reminders ======================= */
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let reminder = { enabled: false, remind_at: "20:00" };
let vapidKey = null;
let settingsReturnFocus = null;

function openSettings() {
  settingsReturnFocus = document.activeElement;
  $("settings").hidden = false;
  $("replaceIdle").hidden = false; $("replaceConfirm").hidden = true;
  $("sReplace").disabled = !S.challenge;
  $("sEmail").textContent = S.user && S.user.email ? "Signed in as " + S.user.email : "";
  $("rError").textContent = "";
  renderReminder();
  loadReminder();
  if (pushSupported() && !vapidKey) getVapidKey().catch(() => {});
  $("sClose").focus();
}
function closeSettings() {
  $("settings").hidden = true;
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
}
$("sClose").addEventListener("click", closeSettings);
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settings").hidden) closeSettings(); });

$("sReplace").addEventListener("click", () => {
  $("sReplaceName").textContent = "“" + S.challenge.title + "”";
  $("replaceIdle").hidden = true; $("replaceConfirm").hidden = false;
  $("sReplaceNo").focus();
});
$("sReplaceNo").addEventListener("click", () => { $("replaceIdle").hidden = false; $("replaceConfirm").hidden = true; $("sReplace").focus(); });
$("sReplaceYes").addEventListener("click", () => { closeSettings(); openSetup({ cancellable: true }); });

$("sSignOut").addEventListener("click", async () => {
  const btn = $("sSignOut"); btn.disabled = true;
  try {
    const sub = pushSupported() ? await currentSubscription() : null;
    if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe().catch(() => {}); }
  } catch (e) {}
  await sb.auth.signOut().catch(() => {});
  cache.clearAll();
  S.user = null; S.challenge = null; S.checkins = new Set();
  btn.disabled = false;
  closeSettings();
  openAuth("You’re signed out.");
});

async function loadReminder() {
  try {
    const row = check(await withTimeout(sb.from("reminder_settings").select("enabled,remind_at").maybeSingle(), 10000));
    if (row) reminder = { enabled: row.enabled, remind_at: String(row.remind_at).slice(0, 5) };
    renderReminder();
  } catch (e) { /* keep what is on screen */ }
}

function permissionState() { return "Notification" in window ? Notification.permission : "unsupported"; }

function renderReminder(statusOverride) {
  const en = $("rEnabled"), time = $("rTime"), status = $("rStatus"), test = $("rTest");
  time.value = reminder.remind_at || "20:00";
  const perm = permissionState();
  let msg = "";
  if (!pushSupported()) {
    en.checked = false; en.disabled = true; time.disabled = true; test.disabled = true;
    msg = isIOS() && !isStandalone()
      ? "To get reminders on iPhone, add this app to your Home Screen first: tap Share, then “Add to Home Screen”, and open it from there."
      : "This browser can’t show notifications.";
  } else if (perm === "denied") {
    en.checked = false; en.disabled = true; time.disabled = true; test.disabled = true;
    msg = isIOS()
      ? "Notifications are turned off for this app. Turn them on in the iPhone Settings app under Notifications → Clock."
      : "Notifications are blocked for this site. Allow them in your browser’s site settings.";
  } else {
    en.disabled = false; time.disabled = false;
    en.checked = !!reminder.enabled && perm === "granted";
    test.disabled = !(en.checked);
    msg = en.checked
      ? "On. You’ll be reminded at " + time.value + " on days you haven’t checked in."
      : "Off.";
  }
  status.textContent = statusOverride || msg;
}

async function getVapidKey() {
  if (vapidKey) return vapidKey;
  try { vapidKey = localStorage.getItem("consistency-clock.vapid") || null; } catch (e) {}
  if (vapidKey) return vapidKey;
  const data = check(await withTimeout(sb.functions.invoke(CFG.pushFunction, { body: { action: "vapid" } }), 15000));
  if (!data || !data.publicKey) throw new Error("no key");
  vapidKey = data.publicKey;
  try { localStorage.setItem("consistency-clock.vapid", vapidKey); } catch (e) {}
  return vapidKey;
}
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function ensureSubscription() {
  const reg = await withTimeout(navigator.serviceWorker.ready, 10000);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const key = await getVapidKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  }
  const j = sub.toJSON();
  check(await withTimeout(sb.rpc("save_push_subscription", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }), 12000));
  return sub;
}
async function saveReminder(patch) {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || "Europe/Berlin";
  const next = { ...reminder, ...patch };
  check(await withTimeout(sb.from("reminder_settings").upsert({
    user_id: S.user.id, enabled: !!next.enabled, remind_at: next.remind_at, timezone: tz, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" }), 12000));
  reminder = next;
}

$("rEnabled").addEventListener("change", async (e) => {
  const en = e.target;
  $("rError").textContent = "";
  en.disabled = true;
  try {
    if (en.checked) {
      // ask first, straight from the tap: iOS only shows the prompt for a direct user action
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm !== "granted") { reminder.enabled = false; renderReminder(); return; }
      renderReminder("Registering this device…");
      await ensureSubscription();
      await saveReminder({ enabled: true, remind_at: $("rTime").value || "20:00" });
      toast("Reminders on · " + reminder.remind_at);
    } else {
      await saveReminder({ enabled: false });
      toast("Reminders off");
    }
  } catch (err) {
    en.checked = !en.checked;
    $("rError").textContent = "Your reminder setting wasn’t saved. Check your connection and try again.";
  } finally {
    en.disabled = false;
    renderReminder();
  }
});

$("rTime").addEventListener("change", async () => {
  const v = $("rTime").value;
  if (!/^\d{2}:\d{2}$/.test(v)) return;
  $("rError").textContent = "";
  try {
    await saveReminder({ remind_at: v });
    renderReminder();
    toast("Reminder time · " + v);
  } catch (e) {
    $("rError").textContent = "The new time wasn’t saved. Check your connection and try again.";
  }
});

$("rTest").addEventListener("click", async () => {
  const btn = $("rTest");
  btn.disabled = true; $("rError").textContent = "";
  try {
    await ensureSubscription();
    const data = check(await withTimeout(sb.functions.invoke(CFG.pushFunction, { body: { action: "test" } }), 20000));
    if (data && data.sent > 0) toast("Test sent · It should arrive in a few seconds");
    else $("rError").textContent = "No registered device was reached. Turn reminders off and on again, then retry.";
  } catch (e) {
    $("rError").textContent = "The test notification couldn’t be sent. Check your connection and try again.";
  } finally {
    btn.disabled = false;
  }
});

// keep this device's push registration fresh (endpoints can rotate)
async function refreshPushQuietly() {
  if (!pushSupported() || permissionState() !== "granted" || !S.user) return;
  try {
    const row = check(await sb.from("reminder_settings").select("enabled,remind_at").maybeSingle());
    if (row) reminder = { enabled: row.enabled, remind_at: String(row.remind_at).slice(0, 5) };
    if (row && row.enabled) await ensureSubscription();
  } catch (e) {}
}

/* ======================= ticking ======================= */
function scheduleTick() {
  const delay = 1000 - (Date.now() % 1000) + 8;
  setTimeout(() => {
    if (S.view === "clock") renderClock(false);
    else if (S.view === "history" && todayKey() !== S.today) { S.today = todayKey(); renderHistory(); }
    scheduleTick();
  }, delay);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (S.view === "clock") renderClock(true);
  if (S.user && (S.view === "clock" || S.view === "history")) loadData({ showLoading: false }); // pick up check-ins from other devices
});
let resizeRaf;
window.addEventListener("resize", () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(fitClock); });
if (window.ResizeObserver) new ResizeObserver(() => fitClock()).observe($("stage"));

/* ======================= boot ======================= */
let loading = false;
async function loadData({ showLoading }) {
  if (loading) return;
  loading = true;
  const cached = cache.read();
  if (showLoading) {
    if (cached) { S.challenge = cached.challenge; S.checkins = cached.checkins; show(homeView(), { iris: false }); }
    else showLoadingView();
  }
  try {
    const data = await store.load();
    if (!S.saving) {
      const changed = JSON.stringify([data.challenge, [...data.checkins].sort()]) !== JSON.stringify([S.challenge, [...S.checkins].sort()]);
      S.challenge = data.challenge; S.checkins = data.checkins;
      cache.write();
      if (S.view === "loading" || S.view === "auth" || (changed && S.view !== "setup")) {
        if (!S.challenge) openSetup(); else show(homeView(), { iris: S.view !== "loading" && S.view !== "clock" });
      } else if (S.view === "history") renderHistory();
      else if (S.view === "clock") renderStatus();
    }
    refreshPushQuietly();
  } catch (e) {
    if (S.view === "loading") {
      $("loadSpinner").hidden = true; $("loadText").hidden = true;
      $("loadError").hidden = false; $("loadRetry").hidden = false;
      $("loadError").textContent = "Your challenge couldn’t be loaded. Check your connection, then try again.";
    } else if (showLoading) {
      toast("Offline · Showing your last saved progress", true);
    }
  } finally {
    loading = false;
  }
}
function showLoadingView() {
  $("loadSpinner").hidden = false; $("loadText").hidden = false;
  $("loadError").hidden = true; $("loadRetry").hidden = true;
  show("loading", { iris: false });
}
$("loadRetry").addEventListener("click", () => loadData({ showLoading: true }));

sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" && S.user) {
    S.user = null; S.challenge = null; S.checkins = new Set();
    closeSettings();
    openAuth("Your session ended. Sign in again to continue.");
  } else if (session && session.user) {
    S.user = session.user;
  }
});

async function boot() {
  showLoadingView();
  // an email confirmation link can land here with an error in the URL
  const hash = new URLSearchParams(location.hash.slice(1));
  const linkError = hash.get("error_description");
  try { await withTimeout(document.fonts ? document.fonts.ready : Promise.resolve(), 3000); } catch (e) {}
  measureFont();
  let session = null;
  try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
  if (location.hash && /access_token|error/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  if (!session) {
    openAuth(linkError ? "That link didn’t work: " + linkError + ". Sign in, or create the account again." : "");
    return;
  }
  S.user = session.user;
  await loadData({ showLoading: true });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
scheduleTick();
boot();
})();
