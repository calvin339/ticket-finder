"""One-off: check which venue sites expose shows and on-sale info a scraper can read."""
import json, re, sys, urllib.request, collections
from html.parser import HTMLParser

URLS = """https://www.theindependentsf.com/
https://www.bottomofthehill.com/calendar.html
https://gamh.com/
https://www.thechapelsf.com/music/
https://rickshawstop.com/
https://www.cafedunord.com/
https://www.swedishamericanhall.com/
https://www.apeconcerts.com/
https://www.thefoxoakland.com/
https://thegreekberkeley.com/
https://www.thewarfieldtheatre.com/
https://www.theregencyballroom.com/
https://www.theuctheatre.org/
https://ivyroom.com/
https://www.thenewparish.com/
https://www.augusthallsf.com/
https://www.brickandmortarmusic.com/
https://www.thegreatnorthernsf.com/
https://www.slimspresents.com/
https://www.thefillmore.com/
https://www.yoshis.com/
https://www.thelostchurch.org/""".split()

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
out = []
for u in URLS:
    r = {"url": u}
    try:
        req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            html = resp.read().decode("utf-8", "replace"); r["status"] = resp.status; r["final"] = resp.url
    except Exception as e:
        r["error"] = str(e)[:200]; out.append(r); continue
    r["bytes"] = len(html)
    r["tw_items"] = html.count("tw-event-item")
    r["tw_onsale_buttons"] = len(re.findall(r"tw_onsale", html))
    lds = re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S)
    ev, offer_keys = 0, collections.Counter()
    for raw in lds:
        try: data = json.loads(raw)
        except Exception: continue
        items = data if isinstance(data, list) else data.get("@graph", [data])
        for it in items:
            if isinstance(it, dict) and "Event" in str(it.get("@type", "")):
                ev += 1
                offs = it.get("offers") or []
                offs = offs if isinstance(offs, list) else [offs]
                for o in offs:
                    if isinstance(o, dict): offer_keys.update(o.keys())
    r["jsonld_events"] = ev; r["offer_keys"] = dict(offer_keys)
    text = re.sub(r"<[^>]+>", " ", html); text = re.sub(r"\s+", " ", text)
    r["onsale_snips"] = list(dict.fromkeys(m.group(0).strip() for m in re.finditer(r".{0,50}(?:on sale|onsale|presale|pre-sale).{0,50}", text, re.I)))[:6]
    hosts = collections.Counter(re.findall(r'href="https?://(?:www\.)?([a-z0-9.-]*(?:ticketweb|ticketmaster|axs|dice\.fm|seetickets|eventbrite|etix|tixr|prekindle|opendate|venuepilot|ticketfly|holdmyticket|livenation)[a-z.]*)', html, re.I))
    r["ticket_hosts"] = dict(hosts.most_common(5))
    out.append(r)
json.dump(out, open(sys.argv[1], "w"), indent=1)
print(json.dumps([{k: v for k, v in r.items() if k in ("url", "status", "error", "tw_items", "tw_onsale_buttons", "jsonld_events")} for r in out], indent=1))
