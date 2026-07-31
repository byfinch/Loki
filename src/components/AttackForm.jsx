import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import CyberCard from './CyberCard';
import CyberSelect from './CyberSelect';

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
  const { state, setMethods, startTest, addLog, addLoop, showToast, setAttackPrefill } = useStressTest();

  const [host, setHost] = useState('');
  const [port, setPort] = useState(53);
  const [time, setTime] = useState(60);
  const [concurrents, setConcurrents] = useState(1);
  const concurrentsRef = useRef(null);
  const [method, setMethod] = useState('');
  const [layer, setLayer] = useState('L4');
  const [loading, setLoading] = useState(false);
  const [congestion, setCongestion] = useState({});

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
    // Hizli L4/L7 toggle'inda eski istegin yaniti yeniyi ezmesin
    let cancelled = false;

    // Method her zaman secili layer'a uygun gecerli bir degere resetlensin (fallback: ilk eleman)
    const applyLayerMethods = (data) => {
      const layerMethods = data.filter((m) => {
        const isLayerMatch = layer === 'L4' ? m.IsLayer4 : m.IsLayer7;
        const isFreeMethod = m.method?.toUpperCase().startsWith('FREE-') || m.IsFree;
        return isLayerMatch && !isFreeMethod;
      });
      setMethod((prev) =>
        layerMethods.some((m) => m.method === prev) ? prev : (layerMethods[0]?.method || '')
      );
    };

    const loadMethods = async () => {
      // state.methods zaten cache'liyse yeniden fetch etme; sadece layer'a gore filtrele
      if (state.methods.length > 0) {
        applyLayerMethods(state.methods);
        return;
      }
      // Upstream gecici yavaslayabilir; birkac kez dene
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const data = await apiClient.getMethods();
          if (cancelled) return;
          setMethods(data);
          applyLayerMethods(data);
          return;
        } catch (err) {
          if (cancelled) return;
          addLog(`Yöntemler yüklenemedi (deneme ${attempt}/${maxAttempts}): ${err.message}`);
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 4000));
        }
      }
    };

    if (state.isAuthenticated) loadMethods();
    return () => { cancelled = true; };
  }, [state.isAuthenticated, layer]);

  // L4/L7 gecisinde port default'unu ayarla
  useEffect(() => {
    if (layer === 'L7') {
      setPort(443);
    } else {
      setPort(53);
    }
  }, [layer]);

  // Method yogunluk durumu: 45sn'de bir yenile, unmount'ta interval'i temizle
  useEffect(() => {
    if (!state.isAuthenticated) return undefined;
    let cancelled = false;
    const loadCongestion = async () => {
      try {
        const data = await apiClient.getMethodCongestion();
        if (!cancelled) setCongestion(data || {});
      } catch {
        // Rozet opsiyonel bilgi; hata durumunda sessizce gec
      }
    };
    loadCongestion();
    const interval = setInterval(loadCongestion, 45000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [state.isAuthenticated]);

  // PhishPanel "Hedef Al" prefill'ini tek seferlik tuket: formu doldur ve state'i temizle
  useEffect(() => {
    if (!state.attackPrefill) return;
    const { host: prefillHost, layer: prefillLayer, port: prefillPort } = state.attackPrefill;
    if (prefillHost) setHost(prefillHost);
    if (prefillLayer === 'L4' || prefillLayer === 'L7') setLayer(prefillLayer);
    if (prefillPort) setPort(prefillPort);
    setAttackPrefill(null);
  }, [state.attackPrefill, setAttackPrefill]);

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

    // L4 katmaninda hedef sadece IP/domain olmalidir; URL protokolu/path kabul edilmez
    if (layer === 'L4' && /https?:\/\/|\//.test(host.trim())) {
      addLog('L4 saldırılarında hedef sadece IP veya domain olmalıdır (örn: 1.1.1.1)');
      showToast('L4 hedefinde URL protokolü (https://) veya / kullanılamaz', 'error');
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
    const effectivePort = layer === 'L7' ? 443 : parseInt(port, 10);
    // Input'tan gercek degeri dogrudan oku; state gecikmesi olursa bile dogru deger gider
    const inputConcurrents = concurrentsRef.current ? parseInt(concurrentsRef.current.value, 10) : parseInt(concurrents, 10);
    const effectiveConcurrents = Math.max(1, inputConcurrents || 1);

    try {
      const payload = {
        host: normalizedHost,
        port: effectivePort,
        layer,
        time: parseInt(time, 10),
        method,
        subnet: '32',
        geo: 'worldwide',
        concurrents: effectiveConcurrents,
        interval: parseInt(loopInterval, 10),
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
            time: parseInt(time, 10),
            method,
            subnet: '32',
            geo: 'worldwide',
            concurrents: effectiveConcurrents,
            interval: parseInt(loopInterval, 10),
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
    <CyberCard className="p-6 sm:p-7">
      <div className="inline-flex gap-1 p-1 bg-black/40 border border-white/10 rounded-lg mb-6">
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

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-[11px] font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
            {layer === 'L4' ? 'Hedef IP' : 'Hedef URL'}
          </label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={layer === 'L4' ? '1.1.1.1' : 'https://example.com'}
            className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
            required
          />
        </div>

        <div className={`grid gap-4 ${layer === 'L7' ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Süre (sn)</label>
            <input
              type="number"
              min={getMinTime(method, layer)}
              max={state.plan?.MaxTime || 86400}
              value={time}
              onChange={(e) => setTime(parseInt(e.target.value, 10) || 0)}
              className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
              required
            />
            <p className="text-[10px] text-gray-500 mt-0.5">
              Minimum: {getMinTime(method, layer)} sn
            </p>
          </div>
          {layer === 'L4' && (
            <div>
              <label className="block text-[11px] font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
                className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
                required
              />
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider">Yöntem</label>
            {congestion[method?.toLowerCase()]?.busy && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/30">
                Yoğun
              </span>
            )}
          </div>
          <CyberSelect
            value={method}
            onChange={setMethod}
            options={filteredMethods.map((m) => {
              const busy = congestion[m.method?.toLowerCase()]?.busy;
              return {
                value: m.method,
                label: busy ? `${m.method} · Yoğun` : m.method,
                description: m.description
              };
            })}
            placeholder="Yöntem seç"
            emptyPlaceholder="Yöntemler yükleniyor..."
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Concurrents</label>
          <input
            ref={concurrentsRef}
            type="number"
            min={1}
            max={state.plan?.Concurrents || 80}
            value={concurrents}
            onChange={(e) => setConcurrents(parseInt(e.target.value, 10) || 1)}
            className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
          />
        </div>

        {/* Loop toggle */}
        <div className="flex items-center justify-between bg-black/40 border border-white/10 rounded-lg p-4 hover:border-green-500/20 transition-colors">
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
            <label className="block text-[11px] font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Bekleme (sn)</label>
            <input
              type="number"
              min={0}
              value={loopInterval}
              onChange={(e) => setLoopInterval(parseInt(e.target.value, 10) || 0)}
              className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:border-green-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(0,255,65,0.1)] transition"
              required
            />
            <p className="text-[10px] text-gray-500 mt-0.5">Bir set bittikten sonraki bekleme süresi</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !state.plan}
          className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-black text-sm font-bold py-2.5 rounded-lg transition-all duration-300 hover:shadow-[0_0_25px_rgba(0,255,65,0.35)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none"
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
    </CyberCard>
  );
};

export default AttackForm;
