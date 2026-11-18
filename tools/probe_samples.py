"""One-off: save raw samples of each venue-site type so parsers can be written."""
import json, re, sys, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
def get(u):
    req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=25) as r: return r.read().decode("utf-8", "replace")
out = {}
# Live Nation venue sites: embedded event JSON
for u in ["https://www.thefillmore.com/", "https://www.cafedunord.com/", "https://www.billgrahamcivic.com/", "https://www.sfmasonic.com/", "https://www.theregencyballroom.com/", "https://www.thewarfieldtheatre.com/"]:
    try: h = get(u)
    except Exception as e: out[u] = {"error": str(e)}; continue
    i = h.find('"presales"')
    scripts = re.findall(r'<script[^>]*id="([^"]+)"[^>]*>', h)
    out[u] = {"len": len(h), "script_ids": scripts[:10], "presales_at": i,
              "around_presales": h[max(0, i - 2500): i + 1500] if i >= 0 else None,
              "nonempty_presale": (lambda m: h[max(0, m.start() - 300): m.start() + 700] if m else None)(re.search(r'"presales":\[\{', h))}
# Another Planet sites
for u in ["https://www.thefoxoakland.com/", "https://thegreekberkeley.com/"]:
    h = get(u); i = h.lower().find("presale")
    out[u] = {"len": len(h), "around": h[max(0, i - 3000): i + 800]}
# TicketWeb plugin
for u in ["https://www.theindependentsf.com/", "https://www.augusthallsf.com/", "https://www.brickandmortarmusic.com/"]:
    h = get(u); i = h.find("tw_onsale\""); j = h.find('class="row tw-event-item"')
    k = h.find("tw_onsale ") if i < 0 else i
    out[u] = {"len": len(h), "first_item": h[j: j + 3500] if j >= 0 else None, "onsale_ctx": h[max(0, h.find("tw_onsale tw_default") - 200): h.find("tw_onsale tw_default") + 300]}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print("ok")
