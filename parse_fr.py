import json
import re

d = json.load(open("fr_response2.json"))
render = d.get("render") or {}
html = render.get("html") or ""
print("render status:", render.get("status_code"), "| html len:", len(html))
m = re.search(r'rel="canonical"[^>]*href="([^"]+)"', html)
if not m:
    m = re.search(r"href=\"([^\"]+)\"[^>]*rel=\"canonical\"", html)
if not m:
    m = re.search(r"rel='canonical'[^>]*href='([^']+)'", html)
print("CANONICAL:", m.group(1) if m else None)
t = re.search(r"<title>(.*?)</title>", html[:8000])
print("title:", t.group(1) if t else None)
