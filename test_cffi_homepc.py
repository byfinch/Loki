import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("100.79.119.108", port=22, username="efsun", password="13579A", timeout=15)


def run(cmd, timeout=300):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out + ("\n[stderr] " + err[-400:] if err.strip() else "")


print(run("C:\\rbtest\\Scripts\\python.exe -m pip install -q curl_cffi", timeout=300))

TEST = r'''
import re
from curl_cffi import requests

URL = "https://m.vegasslot26.top/"
try:
    r = requests.get(URL, impersonate="chrome", timeout=45)
    print("STATUS:", r.status_code)
    m = re.search(r'rel="canonical"[^>]*href="([^"]+)"', r.text)
    if not m:
        m = re.search(r"href=\"([^\"]+)\"[^>]*rel=\"canonical\"", r.text)
    print("CANONICAL:", m.group(1) if m else None)
    t = re.search(r"<title>(.*?)</title>", r.text[:8000])
    print("TITLE:", t.group(1) if t else None)
    print("LEN:", len(r.text))
except Exception as ex:
    print("HATA:", type(ex).__name__, str(ex)[:200])
'''

import base64
b64 = base64.b64encode(TEST.encode("utf-8")).decode()
write = (
    "powershell -Command \"[IO.File]::WriteAllBytes('C:\\\\rbtest\\\\cffi_test.py', "
    "[Convert]::FromBase64String('" + b64 + "'))\""
)
print(run(write, timeout=30))
print("--- CURL_CFFI TEST ---")
print(run("C:\\rbtest\\Scripts\\python.exe C:\\rbtest\\cffi_test.py", timeout=120))
c.close()
