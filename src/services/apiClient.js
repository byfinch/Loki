/**
 * apiClient.js
 * Loki Panel Backend API istemcisi
 */

const API_BASE = '/api';

function getHeaders() {
  const sessionId = localStorage.getItem('lokiSessionId');
  return {
    'Content-Type': 'application/json',
    'sessionId': sessionId || ''
  };
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
    throw new Error(data.message || `HTTP ${response.status}`);
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
    const res = await fetch(`${API_BASE}/stresse/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
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
    const res = await fetch(`${API_BASE}/stresse/user/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async getPlan(username) {
    const res = await fetch(`${API_BASE}/stresse/plan/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Methods
  async getMethods() {
    const res = await fetch(`${API_BASE}/stresse/methods`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Ongoing
  async getOngoing(username) {
    const res = await fetch(`${API_BASE}/stresse/ongoing/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  // Attack
  async startAttack(payload) {
    const res = await fetch(`${API_BASE}/stresse/attack`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    return handleResponse(res);
  },

  async startAttacks(payload) {
    const res = await fetch(`${API_BASE}/stresse/attack/bulk`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    return handleResponse(res);
  },

  // History
  async getHistory(username) {
    const res = await fetch(`${API_BASE}/stresse/history/${username}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async deleteHistory(options = {}) {
    const res = await fetch(`${API_BASE}/stresse/history`, {
      method: 'DELETE',
      headers: getHeaders(),
      body: JSON.stringify(options)
    });
    return handleResponse(res);
  },

  // Loop
  async startLoop(payload) {
    const res = await fetch(`${API_BASE}/stresse/loop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    return handleResponse(res);
  },

  async stopLoop(loopId) {
    const res = await fetch(`${API_BASE}/stresse/loop/stop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(loopId ? { loopId } : {})
    });
    return handleResponse(res);
  },

  async getLoops() {
    const res = await fetch(`${API_BASE}/stresse/loops`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async getLoopStatus(loopId) {
    const res = await fetch(`${API_BASE}/stresse/loop/${loopId}`, {
      headers: getHeaders()
    });
    return handleResponse(res);
  },

  async stopAttack(id) {
    const res = await fetch(`${API_BASE}/stresse/stop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ id })
    });
    return handleResponse(res);
  },

  async stopAttacks(ids) {
    const res = await fetch(`${API_BASE}/stresse/stop/bulk`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ids })
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
    const res = await fetch(`${API_BASE}/check-host?host=${encodeURIComponent(host)}&type=${type}`, {
      headers: getHeaders()
    });
    const data = await handleResponse(res);
    return { ...data, type: 'check-host' };
  },

  async getPingPe(host) {
    const res = await fetch(`${API_BASE}/ping-pe?host=${encodeURIComponent(host)}`, {
      headers: getHeaders()
    });
    const data = await handleResponse(res);
    return { ...data, type: 'ping-pe' };
  },

  async searchFofa(query, email, key, size = 10) {
    const res = await fetch(
      `${API_BASE}/fofa?query=${encodeURIComponent(query)}&email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&size=${size}`,
      { headers: getHeaders() }
    );
    const data = await handleResponse(res);
    return { ...data, type: 'fofa' };
  }
};
