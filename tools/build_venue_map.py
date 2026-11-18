"""Build venues/<lat>_<lon>.json: music venues with websites, grouped into 1-degree map squares.

Runs weekly in GitHub Actions (OpenStreetMap's Overpass servers can't be reached from Cloudflare).
The search worker reads the squares around a location to find nearby venues.
"""
import json, os, sys, time, math, re, urllib.request, urllib.parse, collections

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = "TicketFinderVenueMap/1.0 (+https://calvin339.github.io/ticket-finder/)"
# tag filter -> score (higher = more likely a music venue)
QUERIES = [
    ('["amenity"="music_venue"]', 5),
    ('["amenity"="concert_hall"]', 5),
    ('["live_music"="yes"]', 4),
    ('["amenity"="nightclub"]', 3),
    ('["amenity"="events_venue"]', 2),
    ('["amenity"="theatre"]', 2),
    ('["amenity"="arts_centre"]', 1),
]
SKIP_NAME = re.compile(r"\b(cinema|movie|multiplex|imax|school|elementary|high school|college|university|church|library|museum|senior)\b", re.I)
SKIP_HOST = re.compile(r"(facebook|instagram|twitter|x\.com|linktr\.ee|yelp|google|tripadvisor|eventbrite|ticketmaster|wikipedia|tiktok|youtube)\.", re.I)

def overpass(q):
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=900) as r:
                    return json.load(r)
            except Exception as e:
                last = e
                print(f"  {ep}: {e}", flush=True)
                time.sleep(20)
    raise RuntimeError(f"all map servers failed: {last}")

def clean_site(w):
    w = (w or "").split(";")[0].strip()
    if not w: return None
    if not re.match(r"https?://", w, re.I): w = "https://" + w
    try:
        u = urllib.parse.urlsplit(w)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.hostname or SKIP_HOST.search(u.hostname + "."): return None
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path or "/", u.query, ""))

venues = {}
for tag, score in QUERIES:
    for key in ("website", "contact:website"):
        q = f'[out:json][timeout:900];nwr{tag}["{key}"];out center tags;'
        print("query", tag, key, flush=True)
        els = overpass(q).get("elements", [])
        print("  ", len(els), "results", flush=True)
        for el in els:
            t = el.get("tags", {})
            lat = el.get("lat", (el.get("center") or {}).get("lat")); lon = el.get("lon", (el.get("center") or {}).get("lon"))
            name = t.get("name")
            site = clean_site(t.get(key))
            if not name or lat is None or not site or SKIP_NAME.search(name): continue
            host = urllib.parse.urlsplit(site).hostname.lower().removeprefix("www.")
            k = (host, round(lat, 2), round(lon, 2))
            s = max(score, venues.get(k, {}).get("s", 0))
            city = ", ".join(x for x in (t.get("addr:city"), t.get("addr:state")) if x)
            venues[k] = {"n": name[:80], "la": round(lat, 5), "lo": round(lon, 5), "w": site[:200], "c": city[:60], "s": s}
        time.sleep(10)

cells = collections.defaultdict(list)
for v in venues.values():
    cells[f"{math.floor(v['la'])}_{math.floor(v['lo'])}"].append(v)
out = sys.argv[1] if len(sys.argv) > 1 else "venues"
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith(".json"): os.remove(os.path.join(out, f))
for cell, vs in cells.items():
    vs.sort(key=lambda v: (-v["s"], v["n"]))
    with open(os.path.join(out, cell + ".json"), "w") as fh:
        json.dump(vs, fh, separators=(",", ":"), ensure_ascii=False)
with open(os.path.join(out, "_about.json"), "w") as fh:
    json.dump({"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "venues": len(venues), "squares": len(cells), "source": "OpenStreetMap contributors (ODbL)"}, fh)
print(f"{len(venues)} venues in {len(cells)} squares")
