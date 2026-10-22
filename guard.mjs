// bet25 API guard: checks that the bet25.com / sportsbook APIs our CMS widgets use still look the
// way the widgets expect, and posts to Slack when they don't.
//
//   node guard.mjs            run the checks, alert Slack on changes (what the hourly job runs)
//   node guard.mjs --dry      run the checks, print the report, send nothing, save nothing
//   node guard.mjs --rebase   accept the current API structure as the new baseline
//   node guard.mjs --test     send a test message to Slack
//
// Settings live in config.json next to this file (login, password, slackWebhook), or in the env vars
// BET25_LOGIN, BET25_PASSWORD, SLACK_WEBHOOK_URL, BET25_SITE (env wins). DATA_DIR is where baseline,
// state and session are kept (default: next to this file; on Render: the persistent disk).
// Two kinds of checks per endpoint:
//   need  - fields the widgets actually read. Missing = the widget breaks -> red alert right away.
//   shape - fingerprint of the whole response (every field path + type). Compared with
//           baseline.json; removed / retyped fields -> orange alert, new fields -> info.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const fileConfig = fs.existsSync(path.join(DIR, "config.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")) : {};
const CONFIG = {
  ...fileConfig,
  ...(env.BET25_SITE && { site: env.BET25_SITE }),
  ...(env.BET25_LOGIN && { login: env.BET25_LOGIN }),
  ...(env.BET25_PASSWORD && { password: env.BET25_PASSWORD }),
  ...(env.SLACK_WEBHOOK_URL && { slackWebhook: env.SLACK_WEBHOOK_URL })
};
const DATA_DIR = env.DATA_DIR || DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const BASELINE_FILE = path.join(DATA_DIR, "baseline.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const SESSION_COOKIES = ["cbsid", "_xsrf", "lang"]; // all bet25 needs; the rest are analytics
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry"), REBASE = args.has("--rebase");

const SITE = CONFIG.site || "https://bet25.com";
// bet25 ties a session to the User-Agent it logged in with, so the UA is saved with the session.
let UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const SECTIONS = { casino: "695fc3d78c3afc04680877a8", live: "68d675e4fe5d760088be4838" };
const LOBBY_ROW = "68d54266131232efdfae2fc5"; // gamesearch.html data-row-id (Recently Played)
const HE_DEFAULT_BRAND = "2558957583637553158"; // he.js DEFAULT_BRAND
// Optional fields come and go with the data (e.g. live odds). A field the widgets don't read must be gone
// this many hourly runs in a row before it is reported, and new fields are learned silently for the
// first day after a baseline is made.
const MISSING_RUNS = 6;
const LEARN_MS = 24 * 3600e3;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

/* ---------- HTTP with a cookie jar ---------- */

const jar = new Map();
const saveCookies = res => {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(";"); const i = kv.indexOf("=");
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
};
let xsrf = "", sid = "";
async function http(url, { method = "GET", body, site = true, text = false } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json, text/plain, */*" };
  if (site) Object.assign(headers, {
    "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest",
    Referer: SITE + "/", Origin: SITE, "X-Jsapi-Lang": "en",
    Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ")
  }, sid && { "X-Sid": sid }, xsrf && { "X-Xsrftoken": xsrf });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
  let res;
  // Redirects by hand: bet25 sets cookies on the redirect itself, which fetch would drop (and loop).
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(url, { method, headers, body: body && JSON.stringify(body), signal: ac.signal, redirect: site ? "manual" : "follow" });
      if (!site || res.status < 300 || res.status > 399 || hop > 5) break;
      saveCookies(res);
      headers.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
      url = new URL(res.headers.get("location"), url).href;
      if (res.status !== 307 && res.status !== 308) { method = "GET"; body = undefined; }
    }
  }
  catch (e) { throw new Error(`${method} ${short(url)}: ${e.name === "AbortError" ? "timed out after 30 s" : e.message + (e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : "")}`); }
  finally { clearTimeout(t); }
  if (site) saveCookies(res);
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${short(url)}: HTTP ${res.status} ${raw.slice(0, 120).replace(/\s+/g, " ")}`);
  if (text) return raw;
  let j; try { j = JSON.parse(raw); } catch { throw new Error(`${method} ${short(url)}: not JSON (${raw.slice(0, 80).replace(/\s+/g, " ")})`); }
  if (j && j.meta && j.meta._xsrf) xsrf = j.meta._xsrf;
  return j;
}
const short = u => u.replace(SITE, "").replace(/^https:\/\/api-[\w-]+\.sptpub\.com/, "<sptpub>").slice(0, 110);
const jsapi = (p, body) => http(SITE + p, body ? { method: "POST", body: { ...body, _xsrf: xsrf } } : {});

/* ---------- structure fingerprint ---------- */

// Object keys that are ids (event ids, market ids, timestamps…) are folded into one "{#}" entry so
// the fingerprint describes the structure, not the data.
// Specifier keys like "total=235.5" or "variant=tt:markettext:27…" are ids too.
const isIdKey = k => /^\d+$/.test(k) || k.includes("=") || /\d{4,}/.test(k) || /^(?=.*\d)[0-9a-f]{6,}$/.test(k) || /^[0-9a-f-]{36}$/.test(k);
const typeOf = v => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
function shape(v, p = "$", out = {}, depth = 0) {
  const t = typeOf(v);
  (out[p] ||= new Set()).add(t);
  if (depth > 12) return out;
  if (t === "array") v.slice(0, 200).forEach(x => shape(x, p + "[]", out, depth + 1));
  else if (t === "object") {
    for (const k in v) shape(v[k], p + "." + (isIdKey(k) ? "{#}" : k === "" ? '[""]' : k), out, depth + 1);
  }
  return out;
}
const flat = s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v].sort()]));

// Does the value at a "need" path exist (and is it non-empty) anywhere in the response?
function lookup(v, parts) {
  if (!parts.length) return [v];
  const [h, ...rest] = parts;
  if (v == null || typeof v !== "object") return [];
  if (h === "[]") return Array.isArray(v) ? v.flatMap(x => lookup(x, rest)) : [];
  if (h === "{#}") return Object.values(v).flatMap(x => lookup(x, rest));
  return h in v ? lookup(v[h], rest) : [];
}
const splitPath = p => p.replace(/^\$\.?/, "").replace(/\[\]/g, ".[]").split(".").filter(Boolean).map(x => x === '[""]' ? "" : x);
function missingNeeds(resp, needs) {
  const out = [];
  for (const n of needs) {
    const [p, rule] = n.split(" ");
    const vals = lookup(resp, splitPath(p));
    const ok = rule === "any" ? vals.length > 0
      : rule === "array" ? vals.some(Array.isArray)
      : rule === "obj" ? vals.some(v => v && typeof v === "object")
      : vals.some(v => v !== undefined && v !== null && v !== "");
    if (!ok) out.push(p);
  }
  return out;
}

/* ---------- the checks: one per endpoint, in widget order ---------- */

const GAME = ["slug", "seo_slug", "name", "game_image", "gid", "display_operator", "labels any"];
const game = (pre, extra = []) => [...GAME, ...extra].map(f => pre + "." + f);

async function run() {
  const results = []; // { id, used, resp?, needs, count?, error? }
  const ctx = {};
  let authed = false;
  // loggedIn: the check only makes sense with a session; without one it is skipped, not failed.
  const check = async (id, used, needs, fn, countAt, loggedIn) => {
    if (loggedIn && !authed) return;
    const r = { id, used, needs };
    // One retry after 10 s, so a single slow answer isn't reported as a broken API.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r.resp = await fn();
        if (countAt) r.count = countAt(r.resp);
        delete r.error;
        break;
      } catch (e) { r.error = e.message; if (!attempt) await new Promise(ok => setTimeout(ok, 10000)); }
    }
    results.push(r);
    return r.resp;
  };

  // Session: reuse the saved cookies; log in only when they have expired. Logging in every hour
  // makes the site ask for a reCAPTCHA, which a script can't answer.
  const saved = readJSON(SESSION_FILE, {});
  if (saved.ua) UA = saved.ua;
  for (const [k, v] of Object.entries(saved)) if (SESSION_COOKIES.includes(k)) jar.set(k, v);
  const home = await http(SITE + "/", { text: true });
  sid = (home.match(/data-sid="([^"]+)"/) || [])[1] || "";
  authed = !!(await jsapi("/jsapi/user/info")).meta?.auth;
  if (!authed) {
    const j = await jsapi("/jsapi/user/login", { login: CONFIG.login, password: CONFIG.password });
    authed = !!j.meta?.auth;
    if (!authed) ctx.loginError = j.data?.errors?.captcha ? "the site asks for a reCAPTCHA (too many logins from this address)"
      : JSON.stringify(j.data?.errors || j.data || j).slice(0, 200);
  }
  if (authed) { fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...Object.fromEntries(jar), ua: UA })); fs.chmodSync(SESSION_FILE, 0o600); }

  const info = await check("user/info", "game-search (lobby rows)", ["$.data.success", "$.data.user._id", "$.data.user.game_currency"],
    // Only what game-search reads: the rest is the player's profile, which changes all the time.
    () => jsapi("/jsapi/user/info").then(j => ({ data: { success: j.data?.success, user: { _id: j.data?.user?._id, game_currency: j.data?.user?.game_currency } } })),
    null, true);
  const user = info?.data?.user || {};

  await check("games/filters", "game-search (providers picker)",
    ["$.data.items[].slug", "$.data.items[].values array", "$.data.items[].values[].id", "$.data.items[].values[].label", "$.data.items[].values[].icon"],
    async () => {
      const j = await jsapi("/jsapi/v2/games/filters", {});
      if (!(j.data?.items || []).some(f => f.slug === "providers")) throw new Error('no filter group with slug "providers"');
      return j;
    }, j => (j.data.items.find(f => f.slug === "providers")?.values || []).length);

  for (const [label, s, c] of [["casino · Popular", "casino", "Popular"], ["casino · bet25-picks", "casino", "bet25-picks"], ["live · all", "live", "all"]])
    await check(`games/get_by_section (${label})`, c === "bet25-picks" ? "casino-picks, game-search" : "game-search",
      ["$.data.items array", "$.data.items_count any", ...game("$.data.items[]")],
      () => jsapi("/jsapi/v2/games/get_by_section", { section_id: SECTIONS[s], category_name: c, offset: 0, limit: 60 }),
      j => (j.data?.items || []).length, true);

  await check("games/global_search", "game-search (search)",
    ["$.data.games array", "$.data.search_after any", ...game("$.data.games[]", ["section"])],
    () => jsapi("/jsapi/v2/games/global_search", { value: "", filters: {}, limit: 100 }),
    j => (j.data?.games || []).length);

  await check("lobby row (_jsapi/v2/games/main)", "game-search (Recently Played row)", ["$.items array"],
    () => http(`${SITE}/_jsapi/v2/games/main/wlid/bet25/section/${LOBBY_ROW}/platform/1/iso/XX/currency/${user.game_currency || "USD"}/lang/en/player_type/New/uid/${user._id}/`),
    null, true);

  // Sportsbook (hero-he): brand + renderer script from init_data, API host from the renderer.
  const init = await check("init_data", "hero-he (finds sportsbook brand + API)", ["$.spt_renderer_js"], async () => {
    const t = await http(SITE + "/jsapi/init_data", { text: true });
    ctx.brand = (t.match(/"brand_id"\s*:\s*"?(\d{6,})/) || [])[1];
    ctx.js = (t.match(/"spt_renderer_js"\s*:\s*"([^"]+)"/) || [])[1];
    if (!ctx.js) throw new Error('"spt_renderer_js" no longer in init_data - hero-he falls back to its hard-coded API host');
    // Only what hero-he reads; the rest of init_data is site settings that change all the time.
    return { brand_id: ctx.brand ? "present" : "absent", spt_renderer_js: ctx.js };
  });
  // Without brand_id in init_data (the case since at least 2026-10-20) hero-he uses its fallback brand.
  ctx.brand ||= HE_DEFAULT_BRAND;
  if (init) {
    await check("sportsbook renderer script", "hero-he (finds API host)", [], async () => {
      const t = await http(ctx.js, { site: false, text: true });
      ctx.api = (t.match(/https:\/\/api-[\w-]+\.sptpub\.com/) || [])[0];
      if (!ctx.api) throw new Error("no https://api-….sptpub.com address in " + ctx.js);
      return { api_host_found: true };
    });
  }
  if (ctx.api && ctx.brand) {
    const base = ctx.api + "/api";
    for (const kind of ["prematch", "live"]) {
      const url = `${base}/v4/${kind}/brand/${ctx.brand}/widget/en/`;
      const man = await check(`sportsbook ${kind} manifest`, "hero-he", ["$.top_events_versions array", "$.rest_events_versions array"],
        () => http(url + "0", { site: false }));
      if (!man) continue;
      const vers = [].concat(man.top_events_versions || [], man.rest_events_versions || []);
      await check(`sportsbook ${kind} events`, "hero-he (match cards)", [
        "$.events obj", "$.events.{#}.desc.type", "$.events.{#}.desc.scheduled", "$.events.{#}.desc.sport",
        "$.events.{#}.desc.category", "$.events.{#}.desc.tournament", "$.events.{#}.desc.slug",
        "$.events.{#}.desc.competitors[].name", "$.events.{#}.desc.competitors[].id",
        "$.events.{#}.markets.{#}.[\"\"].{#}.k",
        "$.sports.{#}.slug", "$.categories.{#}.slug", "$.categories.{#}.name", "$.tournaments.{#}.slug", "$.tournaments.{#}.name"
      ], async () => {
        const parts = await Promise.all(vers.slice(0, 6).map(v => http(url + v, { site: false })));
        const out = { events: {}, tournaments: {}, categories: {}, sports: {} };
        parts.forEach(p => { for (const n in out) Object.assign(out[n], p && p[n]); });
        // markets "1" (1x2) or "186" (winner) must exist on some event, else no card shows odds
        const ev = Object.values(out.events);
        if (ev.length && !ev.some(e => e.markets && (e.markets["1"]?.[""] || e.markets["186"]?.[""])))
          throw new Error('no event has market "1" (1x2) or "186" (winner) - hero-he cards would have no odds');
        return out;
      }, j => Object.keys(j.events).length);
    }
    await check("sportsbook promo banners", "hero-he (banner setup)",
      ["$.{#}.line_banner[].id"],
      () => http(`${base}/v2/promo/banners/brand/${ctx.brand}/en`, { site: false }));
  }
  return { results, loginError: ctx.loginError };
}

/* ---------- compare + report ---------- */

const MIN_COUNT = { "games/filters": 10, "games/global_search": 10, "sportsbook prematch events": 1 };

function evaluate(results, baseline, state) {
  const red = [], orange = [], info = [];
  const newBase = { ...baseline }, misses = { ...(state.misses || {}) };
  for (const r of results) {
    const where = `*${r.id}* — used by ${r.used}`;
    if (r.error) { red.push(`${where}\n    ✖ ${r.error}`); continue; }
    const lost = missingNeeds(r.resp, r.needs);
    if (lost.length) red.push(`${where}\n    ✖ fields the widget reads are missing/empty: \`${lost.join("`, `")}\``);
    const min = MIN_COUNT[r.id] ?? (r.id.startsWith("games/get_by_section") ? 1 : null);
    if (min != null && r.count != null && r.count < min) red.push(`${where}\n    ✖ returned ${r.count} item(s), expected at least ${min}`);

    const now = flat(shape(r.resp));
    const old = baseline[r.id];
    if (!old) { newBase[r.id] = now; continue; }
    const merged = { ...old };
    const gone = [], retyped = [], added = [];
    for (const p in old) {
      if (!(p in now)) {
        // parent itself missing or empty list -> the data just had nothing there this time
        const k = r.id + " " + p;
        misses[k] = (misses[k] || 0) + 1;
        if (misses[k] >= MISSING_RUNS) gone.push(p);
      } else {
        delete misses[r.id + " " + p];
        // A new non-null type on a field that used to have a real type (null just means "optional").
        const fresh = now[p].filter(t => t !== "null" && !old[p].includes(t));
        if (fresh.length && old[p].some(t => t !== "null")) retyped.push(`${p}: ${old[p].join("|")} → ${now[p].join("|")}`);
        merged[p] = [...new Set([...old[p], ...now[p]])].sort();
      }
    }
    for (const p in now) if (!(p in old)) { added.push(p); merged[p] = now[p]; }
    // Report only top-most removed paths (if `$.a` is gone, `$.a.b` is implied).
    const top = list => list.filter(p => !list.some(q => q !== p && p.startsWith(q + ".") || p.startsWith(q + "[]")));
    if (gone.length || retyped.length) orange.push(`${where}` +
      (top(gone).length ? `\n    − removed: \`${top(gone).slice(0, 15).join("`, `")}\`${top(gone).length > 15 ? ` (+${top(gone).length - 15} more)` : ""}` : "") +
      (retyped.length ? `\n    ≠ type changed: ${retyped.slice(0, 10).map(x => "`" + x + "`").join(", ")}` : ""));
    if (added.length) info.push(`${where}\n    + new: \`${top(added).slice(0, 12).join("`, `")}\`${top(added).length > 12 ? ` (+${top(added).length - 12} more)` : ""}`);
    for (const p of gone) { delete merged[p]; delete misses[r.id + " " + p]; } // reported once, then accepted
    newBase[r.id] = merged;
  }
  return { red, orange, info, newBase, misses };
}

async function slack(text) {
  if (!CONFIG.slackWebhook) { console.log("(no slackWebhook in config.json - not sent)"); return; }
  const res = await fetch(CONFIG.slackWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error("Slack: HTTP " + res.status + " " + (await res.text()));
}

async function main() {
  if (args.has("--test")) { await slack(":white_check_mark: bet25 API guard is connected to this channel."); console.log("sent"); return; }
  const baseline = REBASE ? {} : readJSON(BASELINE_FILE, {});
  const state = readJSON(STATE_FILE, {});
  const first = !Object.keys(baseline).length;
  let results, loginError;
  try { ({ results, loginError } = await run()); }
  catch (e) {
    // This computer offline (e.g. just woke up)? Then it's not bet25's fault: skip this run quietly.
    const online = await fetch("https://www.google.com/generate_204").then(() => true, () => false);
    if (!online) { console.log("No internet connection - skipped."); return; }
    results = [{ id: "bet25.com", used: "all widgets", error: e.message }];
  }
  const { red, orange, info: newFields, newBase, misses } = evaluate(results, baseline, state);
  const baselineAt = first || REBASE ? Date.now() : state.baselineAt || 0;
  const info = Date.now() - baselineAt < LEARN_MS ? [] : newFields;
  // Not a widget problem, but the logged-in checks didn't run, so it is sent like a red one.
  if (loginError) red.push(`:warning: *The guard could not log in* as ${CONFIG.login}: ${loginError}.\n    Game lists, lobby row and user info were NOT checked this run; it retries every hour.`);
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const ok = results.filter(r => !r.error).length;

  const lines = [];
  if (red.length) lines.push(`:red_circle: *Widget-breaking problems*`, ...red);
  if (orange.length) lines.push(`:large_orange_circle: *API structure changed*`, ...orange);
  if (info.length) lines.push(`:large_blue_circle: *New fields (harmless, FYI)*`, ...info);
  const report = lines.join("\n");
  console.log(`[${stamp}] ${ok}/${results.length} endpoints answered. ${red.length} red, ${orange.length} orange, ${info.length} info.` + (report ? "\n" + report : ""));
  if (DRY) return;

  // Alert on changes, not every hour: a red problem is re-sent only if it differs from the last one
  // or every 6 h while it lasts; a recovery message when everything is green again.
  const sig = red.join("\n");
  const now = Date.now();
  const header = `*bet25 API guard* · ${stamp} · ${ok}/${results.length} endpoints OK\n`;
  const resendRed = sig !== state.redSig || now - (state.redAt || 0) > 6 * 3600e3;
  let msg = null;
  if (first || REBASE) msg = `:white_check_mark: Baseline ${REBASE ? "re" : ""}saved for ${results.length} endpoints. I'll post here when something changes.` + (report ? "\n" + report : "");
  else if (red.length) msg = resendRed || orange.length || info.length ? report : null;
  else if (state.redSig) msg = ":large_green_circle: *Recovered* — all checked endpoints look right again." + (report ? "\n" + report : "");
  else if (report) msg = report;
  if (msg) await slack((header + msg).slice(0, 38000));

  writeJSON(BASELINE_FILE, newBase);
  writeJSON(STATE_FILE, {
    lastRun: stamp, baselineAt, misses,
    redSig: red.length ? sig : null,
    redAt: red.length ? (sig !== state.redSig || now - (state.redAt || 0) > 6 * 3600e3 ? now : state.redAt) : null
  });
}

main().catch(async e => {
  console.error(e);
  try { await slack(`:warning: *bet25 API guard* itself failed: ${e.message}`); } catch {}
  process.exit(1);
});
