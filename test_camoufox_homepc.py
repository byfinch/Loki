import base64
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TEST = r'''
import re
from camoufox.sync_api import Camoufox

URL = "https://m.vegasslot26.top/"
with Camoufox(headless=True) as browser:
    page = browser.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    for _ in range(10):
        page.wait_for_timeout(3000)
        title = page.title()
        if "dakika" not in title.lower() and "moment" not in title.lower():
            break
    canonical = page.evaluate(
        "() => { const l = document.querySelector('link[rel=canonical]'); return l ? l.href : null; }"
    )
    print("TITLE:", title)
    print("CANONICAL:", canonical)
'''

b64 = base64.b64encode(TEST.encode("utf-8")).decode()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)


def run(cmd, timeout=400):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out + ("\n[stderr] " + err[-500:] if err.strip() else "")


print(run("C:\\rbtest\\Scripts\\python.exe -m pip install -q camoufox", timeout=300))
print(run("C:\\rbtest\\Scripts\\python.exe -m camoufox fetch", timeout=600))
write = (
    "powershell -Command \"[IO.File]::WriteAllBytes('C:\\\\rbtest\\\\camo_test.py', "
    "[Convert]::FromBase64String('" + b64 + "'))\""
)
print(run(write, timeout=30))
print("--- CAMOUFOX TEST ---")
print(run("C:\\rbtest\\Scripts\\python.exe C:\\rbtest\\camo_test.py", timeout=180))
c.close()
