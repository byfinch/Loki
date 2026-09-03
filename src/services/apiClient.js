/**
 * apiClient.js
 * Loki Panel Backend API istemcisi
 */

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 30000;
// Login ve saldiri baslatma backend uzerinden stresse.st'e ardisik cagri yaptigi
// icin daha uzun surebilir; bu isteklere genis timeout verilir.
const SLOW_REQUEST_TIMEOUT_MS = 90000;
// Coklu hesap kayit defterinin localStorage anahtari
const ACCOUNTS_KEY = 'lokiAccounts';

function getHeaders() {
  const sessionId = localStorage.getItem('lokiSessionId');
  return {
    'Content-Type': 'application/json',
    'sessionId': sessionId || ''
  };
}

function getRequestOptions(extra = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return { signal: AbortSignal.timeout(timeoutMs), ...extra };
}

async function apiFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, getRequestOptions(options, timeoutMs));
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Sunucu yanıt vermedi (zaman aşımı). Lütfen tekrar deneyin.');
    }
    throw err;
  }
}

async function handleResponse(response) {
  let data = {};
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    // Parse hatasi durumunda ham govdeyi gorebilmek icin clone ediyoruz
    const cloned = response.clone();
    try {
      data = await response.json();
    } catch (parseErr) {
      const text = await cloned.text().catch(() => '');
      throw new Error(`Sunucu yanıtı JSON değil: ${text.slice(0, 200) || parseErr.message}`);
    }
  }
  if (!response.ok) {
    // HTTP status kodunu hataya yansit ki cagiran oturum hatasini (401/403) ayirabilsin
    const err = new Error(data.message || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  // Backend bazen 200 OK ile { status: 'error', message: '...' } donebilir
  if (data && data.status === 'error') {
    throw new Error(data.message || 'Bir hata oluştu');
  }
  return data;
}

export const apiClient = {
  // --- Hesap kayit defteri (coklu hesap gecisi) ---
  // localStorage'da ACCOUNTS_KEY altinda [{ username, sessionId, addedAt }] tutulur.
  // Aktif oturum anahtarlari (lokiSessionId/lokiUsername) tek gercek kaynaktir;
  // defter sadece onceki oturumlarin sifresiz geri acilabilmesi icin sessionId saklar.
  _readAccounts() {
    try {
      const raw = localStorage.getItem(ACCOUNTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((a) => a && a.username && a.sessionId) : [];
    } catch {
      return [];
    }
  },

  _writeAccounts(list) {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  },

  getAccounts() {
    return this._readAccounts();
  },

  // Aktif session anahtarlarini hedef hesaba cevirir; hesap yoksa false doner.
  switchAccount(username) {
    const account = this._readAccounts().find((a) => a.username === username);
    if (!account) return false;
    localStorage.setItem('lokiSessionId', account.sessionId);
    localStorage.setItem('lokiUsername', account.username);
    return true;
  },

  // Backend'de yasayan tum hesaplari getirir (onceden giris sarti olmadan
  // listede gorunurler; ortak panelde herkes her hesapa gecebilir).
  async getServerAccounts() {
    const res = await apiFetch(`${API_BASE}/accounts`, { headers: getHeaders() });
    const data = await handleResponse(res);
    return Array.isArray(data.accounts) ? data.accounts : [];
  },

  // Bilinen ama canli oturumu olmayan hesap icin backend'de session acar
  // (arka planda login); sessionId dondurur.
  async ensureAccountSession(username) {
    const res = await apiFetch(`${API_BASE}/accounts/ensure`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username })
    });
    const data = await handleResponse(res);
    if (!data.sessionId) throw new Error('Oturum açılamadı');
    return data.sessionId;
  },

  // Hesaba ozel sayaclar: aktif, toplam baslatilan, bugun baslatilan.
  async getStats() {
    const res = await apiFetch(`${API_BASE}/stresse/stats`, { headers: getHeaders() });
    const data = await handleResponse(res);
    return data.stats || {};
  },

  // Aktif oturumu dogrudan verilen hesap/session ile ayarlar (backend listesinden secim).
  setActiveSession(username, sessionId) {
    localStorage.setItem('lokiSessionId', sessionId);
    localStorage.setItem('lokiUsername', username);
  },

  removeAccount(username) {
    this._writeAccounts(this._readAccounts().filter((a) => a.username !== username));
  },

  // Defteri guncellemeden sadece aktif oturum anahtarlarini temizler
  // ("Hesap Ekle" akisinda kayitli hesaplar korunur).
  clearActiveSession() {
    localStorage.removeItem('lokiSessionId');
    localStorage.removeItem('lokiUsername');
  },

  // Auth
  async login(username, password) {
    const res = await apiFetch(`${API_BASE}/stresse/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }, SLOW_REQUEST_TIMEOUT_MS);
    const data = await handleResponse(res);
    if (data.sessionId) {
      const resolvedUsername = data.user?.username || username;
      localStorage.setItem('lokiSessionId', data.sessionId);
      localStorage.setItem('lokiUsername', resolvedUsername);
      // Hesabi kayit defterine ekle/guncelle (sessionId yenilenir, addedAt korunur)
      const list = this._readAccounts();
      const existing = list.find((a) => a.username === resolvedUsername);
      if (existing) {
        existing.sessionId = data.sessionId;
      } else {
        list.push({ username: resolvedUsername, sessionId: data.sessionId, addedAt: Date.now() });
      }
      this._writeAccounts(list);
    }
    return data;
  },

  // Cikis: sadece aktif oturumu kapatir; hesap defterde KALIR ki kullanici
  // daha sonra sifre girmeden geri donebilsin. Defterden silme (removeAccount)
  // logout'ta yapilmaz; App.jsx'teki 401 akisi oturum gercekten olmusse siler.
  logout() {
    this.clearActiveSession();
  },

  getSessionId() {
    return localStorage.getItem('lokiSessionId');
  },

  getUsername() {
    return localStorage.getItem('lokiUsername');
  },

  // User & Plan
  async getUser(username) {
    const res = await apiFetch(`${API_BASE}/stresse/user/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async getPlan(username) {
    const res = await apiFetch(`${API_BASE}/stresse/plan/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Methods
  async getMethods() {
    const res = await apiFetch(`${API_BASE}/stresse/methods`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Ongoing
  async getOngoing(username) {
    const res = await apiFetch(`${API_BASE}/stresse/ongoing/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Attack
  async startAttacks(payload) {
    const res = await apiFetch(`${API_BASE}/stresse/attack/bulk`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    }, SLOW_REQUEST_TIMEOUT_MS);
    return handleResponse(res);
  },

  // History
  async getHistory(username) {
    const res = await apiFetch(`${API_BASE}/stresse/history/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async deleteHistory(options = {}) {
    const res = await apiFetch(`${API_BASE}/stresse/history`, {
      method: 'DELETE',
      headers: getHeaders(),
      body: JSON.stringify(options)
    });
    return handleResponse(res);
  },

  // Loop
  async startLoop(payload) {
    const res = await apiFetch(`${API_BASE}/stresse/loop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    }, SLOW_REQUEST_TIMEOUT_MS);
    return handleResponse(res);
  },

  async stopLoop(loopId) {
    const res = await apiFetch(`${API_BASE}/stresse/loop/stop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(loopId ? { loopId } : {})
    });
    return handleResponse(res);
  },

  // Calisan loop'un notunu / gelecek tur ayarlarini guncelle
  // Not: POST kullaniliyor; sunucudaki LiteSpeed ModSecurity PUT'u engelliyor.
  async editLoop(loopId, fields) {
    const res = await apiFetch(`${API_BASE}/stresse/loop/edit`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ loopId, ...fields })
    });
    return handleResponse(res);
  },

  async getLoops() {
    const res = await apiFetch(`${API_BASE}/stresse/loops`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async stopAttack(id) {
    const res = await apiFetch(`${API_BASE}/stresse/stop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ id })
    });
    return handleResponse(res);
  },

  // Etki Monitoru
  async getImpact() {
    const res = await apiFetch(`${API_BASE}/impact`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Method congestion
  async getMethodCongestion() {
    const res = await apiFetch(`${API_BASE}/method-congestion`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },


  // Live SSE
  // EventSource constructor header desteklemez, sessionId'yi kisa query anahtari ile gonderiyoruz.
  connectLiveStream(username, onData, onError) {
    const sessionId = this.getSessionId();
    const url = `${API_BASE}/stresse/live/${username}?sid=${encodeURIComponent(sessionId || '')}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onData(data);
      } catch (err) {
        onError(err);
      }
    };

    eventSource.onerror = (err) => {
      onError(err);
    };

    return eventSource;
  },

  // PhishGuard
  async getPhishAlerts(params = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', params.limit);
    if (params.offset) query.set('offset', params.offset);
    if (params.brand) query.set('brand', params.brand);
    if (params.band) query.set('band', params.band);
    const qs = query.toString();
    const res = await apiFetch(`${API_BASE}/phish/alerts${qs ? `?${qs}` : ''}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async getPhishStats() {
    const res = await apiFetch(`${API_BASE}/phish/stats`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // ---- Link Gozcusu (watch) ----
  async getWatchState() {
    const res = await apiFetch(`${API_BASE}/watch/state`, { headers: getHeaders() });
    return handleResponse(res);
  },
  async addWatchKeyword(keyword, label) {
    const res = await apiFetch(`${API_BASE}/watch/keywords`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ keyword, label }) });
    return handleResponse(res);
  },
  async removeWatchKeyword(keyword) {
    // LiteSpeed ModSecurity DELETE'i engelliyor; POST /remove kullaniliyor.
    const res = await apiFetch(`${API_BASE}/watch/keywords/remove`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ keyword }) });
    return handleResponse(res);
  },
  async addWatchSite(site) {
    const res = await apiFetch(`${API_BASE}/watch/sites`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ site }) });
    return handleResponse(res);
  },
  async removeWatchSite(site) {
    const res = await apiFetch(`${API_BASE}/watch/sites/remove`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ site }) });
    return handleResponse(res);
  },
  async triggerWatchScan() {
    const res = await apiFetch(`${API_BASE}/watch/scan`, { method: 'POST', headers: getHeaders() });
    return handleResponse(res);
  }
};
