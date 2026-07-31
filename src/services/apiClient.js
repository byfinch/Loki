/**
 * apiClient.js
 * Loki Panel Backend API istemcisi
 */

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 30000;
// Login ve saldiri baslatma backend uzerinden stresse.st'e ardisik cagri yaptigi
// icin daha uzun surebilir; bu isteklere genis timeout verilir.
const SLOW_REQUEST_TIMEOUT_MS = 90000;

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
  // Auth
  async login(username, password) {
    const res = await apiFetch(`${API_BASE}/stresse/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }, SLOW_REQUEST_TIMEOUT_MS);
    const data = await handleResponse(res);
    if (data.sessionId) {
      localStorage.setItem('lokiSessionId', data.sessionId);
      localStorage.setItem('lokiUsername', data.user?.username || username);
    }
    return data;
  },

  logout() {
    localStorage.removeItem('lokiSessionId');
    localStorage.removeItem('lokiUsername');
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

  // Tools
  async checkHost(host, type = 'ping') {
    const res = await apiFetch(`${API_BASE}/check-host?host=${encodeURIComponent(host)}&type=${type}`, {
      headers: getHeaders()
    });
    const data = await handleResponse(res);
    return { ...data, type: 'check-host' };
  },

  async getPingPe(host) {
    const res = await apiFetch(`${API_BASE}/ping-pe?host=${encodeURIComponent(host)}`, {
      headers: getHeaders()
    });
    const data = await handleResponse(res);
    return { ...data, type: 'ping-pe' };
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
  }
};
