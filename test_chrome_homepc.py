import base64
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TEST = r'''
import re
from rebrowser_playwright.sync_api import sync_playwright

URL = "https://m.vegasslot26.top/"
with sync_playwright() as p:
    browser = p.chromium.launch(
        channel="chrome",
        headless=False,
        args=["--disable-blink-features=AutomationControlled"],
    )
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        viewport={"width": 1366, "height": 768},
        locale="tr-TR",
    )
    page = ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    title = page.title()
    for _ in range(10):
        if "dakika" not in title.lower() and "moment" not in title.lower():
            break
        page.wait_for_timeout(3000)
        title = page.title()
    canonical = page.evaluate(
        "() => { const l = document.querySelector('link[rel=canonical]'); return l ? l.href : null; }"
    )
    print("TITLE:", title)
    print("CANONICAL:", canonical)
    browser.close()
'''

b64 = base64.b64encode(TEST.encode("utf-8")).decode()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)


def run(cmd, timeout=180):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out + ("\n[stderr] " + err[-400:] if err.strip() else "")


print(run('dir "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" 2>nul & dir "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" 2>nul'))
write = (
    "powershell -Command \"[IO.File]::WriteAllBytes('C:\\\\rbtest\\\\chrome_test.py', "
    "[Convert]::FromBase64String('" + b64 + "'))\""
)
print(run(write, timeout=30))
print("--- REAL CHROME TEST ---")
print(run("C:\\rbtest\\Scripts\\python.exe C:\\rbtest\\chrome_test.py", timeout=180))
c.close()
