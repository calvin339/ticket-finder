// Email alerts for Ticket Finder.
//
// People sign up on the site (POST /subscribe) and confirm by email. Every 15 minutes the worker's
// schedule runs runAlerts():
//   - every 6 hours per person: search their artists, email "new show" for shows not seen before
//   - every run: email reminders the day before and 1 hour before presales / on-sales
// Each person picks which of these they want. Data lives in the SUBS key-value store.
// Email goes out through Brevo (secrets BREVO_API_KEY and ALERT_FROM_EMAIL).

const SITE = "https://calvin339.github.io/ticket-finder/";
const TZ = "America/Los_Angeles";
const SCAN_EVERY_MS = 6 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MAX_SUBSCRIBERS = 100;
const DEFAULT_ALERTS = { newShow: true, dayBefore: true, hourBefore: true };

const enc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i.test(e) && e.length <= 200;

function cleanPrefs(body) {
  const artists = (Array.isArray(body.artists) ? body.artists : []).map((a) => String(a).trim().slice(0, 100)).filter(Boolean).slice(0, 40);
  const lat = +body.lat, lon = +body.lon;
  const radius = Math.min(250, Math.max(5, +body.radius || 50));
  const a = body.alerts || {};
  const alerts = { newShow: a.newShow !== false, dayBefore: a.dayBefore !== false, hourBefore: a.hourBefore !== false };
  if (!isFinite(lat) || !isFinite(lon)) throw new Error("Pick your location first.");
  return { artists, lat, lon, radius, place: String(body.place || "").slice(0, 120), alerts };
}

// ------------------------------------------------------------------ formatting
const fmtWhen = (iso, dateOnly) => {
  const d = new Date(iso);
  const opts = dateOnly ? { weekday: "short", month: "short", day: "numeric", timeZone: TZ } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ };
  return new Intl.DateTimeFormat("en-US", opts).format(d) + (dateOnly ? " (time not listed)" : "");
};
const fmtShow = (e) => {
  const d = new Date(`${e.showDate}T12:00:00Z`);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
  if (!e.showTime) return day;
  const [h, m] = e.showTime.split(":").map(Number);
  return `${day}, ${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const localDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const localHour = (date) => +new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(date);

const eventKey = (e) => [e.artist, e.showDate, e.venue].map((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).join("|");
const moments = (e) => [
  ...(e.presales || []).filter((p) => p.start).map((p) => ({ kind: p.name || "Presale", start: p.start, dateOnly: !!p.dateOnly, code: p.code })),
  ...(e.generalOnsale ? [{ kind: "General on-sale", start: e.generalOnsale, dateOnly: !!e.generalOnsaleDateOnly }] : []),
];

function saleLines(e) {
  const now = Date.now();
  return moments(e).filter((m) => new Date(m.start).getTime() > now - HOUR_MS)
    .map((m) => `${enc(m.kind)}: <b>${enc(fmtWhen(m.start, m.dateOnly))}</b>${m.code ? ` &middot; code <b>${enc(m.code)}</b>` : ""}`);
}
function eventHtml(e, extra = "") {
  const lines = saleLines(e);
  const status = e.status === "onsale" ? "On sale now" : e.status === "soldout" ? "Sold out" : lines.length ? "" : "No on-sale date listed yet";
  return `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #e3e3e8;border-radius:10px">
    <div style="font-size:16px;font-weight:600">${enc(e.artist)}</div>
    <div style="color:#555">${enc(e.venue)}, ${enc(e.city)} &middot; ${enc(fmtShow(e))}</div>
    ${extra}${lines.map((l) => `<div style="margin-top:4px">${l}</div>`).join("")}
    ${status ? `<div style="margin-top:4px;color:#555">${status}</div>` : ""}
    ${e.ticketUrl ? `<div style="margin-top:8px"><a href="${enc(e.ticketUrl)}" style="color:#4f46e5">Tickets</a></div>` : ""}
  </div>`;
}
function wrapEmail(sub, workerUrl, title, inner) {
  const unsub = `${workerUrl}/unsubscribe?id=${sub.id}&key=${sub.key}`;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:16px">
    <h2 style="margin:0 0 14px">${enc(title)}</h2>${inner}
    <p style="color:#777;font-size:13px;margin-top:24px">Times are Pacific. Always double-check on the ticket page.<br>
    <a href="${SITE}" style="color:#4f46e5">Open Ticket Finder</a> &middot; <a href="${unsub}" style="color:#777">Stop these emails</a></p>
  </body></html>`;
}

async function sendEmail(env, to, subject, html) {
  if (!env.BREVO_API_KEY || !env.ALERT_FROM_EMAIL) throw new Error("Email alerts aren't set up yet (missing Brevo key).");
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "Ticket Finder", email: env.ALERT_FROM_EMAIL }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!r.ok) throw new Error(`Email failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

// ------------------------------------------------------------------ storage
const getSub = async (env, id) => (id ? await env.SUBS.get(`sub:${id}`, "json") : null);
const putSub = (env, sub) => env.SUBS.put(`sub:${sub.id}`, JSON.stringify(sub));
async function authed(env, id, key) {
  const sub = await getSub(env, id);
  return sub && key && sub.key === key ? sub : null;
}

// ------------------------------------------------------------------ HTTP endpoints
export async function handleAlertsRequest(url, request, env, ctx, deps) {
  if (!env.SUBS) throw new Error("Email alerts aren't set up yet (missing storage).");
  const workerUrl = url.origin;
  const p = url.pathname;

  if (p === "/subscribe" && request.method === "POST") {
    const body = await request.json();
    const email = normEmail(body.email);
    if (!validEmail(email)) throw new Error("That email address doesn't look right.");
    const prefs = cleanPrefs(body);
    let id = await env.SUBS.get(`email:${email}`);
    let sub = await getSub(env, id);
    if (!sub) {
      const count = (await env.SUBS.list({ prefix: "sub:", limit: MAX_SUBSCRIBERS + 1 })).keys.length;
      if (count >= MAX_SUBSCRIBERS) throw new Error("Alerts are full right now.");
      id = crypto.randomUUID();
      sub = { id, key: randomKey(), email, confirmed: false, created: new Date().toISOString(), sent: {}, known: [], events: [] };
      await env.SUBS.put(`email:${email}`, id);
    }
    if (sub.lastConfirmMail && Date.now() - sub.lastConfirmMail < 2 * 60 * 1000) return { ok: true, status: "sent", note: "We just sent a confirmation email. Check your inbox (and spam)." };
    sub.pending = prefs;
    sub.confirmKey = randomKey();
    sub.lastConfirmMail = Date.now();
    await putSub(env, sub);
    const link = `${workerUrl}/confirm?id=${sub.id}&c=${sub.confirmKey}`;
    const n = prefs.artists.length;
    await sendEmail(env, email, "Confirm your Ticket Finder alerts", `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:16px">
      <h2>Turn on ticket alerts?</h2>
      <p>Someone (hopefully you) asked Ticket Finder to email this address about ${n} artist${n === 1 ? "" : "s"}${prefs.place ? ` near ${enc(prefs.place)}` : ""}.</p>
      <p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Yes, send me alerts</a></p>
      <p style="color:#777;font-size:13px">If this wasn't you, ignore this email and nothing will be sent.</p></body></html>`);
    return { ok: true, status: "sent" };
  }

  if (p === "/confirm") {
    const sub = await getSub(env, url.searchParams.get("id"));
    if (!sub || !sub.confirmKey || url.searchParams.get("c") !== sub.confirmKey) return page("This link has expired", `Sign up again on <a href="${SITE}">Ticket Finder</a>.`, 400);
    Object.assign(sub, sub.pending || {});
    delete sub.pending; delete sub.confirmKey;
    const first = !sub.confirmed;
    sub.confirmed = true;
    sub.rescan = true;
    await putSub(env, sub);
    ctx.waitUntil(scanAndNotify(env, ctx, deps, sub, workerUrl, { welcome: first }).catch((e) => console.log("welcome scan failed", e)));
    return Response.redirect(`${SITE}?alerts=${sub.id}.${sub.key}`, 302);
  }

  if (p === "/unsubscribe") {
    const id = url.searchParams.get("id"), key = url.searchParams.get("key");
    const sub = await authed(env, id, key);
    if (request.method !== "POST") {
      if (!sub) return page("Already off", "You won't get any more emails from Ticket Finder.");
      return page("Stop Ticket Finder emails?", `<form method="post"><button style="font-size:16px;padding:10px 16px;border-radius:8px;border:0;background:#4f46e5;color:#fff">Stop all emails to ${enc(sub.email)}</button></form>`);
    }
    if (sub) { await env.SUBS.delete(`sub:${sub.id}`); await env.SUBS.delete(`email:${sub.email}`); }
    return page("Done", "You won't get any more emails from Ticket Finder.");
  }

  if (p === "/subscription") {
    let body = {};
    if (request.method === "POST") body = await request.json();
    const id = body.id || url.searchParams.get("id"), key = body.key || url.searchParams.get("key");
    const sub = await authed(env, id, key);
    if (!sub) return { ok: false, status: "gone" };
    if (request.method === "POST") {
      if (body.delete) { await env.SUBS.delete(`sub:${sub.id}`); await env.SUBS.delete(`email:${sub.email}`); return { ok: true, status: "deleted" }; }
      const prefs = cleanPrefs(body);
      const addedArtists = prefs.artists.some((a) => !(sub.artists || []).includes(a));
      const moved = prefs.lat !== sub.lat || prefs.lon !== sub.lon || prefs.radius !== sub.radius;
      Object.assign(sub, prefs);
      if (addedArtists || moved) sub.rescan = true;
      await putSub(env, sub);
    }
    return { ok: true, status: "on", email: sub.email, alerts: sub.alerts || DEFAULT_ALERTS, artists: (sub.artists || []).length, lastScan: sub.lastScan || null };
  }
  return null;
}

function page(title, html, status = 200) {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${enc(title)}</title></head>
    <body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#111">
    <h2>${enc(title)}</h2><p>${html}</p><p><a href="${SITE}" style="color:#4f46e5">Ticket Finder</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ------------------------------------------------------------------ the schedule
export async function runAlerts(env, ctx, deps, workerUrl) {
  if (!env.SUBS || !env.BREVO_API_KEY) return { skipped: "alerts not set up" };
  let cursor, results = [];
  do {
    const page = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const sub = await env.SUBS.get(k.name, "json");
      if (!sub || !sub.confirmed) continue;
      try { results.push(await scanAndNotify(env, ctx, deps, sub, workerUrl, {})); }
      catch (e) { console.log("alert run failed for", sub.id, e && e.message); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return results;
}

async function scanAndNotify(env, ctx, deps, sub, workerUrl, { welcome = false }) {
  const now = new Date();
  const alerts = sub.alerts || DEFAULT_ALERTS;
  let changed = false;
  const out = { id: sub.id, scanned: false, emails: 0 };

  // 1. Search for shows (every 6 hours, or right after the artist list / location changed)
  if (sub.artists?.length && (welcome || sub.rescan || !sub.lastScan || now - new Date(sub.lastScan) >= SCAN_EVERY_MS)) {
    const res = await deps.runSearch({ artists: sub.artists, lat: sub.lat, lon: sub.lon, radius: sub.radius }, env, ctx);
    if (res.events) {
      const known = new Set(sub.known || []);
      const fresh = res.events.filter((e) => !known.has(eventKey(e)));
      if (welcome) {
        const upcoming = res.events;
        await sendEmail(env, sub.email, "Ticket alerts are on",
          wrapEmail(sub, workerUrl, "You're all set", `<p>We'll email you ${describeAlerts(alerts)} for ${sub.artists.length} artist${sub.artists.length === 1 ? "" : "s"}.</p>` +
            (upcoming.length ? `<p>Here's what's coming up right now:</p>${upcoming.slice(0, 25).map((e) => eventHtml(e)).join("")}` : "<p>None of your artists have shows nearby yet. We'll keep checking.</p>")));
        out.emails++;
      } else if (alerts.newShow && fresh.length && sub.lastScan) {
        const names = [...new Set(fresh.map((e) => e.artist))];
        await sendEmail(env, sub.email, `New show${fresh.length > 1 ? "s" : ""}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`,
          wrapEmail(sub, workerUrl, fresh.length > 1 ? "New shows near you" : "New show near you", fresh.map((e) => eventHtml(e)).join("")));
        out.emails++;
      }
      // Remember every show we've seen (so it's only announced once) and the latest details for reminders.
      sub.known = [...new Set([...res.events.map(eventKey), ...(sub.known || [])])].slice(0, 2000);
      sub.events = res.events.map(({ artist, venue, city, title, showDate, showTime, presales, generalOnsale, generalOnsaleDateOnly, ticketUrl, status }) =>
        ({ artist, venue, city, title, showDate, showTime, presales, generalOnsale, generalOnsaleDateOnly, ticketUrl, status }));
      sub.lastScan = now.toISOString();
      delete sub.rescan;
      changed = true;
      out.scanned = true;
    }
  }

  // 2. Reminders from the latest search results
  const due = [];
  const sent = sub.sent || {};
  const today = localDay(now), tomorrow = localDay(new Date(now.getTime() + 24 * HOUR_MS));
  for (const e of sub.events || []) {
    if (e.status === "soldout") continue;
    for (const m of moments(e)) {
      const t = new Date(m.start).getTime(), left = t - now.getTime();
      const base = `${eventKey(e)}|${m.kind}|${m.start}`;
      if (m.dateOnly) {
        // Time not listed: remind the morning before, and the morning of.
        const day = localDay(new Date(m.start));
        if (alerts.dayBefore && day === tomorrow && localHour(now) >= 9 && !sent[base + "|1d"]) due.push({ e, m, tag: "1d", label: "tomorrow" });
        else if (alerts.hourBefore && day === today && localHour(now) >= 7 && !sent[base + "|1h"]) due.push({ e, m, tag: "1h", label: "today" });
        continue;
      }
      if (left <= 0) continue;
      if (alerts.hourBefore && left <= 75 * 60 * 1000 && !sent[base + "|1h"]) due.push({ e, m, tag: "1h", label: `in ${Math.max(1, Math.round(left / 60000))} minutes` });
      else if (alerts.dayBefore && left <= 24 * HOUR_MS && left > 3 * HOUR_MS && !sent[base + "|1d"]) due.push({ e, m, tag: "1d", label: "tomorrow" });
    }
  }
  if (due.length) {
    const soon = due.some((d) => d.tag === "1h");
    const first = due[0];
    const subject = due.length === 1
      ? `${first.e.artist}: ${first.m.kind.toLowerCase()} starts ${first.label}${first.m.dateOnly ? "" : ` (${fmtWhen(first.m.start).split(", ").pop()})`}`
      : `${due.length} ticket sales start ${soon ? "soon" : "tomorrow"}`;
    const inner = due.map((d) => eventHtml(d.e, `<div style="margin-top:6px;color:#b45309;font-weight:600">${enc(d.m.kind)} starts ${enc(d.label)}</div>`)).join("");
    await sendEmail(env, sub.email, subject, wrapEmail(sub, workerUrl, soon ? "Tickets go on sale soon" : "Tickets go on sale tomorrow", inner));
    for (const d of due) sent[`${eventKey(d.e)}|${d.m.kind}|${d.m.start}|${d.tag}`] = now.getTime();
    out.emails++;
    changed = true;
  }
  // Forget reminder records older than 60 days.
  for (const [k, ts] of Object.entries(sent)) if (now - ts > 60 * 24 * HOUR_MS) { delete sent[k]; changed = true; }
  sub.sent = sent;
  if (changed) await putSub(env, sub);
  return out;
}

function describeAlerts(a) {
  const parts = [a.newShow && "when they announce a show near you", a.dayBefore && "the day before tickets go on sale", a.hourBefore && "an hour before"].filter(Boolean);
  return parts.length ? parts.join(", ").replace(/, ([^,]*)$/, " and $1") : "(no alerts picked)";
}
