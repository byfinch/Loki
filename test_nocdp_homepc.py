import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)

CHROME = r'"C:\Program Files\Google\Chrome\Application\chrome.exe"'
URL = "https://m.vegasslot26.top/"

# CDP'siz: Chrome'un kendi headless modu, dump-dom. --user-data-dir ile kalici profil.
cmd = (
    CHROME
    + ' --headless=new --disable-gpu --no-first-run --user-data-dir=C:\\chrome-loki-profile'
    + ' --virtual-time-budget=20000 --dump-dom "'
    + URL
    + '"'
)
i, o, e = c.exec_command(cmd, timeout=90)
html = o.read().decode("utf-8", errors="replace")
err = e.read().decode("utf-8", errors="replace")

m = re.search(r'rel="canonical"[^>]*href="([^"]+)"', html)
if not m:
    m = re.search(r'href="([^"]+)"[^>]*rel="canonical"', html)
t = re.search(r"<title>(.*?)</title>", html[:8000])

print("TITLE:", t.group(1) if t else None)
print("CANONICAL:", m.group(1) if m else None)
print("LEN:", len(html))
if err.strip():
    print("[stderr]", err[-200:])
c.close()
