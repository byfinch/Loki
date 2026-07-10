import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

function normalizeHost(host) {
  if (!host || typeof host !== 'string') return host;
  let h = host.trim();
  h = h.replace(/^https?:\/\//i, '');
  h = h.split('/')[0];
  h = h.replace(/:\d+$/, '');
  return h;
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u;
  }
  if (!u.endsWith('/')) {
    u += '/';
  }
  return u;
}

const METHOD_MIN_TIME = {
  'HTTP-TEMPESTA': 200
};
const L7_MIN_TIME = 60;
const L4_MIN_TIME = 60;

function getMinTime(method, layer) {
  if (METHOD_MIN_TIME[method?.toUpperCase()]) return METHOD_MIN_TIME[method.toUpperCase()];
  if (layer === 'L7') return L7_MIN_TIME;
  return L4_MIN_TIME;
}

const AttackForm = () => {
  const { state, setMethods, startTest, stopTest, addLog, addLoop, removeLoop, showToast } = useStressTest();

  const [host, setHost] = useState('');
  const [port, setPort] = useState(53);
  const [time, setTime] = useState(60);
  const [concurrents, setConcurrents] = useState(1);
  const concurrentsRef = useRef(null);
  const [method, setMethod] = useState('');
  const [layer, setLayer] = useState('L4');
  const [loading, setLoading] = useState(false);

  // Loop controls (integrated into the same form)
  const [loopActive, setLoopActive] = useState(false);
  const [loopInterval, setLoopInterval] = useState(5);
  const [starting, setStarting] = useState(false);

  const withMinimumLoading = async (fn, minMs = 1000) => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < minMs) {
        await new Promise((r) => setTimeout(r, minMs - elapsed));
      }
    }
  };

  useEffect(() => {
    const loadMethods = async () => {
      try {
        const data = await apiClient.getMethods();
        setMethods(data);
        // İlk uygun (ücretsiz olmayan, layera uygun) methodu otomatik seç
        const defaultMethod = data.find((m) => {
          const isLayerMatch = layer === 'L4' ? m.IsLayer4 : m.IsLayer7;
          const isFreeMethod = m.method?.toUpperCase().startsWith('FREE-') || m.IsFree;
          return isLayerMatch && !isFreeMethod;
        });
        if (defaultMethod) setMethod(defaultMethod.method);
      } catch (err) {
        addLog(`Yöntemler yüklenemedi: ${err.message}`);
      }
    };

    if (state.isAuthenticated) loadMethods();
  }, [state.isAuthenticated, layer]);

  // L4/L7 gecisinde port default'unu ayarla
  useEffect(() => {
    if (layer === 'L7') {
      setPort(443);
    } else {
      setPort(53);
    }
  }, [layer]);

  // Method degisince sureyi minimuma cek
  useEffect(() => {
    const minTime = getMinTime(method, layer);
    if (time < minTime) {
      setTime(minTime);
    }
  }, [method, layer]);

  const filteredMethods = state.methods.filter(m => {
    const isLayerMatch = layer === 'L4' ? m.IsLayer4 : m.IsLayer7;
    const isFreeMethod = m.method?.toUpperCase().startsWith('FREE-') || m.IsFree;
    return isLayerMatch && !isFreeMethod;
  });

  const validateLimits = () => {
    const minTime = getMinTime(method, layer);
    if (time < minTime) {
      return { ok: false, message: `Minimum süre ${minTime} saniye (${method})` };
    }

    if (!state.plan) return { ok: true };

    const maxTime = state.plan.MaxTime || 86400;
    const maxConcurrents = state.plan.Concurrents || 80;

    if (time > maxTime) {
      return { ok: false, message: `Maksimum süre ${maxTime} saniye olabilir` };
    }
    if (concurrents > maxConcurrents) {
      return { ok: false, message: `Maksimum concurrent ${maxConcurrents} olabilir` };
    }
    return { ok: true };
  };

  const getNormalizedTarget = () => {
    return layer === 'L7' ? normalizeUrl(host) : normalizeHost(host);
  };

  const isTargetBusyInState = () => {
    const normalized = getNormalizedTarget();
    return Object.entries(state.activeLoops).find(([_, loop]) =>
      loop.params?.host === normalized &&
      loop.params?.layer === layer &&
      loop.params?.method === method &&
      loop.running
    )?.[0];
  };

  const isTargetBusyOnBackend = async () => {
    try {
      const data = await apiClient.getLoops();
      const normalized = getNormalizedTarget();
      return (data.loops || []).find(
        (loop) =>
          loop.params?.host === normalized &&
          loop.params?.layer === layer &&
          loop.params?.method === method
      );
    } catch (err) {
      addLog(`Loop kontrolü yapılamadı: ${err.message}`);
      return null;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (loading) return; // Cift tiklamayi onle

    const validation = validateLimits();
    if (!validation.ok) {
      addLog(`Limit hatası: ${validation.message}`);
      return;
    }

    if (!host || !method) {
      addLog('Hedef ve yöntem zorunludur');
      return;
    }

    setLoading(true);
    if (loopActive) setStarting(true);

    const busyLoopId = isTargetBusyInState();
    if (busyLoopId) {
      setLoading(false);
      setStarting(false);
      addLog(`Bu hedef için zaten aktif loop var: ${busyLoopId}`);
      showToast('Bu hedef için aktif loop var. Önce loopu durdurun.', 'warning');
      return;
    }

    const busyLoopOnBackend = await isTargetBusyOnBackend();
    if (busyLoopOnBackend) {
      setLoading(false);
      setStarting(false);
      addLog(`Bu hedef için sunucuda aktif loop var: ${busyLoopOnBackend.loopId}`);
      showToast('Bu hedef için sunucuda aktif loop var. Önce loopu durdurun.', 'warning');
      return;
    }

    const normalizedHost = layer === 'L7' ? normalizeUrl(host) : normalizeHost(host);
    const effectivePort = layer === 'L7' ? 443 : parseInt(port);
    // Input'tan gercek degeri dogrudan oku; state gecikmesi olursa bile dogru deger gider
    const inputConcurrents = concurrentsRef.current ? parseInt(concurrentsRef.current.value) : parseInt(concurrents);
    const effectiveConcurrents = Math.max(1, inputConcurrents || 1);

    try {
      const payload = {
        host: normalizedHost,
        port: effectivePort,
        layer,
        time: time.toString(),
        method,
        subnet: '32',
        geo: 'worldwide',
        concurrents: effectiveConcurrents,
        interval: parseInt(loopInterval),
        infinite: loopActive
      };

      if (loopActive) {
        addLog(`Loop saldırısı başlatılıyor: ${host}:${port} (${method})`);
        const loopRes = await withMinimumLoading(() => apiClient.startLoop({ ...payload }));
        const loopId = loopRes?.loopId;
        if (!loopId) throw new Error('Sunucu loop ID dondurmedi');
        // Sadece backend basarili olursa state'e ekle
        addLoop(loopId, {
          params: {
            host: normalizedHost,
            port: effectivePort,
            layer,
            time: parseInt(time),
            method,
            subnet: '32',
            geo: 'worldwide',
            concurrents: effectiveConcurrents,
            interval: parseInt(loopInterval),
            infinite: true
          },
          startedAt: new Date().toISOString(),
          lastRoundAt: null,
          roundCount: 0,
          errors: 0
        });
        startTest(`loop_${loopId}`);
        showToast('Loop başlatıldı', 'success');
      } else {
        const data = await withMinimumLoading(() => apiClient.startAttacks(payload));
        if (!data) throw new Error('Sunucu yanıtı boş döndü');

        const ok = data.successCount ?? 0;
        const fail = data.failCount ?? 0;
        const total = data.total ?? (ok + fail);

        if (ok === 0) {
          const reason = data.data?.message || data.message || `${fail}/${total} saldırı başarısız`;
          throw new Error(`Saldırı başlatılamadı: ${reason}`);
        }

        startTest(data.attack_id || `attack_${Date.now()}`);
        addLog(`Saldırı başlatıldı: ${method} -> ${host}:${port} (${time}s) x${ok} başarılı${fail > 0 ? `, ${fail} başarısız` : ''}`);
        showToast(`${ok} adet saldırı başlatıldı${fail > 0 ? ` (${fail} başarısız)` : ''}`, fail > 0 ? 'warning' : 'success');
      }

      if (!loopActive) setHost('');
    } catch (err) {
      addLog(`Saldırı hatası: ${err.message}`);
      showToast(`Hata: ${err.message}`, 'error');
    } finally {
      setLoading(false);
      setStarting(false);
    }
  };

  return (
    <div className="glass-panel rounded-xl p-4 hover-glow transition-all duration-300">
      <div className="inline-flex gap-1 p-1 bg-black/40 border border-white/10 rounded-lg mb-4">
        {['L4', 'L7'].map((tab) => (
          <button
            key={tab}
            onClick={() => setLayer(tab)}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all duration-300 ${
              layer === tab
                ? 'bg-green-500 text-black shadow-[0_0_10px_rgba(0,255,65,0.4)]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">
            {layer === 'L4' ? 'Hedef IP' : 'Hedef URL'}
          </label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={layer === 'L4' ? '1.1.1.1' : 'https://example.com'}
            className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
            required
          />
        </div>

        <div className={`grid gap-3 ${layer === 'L7' ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">Süre (sn)</label>
            <input
              type="number"
              min={getMinTime(method, layer)}
              max={state.plan?.MaxTime || 86400}
              value={time}
              onChange={(e) => setTime(parseInt(e.target.value) || 0)}
              className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
              required
            />
            <p className="text-[10px] text-gray-500 mt-0.5">
              Minimum: {getMinTime(method, layer)} sn
            </p>
          </div>
          {layer === 'L4' && (
            <div>
              <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value) || 0)}
                className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
                required
              />
            </div>
          )}
        </div>

        <div>
          <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">Yöntem</label>
          <div className="relative">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 pr-8 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition appearance-none"
              required
            >
              {filteredMethods.map((m) => (
                <option key={m.method} value={m.method}>
                  {m.method} - {m.description}
                </option>
              ))}
            </select>
            <svg
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">Concurrents</label>
          <input
            ref={concurrentsRef}
            type="number"
            min={1}
            max={state.plan?.Concurrents || 80}
            value={concurrents}
            onChange={(e) => setConcurrents(parseInt(e.target.value) || 1)}
            className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
          />
        </div>

        {/* Loop toggle */}
        <div className="flex items-center justify-between bg-black/40 border border-white/10 rounded-lg p-3 hover:border-green-500/20 transition-colors">
          <div>
            <p className="text-xs font-bold text-white">Loop Aktif</p>
            <p className="text-[10px] text-gray-500">Açıkken saldırılar bittikçe otomatik tekrar başlar</p>
          </div>
          <button
            type="button"
            onClick={() => setLoopActive(!loopActive)}
            className={`w-10 h-5 rounded-full transition relative ${loopActive ? 'bg-green-500 shadow-[0_0_10px_rgba(0,255,65,0.4)]' : 'bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition ${loopActive ? 'left-5' : 'left-0.5'}`}></span>
          </button>
        </div>

        {loopActive && (
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1 uppercase tracking-wider">Bekleme (sn)</label>
            <input
              type="number"
              min={0}
              value={loopInterval}
              onChange={(e) => setLoopInterval(parseInt(e.target.value) || 0)}
              className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
              required
            />
            <p className="text-[10px] text-gray-500 mt-0.5">Bir set bittikten sonraki bekleme süresi</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !state.plan}
          className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-black text-sm font-bold py-2 rounded-lg transition-all duration-300 hover:shadow-[0_0_25px_rgba(0,255,65,0.35)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none"
        >
          {!state.plan
            ? 'Plan yükleniyor...'
            : loading
              ? loopActive ? (starting ? 'Loop başlatılıyor...' : 'Başlatılıyor...') : 'Başlatılıyor...'
              : loopActive
                ? 'Loop Başlat'
                : 'Saldırı Başlat'}
        </button>
      </form>
    </div>
  );
};

export default AttackForm;
