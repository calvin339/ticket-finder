// Venues found automatically near any location.
//
// 1. Look up music venues, live-music bars, theatres and clubs nearby that list a website (venue map built weekly
//    from OpenStreetMap, see tools/build_venue_map.py).
// 2. For each website: recognize the ticketing layout (Live Nation, TicketWeb, SeeTickets, schema.org event data, …);
//    if the home page has no shows, follow its "Events" / "Calendar" link.
// 3. Remember which page worked for each site (3 days).

import { PARSERS, stripTags, localToIso, extractSaleTimes } from "./index.js";

const SITE_TTL = 3 * 86400 * 1000, FAIL_TTL = 2 * 86400 * 1000;
export const MAX_DISCOVERED = 40; // sites known to be unreadable cost nothing, so look at plenty
const MAX_AREA_MILES = 25;

const SKIP_NAME = /\b(cinema|movie|multiplex|imax|school|elementary|middle school|high school|college|university|church|library|museum|community cent(er|re)|senior)\b/i;
const SKIP_HOST = /(facebook|instagram|twitter|x\.com|linktr\.ee|yelp|google|tripadvisor|eventbrite|ticketmaster|wikipedia|tiktok|youtube)\./i;

// Rough time zone from coordinates (used for times written without a zone).
export function tzFor(lat, lon) {
  if (lat > 18 && lat < 72 && lon > -170 && lon < -50) {
    if (lon < -140) return "America/Anchorage";
    if (lon < -114.8) return "America/Los_Angeles";
    if (lon < -109 && lat > 31 && lat < 37 && lon > -114.8) return "America/Phoenix";
    if (lon < -101.5) return "America/Denver";
    if (lon < -86.5) return "America/Chicago";
    return "America/New_York";
  }
  const off = Math.round(lon / 15);
  return off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}

function milesBetween(a, b) {
  const R = 3958.8, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
function cleanWebsite(w) {
  w = String(w || "").split(";")[0].trim();
  if (!w) return null;
  if (!/^https?:\/\//i.test(w)) w = "https://" + w;
  try { const u = new URL(w); if (!/^https?:$/.test(u.protocol) || SKIP_HOST.test(u.hostname + ".")) return null; u.hash = ""; return u.href; } catch { return null; }
}

// Restaurants and bars that sometimes have music rank below real venues.
const FOOD = /\b(restaurant|grill|taco|taqu\w*|cafe|caf\u00e9|coffee|seafood|steak\w*|sausage|pizz\w*|kitchen|cantina|diner|bistro|eatery|bakery|mexican|sushi|wings|burger\w*|brew\w*|winery|hotel|resort|casino)\b/i;
const MUSIC = /\b(music hall|ballroom|amphitheat(er|re)|arena|auditorium|concert|live|stage|theat(er|re)|club|lounge|hall|opera|tavern|saloon|pavilion|bowl|the [a-z]+)\b/i;
const NOT_MUSIC = /\b(ballet|opera|children'?s|kids|youth|repertory|players|playhouse|dance (studio|academy|company)|farms?|barn|clubhouse|wedding|estate|vineyard|gardens?|park|golf|country club|community theat(er|re)|improv|comedy|magic|cinema|church)\b/i;
function rank(v) {
  let s = v.s || 1;
  if (s === 4) s = 2; // live_music=yes on a bar/restaurant (older map builds scored these 4)
  if (FOOD.test(v.n || "")) s -= 2;
  if (NOT_MUSIC.test(v.n || "")) s -= 3;
  if (MUSIC.test(v.n || "")) s += 1;
  return s;
}

// ------------------------------------------------------------------ the venue map
// venues/<lat>_<lon>.json on the site (1-degree squares), built weekly from OpenStreetMap by a GitHub Action.
const MAP_BASE = "https://calvin339.github.io/ticket-finder/venues/";
export async function venuesNear(loc, radius, env, fetchJson) {
  const r = Math.min(radius, MAX_AREA_MILES);
  const dLat = r / 69, dLon = r / (69 * Math.max(0.2, Math.cos((loc.lat * Math.PI) / 180)));
  const cells = [];
  for (let a = Math.floor(loc.lat - dLat); a <= Math.floor(loc.lat + dLat); a++)
    for (let o = Math.floor(loc.lon - dLon); o <= Math.floor(loc.lon + dLon); o++) cells.push(`${a}_${o}`);
  const lists = await Promise.all(cells.slice(0, 6).map((c) => fetchJson(`${MAP_BASE}${c}.json`).catch((e) => { if (e && e.budget) throw e; return []; })));
  const venues = [];
  for (const v of lists.flat()) {
    if (!v || !v.w || SKIP_NAME.test(v.n || "")) continue;
    const site = cleanWebsite(v.w);
    if (!site) continue;
    const venue = { name: v.n, lat: v.la, lon: v.lo, website: site, host: hostOf(site), city: v.c || "", score: rank(v) };
    if (milesBetween(loc, venue) <= r) venues.push(venue);
  }
  venues.sort((a, b) => b.score - a.score || milesBetween(loc, a) - milesBetween(loc, b));
  return venues;
}

// ------------------------------------------------------------------ recognizing a site's layout
export function detectKind(html) {
  if (html.includes("self.__next_f.push") && html.includes("discovery_id")) return "livenation";
  if (html.includes("seetickets-list-event-container")) return "seetickets";
  if (/class="(row tw-event-item|tw-section)"/.test(html)) return "ticketweb";
  if (html.includes('class="bill-ja__row"')) return "billja";
  if (html.includes('class="mix detail-information"')) return "anotherplanet";
  if (/application\/ld\+json/i.test(html) && /"@type"\s*:\s*(\[[^\]]*)?"[A-Za-z]*Event"/.test(html)) return "jsonld";
  return null;
}

const EVENTS_WORDS = /\b(events?|calendar|shows?|concerts?|schedule|line-?up|whats-?on|what-s-on|upcoming|live-?music|music|performances?|tickets?)\b/i;
const NOT_EVENTS = /\b(private|rental|rentals|book(ing)?|hire|wedding|careers?|jobs|gift|shop|store|merch|menu|faq|contact|about|press|login|account|cart|newsletter|donate|membership|past)\b/i;
export function findEventsLinks(html, base) {
  const host = hostOf(base);
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const text = stripTags(m[2]).slice(0, 60);
    const path = u.pathname.toLowerCase();
    if (NOT_EVENTS.test(path) || NOT_EVENTS.test(text)) continue;
    let s = 0;
    if (EVENTS_WORDS.test(path.split("/").filter(Boolean).slice(0, 2).join(" ").replace(/[-_]/g, " "))) s += 3;
    if (EVENTS_WORDS.test(text)) s += 2;
    if (!s) continue;
    if (hostOf(u.href) !== host) { if (!/(ticketweb|seetickets|etix|axs|dice\.fm|tixr|prekindle|ticketfly|venuepilot)/.test(u.hostname)) continue; s -= 1; }
    if (path === "/" || path === "") continue;
    const key = u.href.replace(/\/$/, "");
    out.set(key, Math.max(out.get(key) || 0, s));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

// ------------------------------------------------------------------ schema.org event data (many venue sites)
export function parseJsonLd(html, venue, now = new Date()) {
  const tz = venue.tz || "America/Los_Angeles";
  const out = new Map();
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { try { data = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; } }
    const stack = [data];
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      if (Array.isArray(o)) { stack.push(...o); continue; }
      for (const k of ["@graph", "itemListElement", "item", "subEvent", "event", "events"]) if (o[k]) stack.push(o[k]);
      const type = [].concat(o["@type"] || []).join(" ");
      if (/Event\b/.test(type) && o.startDate) {
        const ev = fromLd(o, venue, tz, now);
        if (ev && !out.has(ev.key)) out.set(ev.key, ev.show);
      }
    }
  }
  return [...out.values()];
}
function ldTime(v, tz) {
  const s = String(v || "");
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(s);
  if (!m) return null;
  if (!m[4]) return { iso: localToIso(+m[1], +m[2], +m[3], 10, 0, tz), dateOnly: true, date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  const iso = m[6] ? new Date(s).toISOString() : localToIso(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  return { iso, dateOnly: false, date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}
function fromLd(o, venue, tz, now) {
  const start = ldTime(o.startDate, tz);
  const title = stripTags(String(o.name || ""));
  if (!start || !title) return null;
  const performers = [].concat(o.performer || []).map((p) => (typeof p === "string" ? p : p && p.name)).filter(Boolean).map((p) => stripTags(String(p)));
  let generalOnsale = null, dateOnly = false, ticketUrl = null, status = "";
  for (const of of [].concat(o.offers || []).filter((x) => x && typeof x === "object")) {
    // A start date in the future is a real on-sale time. (Past ones are usually just when the listing was made.)
    const v = of.availabilityStarts || of.validFrom;
    const t = v && ldTime(v, tz);
    if (t && new Date(t.iso) > now && (!generalOnsale || new Date(t.iso) < new Date(generalOnsale))) { generalOnsale = t.iso; dateOnly = t.dateOnly; }
    if (!ticketUrl && of.url) ticketUrl = String(of.url);
    const av = String(of.availability || "");
    if (/SoldOut/i.test(av)) status = "soldout";
    else if (!status && /PreOrder|PreSale/i.test(av)) status = "upcoming";
    else if (!status && /InStock|LimitedAvailability|OnlineOnly/i.test(av)) status = "onsale";
  }
  if (generalOnsale && status === "onsale") status = "upcoming";
  const url = typeof o.url === "string" ? o.url : null;
  const place = o.location && (typeof o.location === "string" ? o.location : o.location.name);
  const show = {
    title, names: [title, ...performers],
    showDate: start.date, showTime: start.time && start.time !== "00:00" ? start.time : null,
    presales: [], generalOnsale, generalOnsaleDateOnly: dateOnly,
    ticketUrl: ticketUrl || url || venue.url, sourceUrl: url || venue.url, status,
    detailUrl: url && hostOf(url) === hostOf(venue.url || "") ? url : null,
  };
  if (place && venue.name && !looseSame(stripTags(String(place)), venue.name)) show.venueOverride = stripTags(String(place)).slice(0, 80);
  return { key: `${title}|${start.date}`, show };
}
const looseSame = (a, b) => {
  const w = (s) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((x) => x.length > 2);
  const A = w(a), B = new Set(w(b));
  return !A.length || !B.size || A.some((x) => B.has(x));
};

// A show's own page: event data there, or "on sale Fri Nov 20 at 10am" in the text.
export function parseGenericDetail(html, show, now = new Date(), tz) {
  const ld = parseJsonLd(html, { url: show.sourceUrl, tz }, now)[0];
  const text = stripTags(html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")).slice(0, 40000);
  const sale = extractSaleTimes(text, now, tz);
  const soon = (iso) => iso && new Date(iso) > new Date(now.getTime() - 30 * 86400000);
  const presales = sale.presales.filter((p) => soon(p.start));
  const general = ld?.generalOnsale ? { start: ld.generalOnsale, dateOnly: ld.generalOnsaleDateOnly } : sale.general && soon(sale.general.start) ? sale.general : null;
  return {
    presales: presales.length ? presales : show.presales,
    generalOnsale: general ? general.start : show.generalOnsale,
    generalOnsaleDateOnly: general ? general.dateOnly : show.generalOnsaleDateOnly,
    ticketUrl: (ld && ld.ticketUrl !== ld.sourceUrl && ld.ticketUrl) || show.ticketUrl,
  };
}


// ------------------------------------------------------------------ Squarespace event pages (…/events?format=json)
const localParts = (ms, tz) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
export function parseSquarespace(text, venue, now = new Date()) {
  let d; try { d = JSON.parse(text); } catch { return []; }
  const tz = venue.tz || "America/Los_Angeles";
  const origin = new URL(venue.url).origin;
  const out = [];
  for (const e of [].concat(d.upcoming || [], d.items || [])) {
    if (!e || !e.startDate || !e.title) continue;
    const { date, time } = localParts(+e.startDate, tz);
    const title = stripTags(e.title);
    const body = stripTags(String(e.body || "") + " " + String(e.excerpt || ""));
    const sale = extractSaleTimes(body, now, tz);
    const url = e.fullUrl ? new URL(e.fullUrl, origin).href : venue.url;
    const tix = /href="(https?:\/\/[^"]*(ticket|tix|etix|dice\.fm|eventbrite|seetickets|axs|prekindle|showclix|holdmyticket|tixr)[^"]*)"/i.exec(String(e.body || ""));
    const place = e.location && e.location.addressTitle;
    const show = {
      title, names: [title], showDate: date, showTime: time === "00:00" ? null : time,
      presales: sale.presales, generalOnsale: sale.general ? sale.general.start : null, generalOnsaleDateOnly: sale.general ? sale.general.dateOnly : false,
      ticketUrl: tix ? tix[1].replace(/&amp;/g, "&") : url, sourceUrl: url, status: /sold\s*out/i.test(title + " " + body.slice(0, 300)) ? "soldout" : "",
    };
    if (place && venue.name && !looseSame(stripTags(place), venue.name)) show.venueOverride = stripTags(place).slice(0, 80);
    out.push(show);
  }
  return out;
}

// ------------------------------------------------------------------ WordPress "The Events Calendar" (wp-json/tribe/events/v1/events)
export function parseTribe(text, venue, now = new Date()) {
  let d; try { d = JSON.parse(text); } catch { return []; }
  const tz = venue.tz || "America/Los_Angeles";
  const out = [];
  for (const e of d.events || []) {
    const m = /(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(e.start_date || "");
    if (!m || !e.title) continue;
    const title = stripTags(e.title);
    const body = stripTags(String(e.description || "") + " " + String(e.excerpt || ""));
    const sale = extractSaleTimes(body, now, tz);
    const place = e.venue && e.venue.venue;
    const show = {
      title, names: [title], showDate: `${m[1]}-${m[2]}-${m[3]}`, showTime: m[4] && !e.all_day ? `${m[4]}:${m[5]}` : null,
      presales: sale.presales, generalOnsale: sale.general ? sale.general.start : null, generalOnsaleDateOnly: sale.general ? sale.general.dateOnly : false,
      ticketUrl: e.website || e.url || venue.url, sourceUrl: e.url || venue.url, status: /sold\s*out/i.test(title + " " + String(e.cost || "")) ? "soldout" : "",
    };
    if (place && venue.name && !looseSame(stripTags(place), venue.name)) show.venueOverride = stripTags(place).slice(0, 80);
    out.push(show);
  }
  return out;
}

// Data feeds to try for a site, based on its home page.
export function feedUrls(html, base) {
  const origin = new URL(base).origin;
  const out = [];
  if (/wp-json\/tribe\/events|tribe-events/i.test(html)) out.push({ kind: "tribe", url: `${origin}/wp-json/tribe/events/v1/events?per_page=50` });
  if (/squarespace/i.test(html)) {
    const link = findEventsLinks(html, base).find((u) => new URL(u).origin === origin);
    if (link) out.push({ kind: "squarespace", url: link.replace(/\/$/, "") + "?format=json" });
  }
  return out;
}

// ------------------------------------------------------------------ reading a found venue's shows
// Returns { shows, kind, url } or { error }. Uses up to 2 page loads the first time; 1 after that.
export async function readFoundVenue(v, env, fetchP, now) {
  const siteKey = `site2:${v.host}`; // bump the prefix when readers improve, so old failures get rechecked
  const known = env.SUBS ? await env.SUBS.get(siteKey, "json").catch(() => null) : null;
  const fresh = known && Date.now() - known.at < (known.kind ? SITE_TTL : FAIL_TTL);
  const venue = { ...v, url: v.website };
  if (fresh && !known.kind) return { error: known.why || "no show list found", cachedFail: true };
  // Each try: { url, kind? } (no kind = recognize the page's layout)
  const tries = fresh ? [{ url: known.url, kind: known.kind }] : [{ url: v.website }];
  let result = { error: "no show list found" };
  for (let i = 0; i < tries.length && i < 3; i++) {
    const t = tries[i];
    const p = await fetchP(t.url);
    if (p.status >= 400) { result = { error: `blocked (${p.status})` }; if (i === 0) break; continue; }
    const kind = t.kind && PARSERS[t.kind] ? t.kind : detectKind(p.html);
    if (kind) {
      const shows = PARSERS[kind](p.html, { ...venue, url: t.url.replace(/\?format=json$/, "") }, now);
      if (shows.length || t.kind) { result = shows.length ? { shows, kind, url: p.url || t.url } : { error: "no upcoming shows listed" }; if (shows.length) break; }
    }
    if (i === 0 && !fresh) {
      // Prefer a data feed (Squarespace, The Events Calendar); else follow the site's "Events" link.
      const base = p.url || t.url;
      const feeds = feedUrls(p.html, base);
      tries.push(...(feeds.length ? feeds.slice(0, 1) : findEventsLinks(p.html, base).slice(0, 1).map((url) => ({ url }))));
    }
  }
  if (env.SUBS && !(fresh && result.shows)) {
    const rec = result.shows ? { at: Date.now(), kind: result.kind, url: result.url } : { at: Date.now(), kind: null, why: result.error };
    await env.SUBS.put(siteKey, JSON.stringify(rec)).catch(() => {});
  }
  return result;
}
