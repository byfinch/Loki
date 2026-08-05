import base64
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TEST = r'''
import re
import cloudscraper

URL = "https://m.vegasslot26.top/"
try:
    s = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False},
        delay=10,
    )
    r = s.get(URL, timeout=60)
    print("STATUS:", r.status_code)
    m = re.search(r'rel="canonical"[^>]*href="([^"]+)"', r.text)
    if not m:
        m = re.search(r"href=\"([^\"]+)\"[^>]*rel=\"canonical\"", r.text)
    print("CANONICAL:", m.group(1) if m else None)
    t = re.search(r"<title>(.*?)</title>", r.text[:8000])
    print("TITLE:", t.group(1) if t else None)
    print("LEN:", len(r.text))
except Exception as ex:
    print("HATA:", type(ex).__name__, str(ex)[:250])
'''

b64 = base64.b64encode(TEST.encode("utf-8")).decode()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)


def run(cmd, timeout=300):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out + ("\n[stderr] " + err[-400:] if err.strip() else "")


print(run("C:\\rbtest\\Scripts\\python.exe -m pip install -q cloudscraper", timeout=300))
write = (
    "powershell -Command \"[IO.File]::WriteAllBytes('C:\\\\rbtest\\\\cs_test.py', "
    "[Convert]::FromBase64String('" + b64 + "'))\""
)
print(run(write, timeout=30))
print("--- CLOUDSCRAPER TEST ---")
print(run("C:\\rbtest\\Scripts\\python.exe C:\\rbtest\\cs_test.py", timeout=150))
c.close()
