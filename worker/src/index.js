// Ticket Finder search worker (Cloudflare Workers).
//
// GET /search?artists=A|B&lat=37.77&lon=-122.42&radius=50
//   Reads Bay Area venue websites (and the Ticketmaster API when TM_API_KEY is set)
//   and returns upcoming shows for those artists with presale / on-sale times.
// GET /artists?q=name   Artist suggestions with photos (Deezer's public catalog).
// GET /venues           The venues this worker reads.
// POST /subscribe, GET /confirm, /subscription, /unsubscribe   Email alerts (see alerts.js).
// Every 15 minutes the schedule sends email alerts.
//
// Venue pages are cached for 20 minutes so repeated searches stay fast and polite.

import { VENUES } from "./venues.js";
import { handleAlertsRequest, runAlerts } from "./alerts.js";
import { venuesNear, readFoundVenue, parseJsonLd, parseGenericDetail, tzFor, MAX_DISCOVERED } from "./discover.js";

const ALLOWED_ORIGINS = ["https://calvin339.github.io"];
const PAGE_TTL = 20 * 60; // seconds
const UA = "Mozilla/5.0 (compatible; TicketFinder/1.0; +https://calvin339.github.io/ticket-finder/)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost") ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/search") return json(await search(url, env, ctx), cors);
      if (url.pathname === "/artists") return json(await artistSuggest(url.searchParams.get("q") || ""), cors, 3600);
      if (url.pathname === "/venues") return json({ venues: VENUES.map(({ name, city, lat, lon, kind }) => ({ name, city, lat, lon, kind })) }, cors, 3600);
      if (["/subscribe", "/confirm", "/subscription", "/unsubscribe"].includes(url.pathname)) {
        const r = await handleAlertsRequest(url, request, env, ctx, { runSearch });
        return r instanceof Response ? r : json(r, cors);
      }
      return json({ ok: true, endpoints: ["/search", "/artists", "/venues", "/subscribe"] }, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 0, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, ctx, { runSearch }, env.WORKER_URL || "https://ticket-finder.calvin339.workers.dev"));
  },
};

function json(data, cors, maxAge = 0, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...cors },
  });
}

// ---------------------------------------------------------------- helpers
export const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const decodeEntities = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
export const stripTags = (s) => decodeEntities(String(s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function milesBetween(a, b) {
  const R = 3958.8, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Does this show belong to the artist? Whole-word match on the artist's name.
export function matchesArtist(artist, ...texts) {
  const a = norm(artist);
  if (!a) return false;
  const re = new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  return texts.some((t) => re.test(norm(t)));
}

// Pacific-time wall clock → UTC ISO string (venues here are all in America/Los_Angeles).
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const g = (k) => +parts.find((x) => x.type === k).value;
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ts;
}
export function localToIso(y, mo, d, h = 0, mi = 0, tz = "America/Los_Angeles") {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}
// A month/day with no year: the next occurrence on or after ~2 months ago.
export function inferYear(mo, d, now = new Date()) {
  const y = now.getUTCFullYear();
  const cand = new Date(Date.UTC(y, mo - 1, d));
  return cand.getTime() < now.getTime() - 60 * 86400000 ? y + 1 : y;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseClock(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(s || "");
  if (!m) return null;
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  return { h, mi: +(m[2] || 0) };
}

// Cloudflare's free plan allows 50 outside requests per search, so each search has a budget.
const MAX_REQUESTS = 46;
function spend(budget) {
  if (!budget) return;
  if (budget.left <= 0) { const e = new Error("search limit reached"); e.budget = true; throw e; }
  budget.left--;
}
async function fetchPage(url, ctx, budget) {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  spend(budget);
  const hit = await cache.match(key);
  if (hit) return { html: await hit.text(), cached: true, status: hit.status };
  spend(budget);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", cf: { cacheTtl: 0 } });
  const html = await res.text();
  if (res.ok) {
    const copy = new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${PAGE_TTL}` } });
    ctx.waitUntil(cache.put(key, copy));
  }
  return { html, cached: false, status: res.status };
}

// ---------------------------------------------------------------- venue parsers
// Each returns [{ title, names:[...], showDate, showTime, presales:[{name,start,end,code,dateOnly}], generalOnsale, generalOnsaleDateOnly, ticketUrl, sourceUrl, status }]

// Live Nation venue sites (Next.js): the full Ticketmaster event records are embedded in the page.
export function parseLiveNation(html, venue) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return ""; } });
  const txt = chunks.join("");
  const out = new Map();
  // Event lists appear under different keys depending on the page ("events" on the home page, "data" on /shows).
  for (const key of ['"events":[', '"data":[', '"items":[']) {
  let idx = 0;
  while ((idx = txt.indexOf(key, idx)) !== -1) {
    const start = idx + key.length - 1;
    const end = matchBracket(txt, start);
    idx = start + 1;
    if (end < 0) continue;
    let arr; try { arr = JSON.parse(txt.slice(start, end + 1)); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e || typeof e !== "object" || !e.discovery_id || !e.start_date_local || out.has(e.discovery_id)) continue;
      const names = [e.name, ...(e.artists || []).map((a) => a.name)].filter(Boolean);
      out.set(e.discovery_id, {
        title: e.name, names,
        showDate: e.start_date_local || null, showTime: e.start_time_local && e.start_time_local !== "00:00:01" ? e.start_time_local.slice(0, 5) : null,
        presales: (e.presales || []).filter((p) => p.start_datetime_utc).map((p) => ({ name: p.description || "Presale", start: p.start_datetime_utc, end: p.end_datetime_utc || null, code: p.passcode || null })),
        generalOnsale: e.sales_start_datetime_utc || null, generalOnsaleDateOnly: false,
        ticketUrl: e.url || null, sourceUrl: venue.url, status: e.status_code || "",
      });
    }
  }
  }
  return [...out.values()];
}
function matchBracket(s, i) {
  const open = s[i], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return -1;
}

// TicketWeb's WordPress plugin (The Independent, August Hall, Brick & Mortar…).
export function parseTicketWeb(html, venue, now = new Date()) {
  // Two layouts: list rows ("row tw-event-item", date "11.17") and grid cards ("tw-section", date "Nov 17").
  const blocks = html.includes('class="row tw-event-item"') ? html.split(/class="row tw-event-item"/).slice(1) : html.split(/class="tw-section"/).slice(1);
  const out = [];
  for (const b of blocks) {
    const nameM = /class="tw-name">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!nameM) continue;
    let mo, d;
    const date = /class="tw-event-date">\s*([\d]{1,2})\.(\d{1,2})/.exec(b);
    const gridDate = /class="tw-image-date">\s*([A-Za-z]{3})[a-z]*\.?\s*(?:<[^>]+>)?\s*(\d{1,2})/.exec(b);
    // Other plugin themes: "Tue, Nov 17" in tw-event-date, or month + day in separate spans.
    const wordDate = /class="tw-event-date">\s*(?:[A-Za-z]{3}\w*,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(b);
    const splitDate = /class="tw-event-month">\s*([A-Za-z]{3})[a-z]*\s*<\/span>\s*<span class="tw-event-date">\s*(\d{1,2})\s*</.exec(b);
    const named = [gridDate, wordDate, splitDate].find((x) => x && MONTHS[x[1].toLowerCase()]);
    if (date) { mo = +date[1]; d = +date[2]; }
    else if (named) { mo = MONTHS[named[1].toLowerCase()]; d = +named[2]; }
    else continue;
    const y = inferYear(mo, d, now);
    const att = /class="tw-attractions">([\s\S]*?)<\/div>/.exec(b);
    const time = /class="tw-event-time">([^<]*)</.exec(b);
    const btn = /<a[^>]*class="[^"]*tw-buy-tix-btn[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b) || /<a[^>]*href="([^"]+)"[^>]*class="[^"]*tw-buy-tix-btn[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const btnText = btn ? stripTags(btn[2]) : "";
    let generalOnsale = null, dateOnly = false;
    const sale = /on\s*sale\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s*(?:@|at)?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?))?/i.exec(btnText);
    if (sale) {
      const smo = +sale[1], sd = +sale[2], sy = sale[3] ? (+sale[3] < 100 ? 2000 + +sale[3] : +sale[3]) : inferYear(smo, sd, now);
      const clock = parseClock(sale[4]);
      generalOnsale = localToIso(sy, smo, sd, clock ? clock.h : 10, clock ? clock.mi : 0);
      dateOnly = !clock;
    }
    const clock = parseClock(time && time[1]);
    const title = stripTags(nameM[2]);
    const support = att ? stripTags(att[1]).replace(/^with\s+/i, "") : "";
    out.push({
      title, names: [title, ...support.split(/,|\band\b|&/).map((s) => s.trim()).filter(Boolean)],
      showDate: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, showTime: clock ? `${String(clock.h).padStart(2, "0")}:${String(clock.mi).padStart(2, "0")}` : null,
      presales: [], generalOnsale, generalOnsaleDateOnly: dateOnly,
      ticketUrl: btn ? decodeEntities(btn[1]) : decodeEntities(nameM[1]), sourceUrl: decodeEntities(nameM[1]), status: sale ? "upcoming" : "onsale",
    });
  }
  return out;
}

// Another Planet venue sites (Fox Oakland, Greek Theatre Berkeley).
export function parseAnotherPlanet(html, venue, now = new Date()) {
  const out = new Map();
  // List rows: <div class="mix detail-information"> … show-title … startDate content="April 30, 2027 8:00 pm" … button text "PRESALE 11/19" / "ON SALE 11/20"
  const rows = html.split(/class="mix detail-information"|<li class="carousel item">/).slice(1);
  for (const r of rows) {
    const t = /class="show-title"[^>]*>([\s\S]*?)<\/h2>/.exec(r);
    const sd = /itemprop="startDate" content="([A-Za-z]+) (\d{1,2}), (\d{4})(?: (\d{1,2}:\d{2}\s*[ap]m))?"/i.exec(r);
    if (!t || !sd) continue;
    const mo = MONTHS[sd[1].slice(0, 3).toLowerCase()], d = +sd[2], y = +sd[3];
    const link = /href="(https?:\/\/[^"]+\/events\/[^"]+)"/.exec(r);
    const tix = /href="(https:\/\/www\.ticketmaster\.com[^"]+)"/.exec(r);
    const title = stripTags(t[1]);
    const support = /class="support">([\s\S]*?)<\/div>/.exec(r);
    const text = stripTags(r);
    const presales = [];
    let generalOnsale = null, generalDateOnly = false;
    // "Presale begins Wednesday, 11/18 at 10am!"  /  button "PRESALE 11/19"
    const pre = /presale(?: begins)?(?:[^0-9]{0,20})?(\d{1,2})\/(\d{1,2})(?:\s*(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*[ap]m))?/i.exec(text);
    if (pre) {
      const pmo = +pre[1], pd = +pre[2], clock = parseClock(pre[3]);
      presales.push({ name: "Presale", start: localToIso(inferYear(pmo, pd, now), pmo, pd, clock ? clock.h : 10, clock ? clock.mi : 0), end: null, code: null, dateOnly: !clock });
    }
    const on = /on\s*sale(?:[^0-9]{0,20})?(\d{1,2})\/(\d{1,2})(?:\s*(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*[ap]m))?/i.exec(text);
    if (on) {
      const omo = +on[1], od = +on[2], clock = parseClock(on[3]);
      generalOnsale = localToIso(inferYear(omo, od, now), omo, od, clock ? clock.h : 10, clock ? clock.mi : 0); generalDateOnly = !clock;
    }
    const key = (link && link[1]) || `${title}|${y}-${mo}-${d}`;
    const prev = out.get(key);
    const clock = parseClock(sd[4]);
    const item = {
      title, names: [title, ...(support ? stripTags(support[1]).replace(/^with special guests?\s*/i, "").split(/,|&|\band\b/).map((s) => s.trim()).filter(Boolean) : [])],
      showDate: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, showTime: clock ? `${String(clock.h).padStart(2, "0")}:${String(clock.mi).padStart(2, "0")}` : null,
      presales, generalOnsale, generalOnsaleDateOnly: generalDateOnly,
      ticketUrl: tix ? decodeEntities(tix[1]) : (link ? link[1] : null), sourceUrl: link ? link[1] : venue.url, status: presales.length || generalOnsale ? "upcoming" : "",
    };
    // A show can appear twice (featured carousel + list): keep the best details from both.
    if (!prev) { out.set(key, item); continue; }
    const better = (a, b) => (!a.length ? b : !b.length ? a : (a[0].dateOnly && !b[0].dateOnly ? b : a));
    out.set(key, {
      ...prev,
      presales: better(prev.presales, item.presales),
      generalOnsale: prev.generalOnsale && !prev.generalOnsaleDateOnly ? prev.generalOnsale : item.generalOnsale || prev.generalOnsale,
      generalOnsaleDateOnly: prev.generalOnsale && !prev.generalOnsaleDateOnly ? false : item.generalOnsale ? item.generalOnsaleDateOnly : prev.generalOnsaleDateOnly,
      ticketUrl: /ticketmaster\.com/.test(prev.ticketUrl || "") ? prev.ticketUrl : item.ticketUrl || prev.ticketUrl,
      names: prev.names.length >= item.names.length ? prev.names : item.names,
      status: prev.status || item.status,
    });
  }
  return [...out.values()];
}

// Pull presale / on-sale times out of a show page's text, e.g.
//   "Artist presale Wed Nov 18 · 10 AM   On sale Fri Nov 20 · 10 AM"
//   "Tickets will go on sale 11/18/2026 10:00:00 AM PST"
export function extractSaleTimes(text, now = new Date(), tz = "America/Los_Angeles") {
  const presales = [];
  let general = null;
  const t = String(text || "").replace(/\s+/g, " ");
  // Numeric form (SeeTickets): "go on sale 11/18/2026 10:00:00 AM"
  const num = /on sale (\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::\d{2})? ?([AP]M)/i.exec(t);
  if (num) {
    let h = +num[4] % 12; if (/p/i.test(num[6])) h += 12;
    general = { start: localToIso(+num[3], +num[1], +num[2], h, +num[5], tz), dateOnly: false };
  }
  // Word form: "[label] presale|on sale [Dow,] Mon DD[, YYYY] [·|at|@|,] [10 AM]"
  const re = /((?:[A-Za-z][\w&.'’-]*\s){0,3})?\b(pre-?sale|on sale)\s*:?\s*(?:begins\s*)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s*(?:·|at|@|,|-)?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?))?/gi;
  let m;
  while ((m = re.exec(t))) {
    const mo = MONTHS[m[3].toLowerCase()], d = +m[4];
    const y = m[5] ? +m[5] : inferYear(mo, d, now);
    const clock = parseClock(m[6]);
    const start = localToIso(y, mo, d, clock ? clock.h : 10, clock ? clock.mi : 0, tz);
    if (/pre/i.test(m[2])) {
      const kind = /(artist|fan club|fan|venue|spotify|local|amex|american express|citi|vip|member|ticketmaster|live nation|official platinum)\s*$/i.exec((m[1] || "").trim());
      const label = kind ? kind[1].replace(/^\w/, (c) => c.toUpperCase()) + " presale" : "Presale";
      if (!presales.some((p) => p.start === start)) presales.push({ name: label, start, end: null, code: null, dateOnly: !clock });
    } else if (!general || (general.dateOnly && clock)) general = { start, dateOnly: !clock };
  }
  return { presales, general };
}

// SeeTickets' WordPress plugin (The Chapel, Great American Music Hall, Hotel Utah).
export function parseSeeTickets(html, venue, now = new Date()) {
  const body = html.slice(Math.max(0, html.indexOf("<body")));
  const out = new Map();
  for (const b of body.split(/seetickets-list-event-container mdc-card/).slice(1)) {
    const link = /<p class="[^"]*\btitle\b[^"]*">\s*<a href="(https:\/\/wl\.seetickets\.us\/event\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const date = /<p class="[^"]*\bdate\b[^"]*">\s*(?:[A-Za-z]{3}\w*,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(b);
    if (!link || !date || !MONTHS[date[1].toLowerCase()]) continue;
    const url = decodeEntities(link[1]);
    if (out.has(url)) continue;
    const mo = MONTHS[date[1].toLowerCase()], d = +date[2], y = date[3] ? +date[3] : inferYear(mo, d, now);
    const show = /class="see-showtime[^"]*">\s*([^<]+)</.exec(b);
    const clock = parseClock(show && show[1]);
    const head = /class="[^"]*\bheadliners\b[^"]*">([\s\S]*?)<\/p>/.exec(b);
    const sup = /class="[^"]*\bsupporting-talent\b[^"]*">([\s\S]*?)<\/p>/.exec(b);
    const title = stripTags(link[2]);
    const names = [title, ...[head, sup].filter(Boolean).flatMap((x) => stripTags(x[1]).split(/,|&|\band\b|\bw\/|\bwith\b/i)).map((s) => s.replace(/^\s*(supporting talent|headliners?|with)\s*:\s*/i, "").trim()).filter(Boolean)].filter((n, i, a) => a.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i);
    out.set(url, {
      title, names, showDate: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      showTime: clock ? `${String(clock.h).padStart(2, "0")}:${String(clock.mi).padStart(2, "0")}` : null,
      presales: [], generalOnsale: null, generalOnsaleDateOnly: false,
      ticketUrl: url, sourceUrl: url, status: "", detailUrl: url,
    });
  }
  return [...out.values()];
}
// A SeeTickets event page: structured data for the exact date, plus "Tickets will go on sale …".
export function parseSeeTicketsDetail(html, show, now = new Date()) {
  const text = stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " "));
  const sale = extractSaleTimes(text, now);
  const ld = /"startDate"\s*:\s*"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(html);
  const performers = [...html.matchAll(/"@type"\s*:\s*"MusicGroup",\s*"name"\s*:\s*"([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  return {
    showDate: ld ? `${ld[1]}-${ld[2]}-${ld[3]}` : show.showDate, showTime: ld ? `${ld[4]}:${ld[5]}` : show.showTime,
    presales: sale.presales.length ? sale.presales : show.presales,
    generalOnsale: sale.general ? sale.general.start : show.generalOnsale, generalOnsaleDateOnly: sale.general ? sale.general.dateOnly : show.generalOnsaleDateOnly,
    status: /not on sale yet/i.test(text) ? "upcoming" : /sold out/i.test(text) ? "soldout" : "onsale",
    names: [...show.names, ...performers],
  };
}

// Café du Nord / Swedish American Hall list ("bill" rows); show pages list presale and on-sale times.
export function parseBillJa(html, venue) {
  const out = [];
  const origin = new URL(venue.url).origin;
  for (const row of html.split(/<li class="bill-ja__row"/).slice(1)) {
    const href = /class="bill-ja__link" href="([^"]+)"/.exec(row);
    const time = /<time class="bill-ja__date" datetime="(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(row);
    const name = /class="bill-ja__name">([\s\S]*?)(?:<svg|<\/span>\s*(?:<span class="bill-ja__status"|<\/a>))/.exec(row);
    if (!href || !time || !name) continue;
    const status = /class="bill-ja__status">([^<]*)</.exec(row);
    const upstairs = /Swedish American Hall/i.test(row);
    const url = new URL(decodeEntities(href[1]), origin).href;
    out.push({
      title: stripTags(name[1]), names: [stripTags(name[1])],
      venueOverride: upstairs ? "Swedish American Hall" : null,
      showDate: `${time[1]}-${time[2]}-${time[3]}`, showTime: `${time[4]}:${time[5]}`,
      presales: [], generalOnsale: null, generalOnsaleDateOnly: false,
      ticketUrl: url, sourceUrl: url, status: status ? stripTags(status[1]).toLowerCase() : "", detailUrl: url,
    });
  }
  return out;
}
export function parseBillJaDetail(html, show, now = new Date()) {
  const text = stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " "));
  const sale = extractSaleTimes(text, now);
  const tix = /href="(https:\/\/www\.ticketweb\.com\/event\/[^"]+)"/.exec(html);
  return {
    presales: sale.presales.length ? sale.presales : show.presales,
    generalOnsale: sale.general ? sale.general.start : show.generalOnsale, generalOnsaleDateOnly: sale.general ? sale.general.dateOnly : show.generalOnsaleDateOnly,
    ticketUrl: tix ? decodeEntities(tix[1]) : show.ticketUrl,
  };
}

// Bottom of the Hill's hand-made calendar table. (Hidden HTML comments are ignored.)
export function parseBottomOfTheHill(html, venue) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ");
  const out = [];
  const parts = clean.split(/name="(\d{8})"/);
  for (let i = 1; i < parts.length; i += 2) {
    const ymd = parts[i], chunk = parts[i + 1] || "";
    const bands = [...chunk.matchAll(/class="band"[^>]*>([\s\S]*?)<\/big>/g)].map((m) => stripTags(m[1])).filter((b) => b && !/^x+$/i.test(b));
    if (!bands.length) continue;
    const tix = new RegExp(`href="(https?:\\/\\/www\\.bottomofthehill\\.com\\/(?:dice|stubmatic)\\/event${ymd}[^"]*)"`).exec(parts[i - 1].slice(-3000) + chunk);
    const showDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    if (out.some((s) => s.showDate === showDate)) continue;
    out.push({
      title: bands.join(", "), names: bands, showDate, showTime: null,
      presales: [], generalOnsale: null, generalOnsaleDateOnly: false,
      ticketUrl: tix ? tix[1].replace(/^http:/, "https:") : `https://www.bottomofthehill.com/${ymd}.html`, sourceUrl: `https://www.bottomofthehill.com/${ymd}.html`,
      status: tix ? "onsale" : "",
    });
  }
  return out;
}


// The UC Theatre (Berkeley), a Webflow site: month + day tiles, headliner, support, show time.
export function parseUCTheatre(html, venue, now = new Date()) {
  const out = [];
  const origin = new URL(venue.url).origin;
  for (const b of html.split(/class="shows-collection-item w-dyn-item"/).slice(1)) {
    const mo = /class="heading-2">\s*([A-Za-z]{3})/.exec(b), day = /class="heading-3">\s*(\d{1,2})\s*</.exec(b);
    const href = /href="(\/shows\/[^"]+)"/.exec(b), name = /class="heading-9 name-listing">([\s\S]*?)<\/h1>/.exec(b);
    if (!mo || !day || !href || !name || !MONTHS[mo[1].toLowerCase()]) continue;
    const m = MONTHS[mo[1].toLowerCase()], d = +day[1], y = inferYear(m, d, now);
    const sup = /class="support-listing">([\s\S]*?)<\/h1>/.exec(b);
    const show = /class="text-block-84">\s*([^<]+)</.exec(b);
    const clock = parseClock(show && show[1]);
    const title = stripTags(name[1]);
    const url = origin + decodeEntities(href[1]);
    const soldOut = /class="image-64"/.test(b);
    out.push({
      title, names: [title, ...(sup ? stripTags(sup[1]).split(/,|&|\band\b/i).map((x) => x.trim()).filter(Boolean) : [])],
      showDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      showTime: clock ? `${String(clock.h).padStart(2, "0")}:${String(clock.mi).padStart(2, "0")}` : null,
      presales: [], generalOnsale: null, generalOnsaleDateOnly: false,
      ticketUrl: url, sourceUrl: url, status: soldOut ? "soldout" : /BUY TICKETS|\$\d/.test(b) ? "onsale" : "",
    });
  }
  return out;
}
export const PARSERS = { jsonld: parseJsonLd, livenation: parseLiveNation, ticketweb: parseTicketWeb, anotherplanet: parseAnotherPlanet, seetickets: parseSeeTickets, billja: parseBillJa, bottomofthehill: parseBottomOfTheHill, uctheatre: parseUCTheatre };
// For site types whose list pages lack on-sale times: read a matching show's own page.
export const DETAIL_PARSERS = { seetickets: parseSeeTicketsDetail, billja: parseBillJaDetail, jsonld: (html, show, now, venue) => parseGenericDetail(html, show, now, venue && venue.tz) };
const MAX_DETAIL_PAGES = 12;

// ---------------------------------------------------------------- Ticketmaster
async function ticketmaster(env, artists, loc, radius) {
  if (!env.TM_API_KEY) return { status: "no key", events: [] };
  const base = "https://app.ticketmaster.com/discovery/v2";
  const events = [];
  for (const artist of artists) {
    const q = new URLSearchParams({ apikey: env.TM_API_KEY, keyword: artist, classificationName: "music", size: "5" });
    const a = await (await fetch(`${base}/attractions.json?${q}`)).json();
    const hit = (a?._embedded?.attractions || []).find((x) => norm(x.name) === norm(artist));
    const p = new URLSearchParams({ apikey: env.TM_API_KEY, latlong: `${loc.lat},${loc.lon}`, radius: String(radius), unit: "miles", size: "100", sort: "date,asc", includeTBA: "yes", includeTBD: "yes" });
    if (hit) p.set("attractionId", hit.id); else { p.set("keyword", artist); p.set("classificationName", "music"); }
    const r = await (await fetch(`${base}/events.json?${p}`)).json();
    for (const e of r?._embedded?.events || []) {
      const v = e._embedded?.venues?.[0] || {};
      const names = [e.name, ...(e._embedded?.attractions || []).map((x) => x.name)];
      if (!hit && !matchesArtist(artist, ...names)) continue;
      events.push({
        artist, source: "Ticketmaster", title: e.name, venue: v.name || "", city: [v.city?.name, v.state?.stateCode].filter(Boolean).join(", "),
        showDate: e.dates?.start?.localDate || null, showTime: e.dates?.start?.localTime?.slice(0, 5) || null,
        presales: (e.sales?.presales || []).filter((x) => x.startDateTime).map((x) => ({ name: x.name || "Presale", start: x.startDateTime, end: x.endDateTime || null, code: null })),
        generalOnsale: e.sales?.public?.startTBD ? null : e.sales?.public?.startDateTime || null, generalOnsaleDateOnly: false,
        ticketUrl: e.url || null, sourceUrl: e.url || null, status: e.dates?.status?.code || "",
      });
    }
    await new Promise((res) => setTimeout(res, 220)); // stay under 5 requests/second
  }
  return { status: "ok", events };
}

// ---------------------------------------------------------------- search
function search(url, env, ctx) {
  return runSearch({
    artists: (url.searchParams.get("artists") || "").split("|"),
    lat: url.searchParams.get("lat"), lon: url.searchParams.get("lon"), radius: url.searchParams.get("radius"),
  }, env, ctx);
}
export async function runSearch(q, env, ctx) {
  const artists = (q.artists || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
  const lat = q.lat === null || q.lat === "" ? NaN : +q.lat, lon = q.lon === null || q.lon === "" ? NaN : +q.lon;
  const radius = Math.min(250, Math.max(5, +q.radius || 50));
  if (!artists.length || !isFinite(lat) || !isFinite(lon)) return { error: "Need artists, lat and lon." };
  const loc = { lat, lon };
  const venues = VENUES.filter((v) => milesBetween(loc, v) <= radius);
  const sources = {};
  const found = [];
  const now = new Date();
  const detailBudget = { n: MAX_DETAIL_PAGES };
  const budget = { left: Math.min(MAX_REQUESTS, +q.maxRequests || MAX_REQUESTS) };
  const tz = tzFor(lat, lon);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const curatedHosts = new Set(VENUES.flatMap((v) => [v.url, ...(v.extraUrls || [])]).map(hostOf));

  const collect = async (v, shows) => {
    for (const s of shows) for (const a of artists) {
      if (!matchesArtist(a, ...s.names)) continue;
      let show = s;
      const detail = DETAIL_PARSERS[v.kind];
      if (detail && s.detailUrl && detailBudget.n > 0 && budget.left > 4) {
        detailBudget.n--;
        try { const d = await fetchPage(s.detailUrl, ctx, budget); if (d.status < 400) show = { ...s, ...detail(d.html, s, now, v) }; } catch {}
      }
      const { venueOverride, detailUrl, ...rest } = show;
      found.push({ artist: a, source: v.name, venue: venueOverride || v.name, city: v.city, ...rest });
    }
  };

  // Hand-tuned Bay Area venues
  const curated = Promise.all(venues.map(async (v) => {
    try {
      const page = await fetchPage(v.url, ctx, budget);
      if (page.status >= 400) { sources[v.name] = `blocked (${page.status})`; return; }
      const shows = PARSERS[v.kind](page.html, v, now);
      for (const extra of v.extraUrls || []) {
        try { const p2 = await fetchPage(extra, ctx, budget); if (p2.status < 400) shows.push(...PARSERS[v.kind](p2.html, v, now)); } catch {}
      }
      sources[v.name] = `${shows.length} shows`;
      await collect(v, shows);
    } catch (e) { sources[v.name] = e.budget ? "skipped (search limit)" : `error: ${String(e.message || e).slice(0, 80)}`; }
  }));

  // Venues found on the map near this location
  let discovered = 0;
  const auto = (async () => {
    let near;
    try {
      near = await venuesNear(loc, radius, env, async (ep) => {
        spend(budget);
        const r = await fetch(ep, { headers: { "User-Agent": UA }, cf: { cacheTtl: 21600, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
        if (r.status === 404) return [];
        if (!r.ok) throw new Error(`venue map ${r.status}`);
        return r.json();
      });
    } catch (e) { sources["Venue finder"] = `error: ${String(e.message || e).slice(0, 80)}`; return; }
    const pick = near.filter((v) => milesBetween(loc, v) <= radius && !curatedHosts.has(v.host) && !VENUES.some((c) => milesBetween(c, v) < 0.1)).slice(0, MAX_DISCOVERED);
    discovered = pick.length;
    await curated; // hand-tuned venues get the request budget first
    await Promise.all(pick.map(async (v) => {
      const venue = { ...v, kind: "jsonld", tz };
      try {
        const r = await readFoundVenue(venue, env, (u) => fetchPage(u, ctx, budget), now);
        if (r.error) { sources[v.name] = r.error; return; }
        sources[v.name] = `${r.shows.length} shows`;
        await collect({ ...venue, kind: r.kind }, r.shows);
      } catch (e) { sources[v.name] = e.budget ? "skipped (search limit)" : `error: ${String(e.message || e).slice(0, 60)}`; }
    }));
  })();
  await Promise.all([curated, auto]);

  try {
    const tm = await ticketmaster(env, artists, loc, radius);
    sources.Ticketmaster = tm.status === "ok" ? `${tm.events.length} matches` : tm.status;
    found.push(...tm.events);
  } catch (e) { sources.Ticketmaster = `error: ${String(e.message || e).slice(0, 80)}`; }

  // Drop past shows; merge the same show seen on a venue site and on Ticketmaster.
  const today = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const merged = [];
  for (const e of found.filter((e) => !e.showDate || e.showDate >= today)) {
    const twin = merged.find((m) => m.artist === e.artist && m.showDate === e.showDate && (norm(m.venue) === norm(e.venue) || norm(m.venue).split(" ")[0] === norm(e.venue).split(" ")[0]));
    if (!twin) { merged.push({ ...e, sources: [e.source] }); continue; }
    if (!twin.sources.includes(e.source)) twin.sources.push(e.source);
    const timed = (ps) => ps.length && ps.some((p) => !p.dateOnly);
    if ((!twin.presales.length && e.presales.length) || (!timed(twin.presales) && timed(e.presales))) twin.presales = e.presales;
    if ((!twin.generalOnsale || twin.generalOnsaleDateOnly) && e.generalOnsale && !e.generalOnsaleDateOnly) { twin.generalOnsale = e.generalOnsale; twin.generalOnsaleDateOnly = false; }
    if (!twin.ticketUrl) twin.ticketUrl = e.ticketUrl;
  }
  merged.sort((a, b) => String(a.showDate).localeCompare(String(b.showDate)));
  return { checkedAt: now.toISOString(), venuesChecked: venues.length + discovered, sources, events: merged.map(({ names, ...rest }) => rest) };
}

// ---------------------------------------------------------------- artist suggestions
async function artistSuggest(q) {
  q = q.trim().slice(0, 80);
  if (q.length < 2) return { artists: [] };
  const r = await fetch(`https://api.deezer.com/search/artist?${new URLSearchParams({ q, limit: "8" })}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const d = await r.json();
  return { artists: (d.data || []).map((a) => ({ name: a.name, img: a.picture_medium || null, fans: a.nb_fan ?? null })) };
}

