#!/usr/bin/env python3
"""
RackGhost oturum servisi (yerel, 127.0.0.1:3210) - browser'siz saf HTTP.

Zincir: CapSolver AntiCloudflareTask -> cf_clearance -> /login csrf ->
login POST -> PHPSESSID -> panel/stresser_api.php. Oturum duserse
(403 / CF HTML / login redirect) otomatik yeniden kurulur.

Endpoints:
  GET  /health -> {ok, state, detail, lastOk}
  POST /api    -> stresser_api.php payload'i (action/api/params...)
"""

import json
import re
import threading
import time
import traceback
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

# Kimlikler koda GOMMEZ; systemd unit Environment satirlarindan okunur.
# (rg_service.py repoda durdugu icin duz metin sifre geçmişi temizlendi.)
import os
EMAIL = os.environ.get("RG_EMAIL", "")
PASSWORD = os.environ.get("RG_PASSWORD", "")
CAPSOLVER_KEY = os.environ.get("RG_CAPSOLVER_KEY", "")
PROXY = os.environ.get("RG_PROXY", "")
BASE = "https://rackghost.com"
API_PATH = "/panel/stresser_api.php"
LOGIN_RENEW_BEFORE_SEC = 20 * 60  # oturumu bu surede bir tazele

if not all([EMAIL, PASSWORD, CAPSOLVER_KEY, PROXY]):
    raise SystemExit("[rg_service] RG_EMAIL/RG_PASSWORD/RG_CAPSOLVER_KEY/RG_PROXY env tanimli degil")

# Loopback'te bile auth: SSRF/zincirleme erisimde servisin RackGhost hesabi
# kotuye kullanilmasin diye paylasilan gizli deger (EnvironmentFile'dan).
LOCAL_TOKEN = os.environ.get("RG_LOCAL_TOKEN", "")

_state = {"state": "kapali", "detail": "", "lastOk": None}
_lock = threading.Lock()
_jar = {}          # cf_clearance, PHPSESSID
_ua = None
_login_at = 0


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


_last_rg_req = [0.0]


def _http(url, method="GET", data=None, json_body=None, timeout=30):
    # RackGhost rate limit (1 istek/sn): login zinciri dahil HER istek
    # arasina zorunlu bosluk. api_call _lock altinda cagildigi icin
    # zaman damgasi yarissiz ilerler.
    wait = 1.15 - (time.time() - _last_rg_req[0])
    if wait > 0:
        time.sleep(wait)
    _last_rg_req[0] = time.time()
    proxy_handler = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
    opener = urllib.request.build_opener(proxy_handler)
    headers = {"User-Agent": _ua, "Accept": "*/*"}
    if _jar:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in _jar.items())
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif data is not None:
        body = data.encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    resp = opener.open(req, timeout=timeout)
    # set-cookie'leri jara isle
    for c in resp.headers.get_all("Set-Cookie") or []:
        m = re.match(r"([^=;\s]+)=([^;\s]*)", c)
        if m:
            _jar[m.group(1)] = m.group(2)
    return resp.status, resp.read().decode("utf-8", errors="replace"), resp.headers


def _cs_post(path, body):
    req = urllib.request.Request(
        f"https://api.capsolver.com/{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def capsolver_solve():
    log("capsolver: cloudflare cozuluyor...")
    t = _cs_post("createTask", {
        "clientKey": CAPSOLVER_KEY,
        "task": {"type": "AntiCloudflareTask", "websiteURL": f"{BASE}/login", "proxy": PROXY},
    })
    if t.get("errorId"):
        raise RuntimeError(f"capsolver createTask: {t.get('errorDescription')}")
    tid = t["taskId"]
    for _ in range(24):
        time.sleep(5)
        r = _cs_post("getTaskResult", {"clientKey": CAPSOLVER_KEY, "taskId": tid})
        if r.get("status") == "ready":
            sol = r.get("solution", {})
            cl = (sol.get("cookies") or {}).get("cf_clearance")
            ua = sol.get("userAgent")
            if cl and ua:
                log("capsolver: clearance alindi")
                return cl, ua
        elif r.get("status") == "failed" or r.get("errorId"):
            raise RuntimeError(f"capsolver: {r.get('errorDescription') or r}")
    raise RuntimeError("capsolver timeout")


def login():
    global _ua, _login_at
    cl, ua = capsolver_solve()
    _ua = ua
    _jar.clear()
    _jar["cf_clearance"] = cl
    status, page, _ = _http(f"{BASE}/login")
    m = re.search(r'name="csrf_token" value="([^"]+)"', page)
    if not m:
        raise RuntimeError(f"csrf_token bulunamadi (HTTP {status})")
    tok = m.group(1)
    time.sleep(1.2)  # rackghost rate limit: 1 istek/sn
    body = urllib.parse.urlencode({"csrf_token": tok, "email": EMAIL, "password": PASSWORD})
    status2, resp2, _ = _http(f"{BASE}/login", method="POST", data=body)
    if "PHPSESSID" not in _jar:
        raise RuntimeError(f"login basarisiz (HTTP {status2})")
    _login_at = time.time()
    _state["state"] = "hazir"
    _state["lastOk"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    _state["detail"] = ""
    log("oturum kuruldu")


def ensure_session(force=False):
    global _login_at
    if force or not _jar.get("PHPSESSID") or (time.time() - _login_at) > LOGIN_RENEW_BEFORE_SEC:
        last_err = None
        for attempt in range(2):
            try:
                login()
                return True
            except Exception as e:
                last_err = e
                log(f"login deneme {attempt+1} hata: {str(e)[:150]}")
                time.sleep(5)
        _state["state"] = "hata"
        _state["detail"] = str(last_err)[:200]
        return False
    return True


def api_call(payload):
    with _lock:
        if not ensure_session():
            return {"ok": False, "error": _state["detail"] or "oturum yok"}
        try:
            status, text, headers = _http(f"{BASE}{API_PATH}", method="POST", json_body=payload)
            try:
                data = json.loads(text)
                _state["lastOk"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                _state["state"] = "hazir"
                return {"ok": True, "data": data}
            except json.JSONDecodeError:
                pass
            # Oturum dusmus olabilir: bir kez tazeleyip tekrar dene
            log("beklenmeyen yanit, oturum tazeleniyor...")
            if ensure_session(force=True):
                time.sleep(1.2)
                status, text, _ = _http(f"{BASE}{API_PATH}", method="POST", json_body=payload)
                try:
                    return {"ok": True, "data": json.loads(text)}
                except json.JSONDecodeError:
                    return {"ok": False, "error": f"JSON degil (HTTP {status}): {text[:200]}"}
            return {"ok": False, "error": _state["detail"] or "oturum yenilenemedi"}
        except Exception as e:
            _state["state"] = "hata"
            _state["detail"] = str(e)[:200]
            return {"ok": False, "error": str(e)[:300]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return LOCAL_TOKEN and self.headers.get("x-rg-token") == LOCAL_TOKEN

    def do_GET(self):
        if not self._auth_ok():
            self._send(401, {"error": "unauthorized"})
            return
        if self.path == "/health":
            self._send(200, {
                "ok": _state["state"] == "hazir",
                "state": _state["state"],
                "detail": _state["detail"],
                "lastOk": _state["lastOk"],
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth_ok():
            self._send(401, {"error": "unauthorized"})
            return
        if self.path != "/api":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            result = api_call(payload)
            self._send(200 if result.get("ok") else 502, result)
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    log("rackghost oturum servisi basliyor (127.0.0.1:3210, browser'siz)")
    threading.Thread(target=lambda: api_call({"action": "ongoing", "api": 2}), daemon=True).start()
    HTTPServer(("127.0.0.1", 3210), Handler).serve_forever()
