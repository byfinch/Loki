import base64
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TEST = r'''
import re
from rebrowser_playwright.sync_api import sync_playwright

URL = "https://m.vegasslot26.top/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir="C:\\chrome-loki-profile",
        channel="chrome",
        headless=False,
        user_agent=UA,
        viewport={"width": 1366, "height": 768},
        locale="tr-TR",
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    for attempt in range(4):
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)
        title = page.title()
        print(f"deneme {attempt+1}: {title}")
        if "dakika" not in title.lower() and "moment" not in title.lower():
            break
        page.wait_for_timeout(5000)
    canonical = page.evaluate(
        "() => { const l = document.querySelector('link[rel=canonical]'); return l ? l.href : null; }"
    )
    print("CANONICAL:", canonical)
    cookies = ctx.cookies()
    print("cerez sayisi:", len(cookies))
    ctx.close()
'''

b64 = base64.b64encode(TEST.encode("utf-8")).decode()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)


def run(cmd, timeout=240):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out + ("\n[stderr] " + err[-400:] if err.strip() else "")


write = (
    "powershell -Command \"[IO.File]::WriteAllBytes('C:\\\\rbtest\\\\persist_test.py', "
    "[Convert]::FromBase64String('" + b64 + "'))\""
)
print(run(write, timeout=30))
print("--- KALICI PROFIL TESTI ---")
print(run("C:\\rbtest\\Scripts\\python.exe C:\\rbtest\\persist_test.py", timeout=240))
c.close()
