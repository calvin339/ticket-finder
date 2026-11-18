"""One-off: save full pages of each venue-site type so parsers can be written."""
import os, sys, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
os.makedirs("tools/samples", exist_ok=True)
for name, u in [("fillmore", "https://www.thefillmore.com/"), ("cafedunord", "https://www.cafedunord.com/"),
                ("fox", "https://www.thefoxoakland.com/"), ("greek", "https://thegreekberkeley.com/"),
                ("independent", "https://www.theindependentsf.com/"), ("augusthall", "https://www.augusthallsf.com/"),
                ("bottomofthehill", "https://www.bottomofthehill.com/calendar.html"), ("gamh", "https://gamh.com/")]:
    try:
        req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=25) as r: open(f"tools/samples/{name}.html", "wb").write(r.read())
    except Exception as e: print(name, e)
print("ok")
