import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
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

// stresse.st'in destekledigi geo degerleri (hub formundaki liste)
const GEO_OPTIONS = [
  { value: 'worldwide', label: 'Worldwide (varsayılan)' },
  { value: 'china', label: 'China' },
  { value: 'russia', label: 'Russia' },
  { value: 'brazil', label: 'Brazil' },
  { value: 'korea', label: 'Korea' },
  { value: 'turkey', label: 'Turkey' },
  { value: 'thailand', label: 'Thailand' },
  { value: 'japan', label: 'Japan' },
  { value: 'vietnam', label: 'Vietnam' },
  { value: 'indonesia', label: 'Indonesia' },
  { value: 'iran', label: 'Iran' }
];

function getMinTime(method, layer) {
  if (METHOD_MIN_TIME[method?.toUpperCase()]) return METHOD_MIN_TIME[method.toUpperCase()];
  if (layer === 'L7') return L7_MIN_TIME;
  return L4_MIN_TIME;
}

const AttackForm = () => {
  const { state, setMethods, addLog, addLoop, showToast, setAttackPrefill } = useStressTest();

  const [host, setHost] = useState('');
  const [port, setPort] = useState(53);
  const [time, setTime] = useState(60);
  const [concurrents, setConcurrents] = useState(1);
  const [geo, setGeo] = useState('worldwide');
  const concurrentsRef = useRef(null);
  const [method, setMethod] = useState('');
  const [layer, setLayer] = useState('L4');
  const [loading, setLoading] = useState(false);
  const [congestion, setCongestion] = useState({});
  const [note, setNote] = useState('');

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
        geo,
        concurrents: effectiveConcurrents,
        interval: parseInt(loopInterval, 10),
        infinite: loopActive,
        note: note.trim()
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
            geo,
            concurrents: effectiveConcurrents,
            interval: parseInt(loopInterval, 10),
            infinite: true
          },
          startedAt: new Date().toISOString(),
          lastRoundAt: null,
          roundCount: 0,
          errors: 0
        });
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

        addLog(`Saldırı başlatıldı: ${method} -> ${host}:${port} (${time}s) x${ok} başarılı${fail > 0 ? `, ${fail} başarısız` : ''}`);
        showToast(`${ok} adet saldırı başlatıldı${fail > 0 ? ` (${fail} başarısız)` : ''}`, fail > 0 ? 'warning' : 'success');
      }

      if (!loopActive) { setHost(''); setNote(''); }
    } catch (err) {
      addLog(`Saldırı hatası: ${err.message}`);
      showToast(`Hata: ${err.message}`, 'error');
    } finally {
      setLoading(false);
      setStarting(false);
    }
  };

  return (
    <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
      {/* CRT scanline dokusu */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }}
      />

      {/* Title bar */}
      <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        <span className="text-green-300/90">root@loki:~/saldiri-baslat</span>
        <span className="text-green-500/60">$ ./launch.sh --interactive</span>
        <span className="animate-pulse">▊</span>
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        {/* L4/L7 secimi */}
        <div className="mb-5 inline-flex overflow-hidden rounded-sm border border-green-500/30">
          {['L4', 'L7'].map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setLayer(tab)}
              className={`px-4 py-1.5 text-[11px] font-bold transition-all ${
                layer === tab
                  ? 'bg-green-500/15 text-green-400 [text-shadow:0_0_8px_rgba(0,255,65,0.6)]'
                  : 'text-green-500/50 hover:text-green-400'
              }`}
            >
              [{tab}]
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">
              &gt; {layer === 'L4' ? 'hedef_ip' : 'hedef_url'}
            </label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={layer === 'L4' ? '1.1.1.1' : 'https://example.com'}
              className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 placeholder-green-500/30 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
              required
            />
          </div>

          <div className={`grid gap-3 ${layer === 'L7' ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <div>
              <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; sure_sn</label>
              <input
                type="number"
                min={getMinTime(method, layer)}
                max={state.plan?.MaxTime || 86400}
                value={time}
                onChange={(e) => setTime(parseInt(e.target.value, 10) || 0)}
                className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
                required
              />
              <p className="mt-0.5 text-[9px] text-gray-600"># minimum: {getMinTime(method, layer)} sn</p>
            </div>
            {layer === 'L4' && (
              <div>
                <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
                  required
                />
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-[10px] tracking-wider text-green-500/55">&gt; yontem</label>
              {congestion[method?.toLowerCase()]?.busy && (
                <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-400">
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
            <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; concurrents</label>
            <input
              ref={concurrentsRef}
              type="number"
              min={1}
              max={state.plan?.Concurrents || 80}
              value={concurrents}
              onChange={(e) => setConcurrents(parseInt(e.target.value, 10) || 1)}
              className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; geo <span className="text-cyan-400/80">(opsiyonel)</span></label>
            <select
              value={geo}
              onChange={(e) => setGeo(e.target.value)}
              className="w-full appearance-none rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
            >
              {GEO_OPTIONS.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </div>

          {/* Not alani (opsiyonel) */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">
              &gt; not <span className="text-cyan-400/80">(opsiyonel)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={120}
              placeholder="Marka / asıl site linki (ör: VegasSlot — https://vegasslot.com/)"
              className="w-full rounded-sm border border-dashed border-cyan-500/40 bg-black px-3 py-2.5 text-[13px] text-cyan-300 placeholder-cyan-700/50 placeholder:italic transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,212,255,0.15)]"
            />
            <div className="mt-0.5 flex items-center justify-between">
              <p className="text-[9px] text-gray-600"># Aktif Looplar ve Geçmiş'te tıklanabilir görünür</p>
              <p className="text-[9px] text-gray-700">{note.length}/120</p>
            </div>
          </div>

          {/* Loop toggle: terminal checkbox */}
          <button
            type="button"
            onClick={() => setLoopActive(!loopActive)}
            className={`flex w-full items-center gap-2.5 rounded-sm border px-3 py-2.5 text-left transition-all ${
              loopActive
                ? 'border-green-500/40 bg-green-500/[0.07] shadow-[0_0_12px_rgba(0,255,65,0.1)]'
                : 'border-green-500/15 bg-black/50 hover:border-green-500/30'
            }`}
          >
            <span
              className={`text-[13px] font-bold transition-all ${
                loopActive ? 'text-green-400 [text-shadow:0_0_8px_rgba(0,255,65,0.7)]' : 'text-gray-600'
              }`}
            >
              {loopActive ? '[x]' : '[ ]'}
            </span>
            <span className={`text-[12px] transition-colors ${loopActive ? 'text-green-300' : 'text-gray-400'}`}>
              loop_aktif
            </span>
            <span className="ml-auto text-[9px] text-gray-600"># bittikçe otomatik tekrar başlar</span>
          </button>

          {loopActive && (
            <div>
              <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; bekleme_sn</label>
              <input
                type="number"
                min={0}
                value={loopInterval}
                onChange={(e) => setLoopInterval(parseInt(e.target.value, 10) || 0)}
                className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
                required
              />
              <p className="mt-0.5 text-[9px] text-gray-600"># bir set bittikten sonraki bekleme süresi</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !state.plan}
            className="w-full rounded-sm border border-green-500/50 bg-green-500/[0.14] py-3 text-[13px] font-bold tracking-widest text-green-400 transition-all duration-300 [text-shadow:0_0_10px_rgba(0,255,65,0.5)] hover:bg-green-500/[0.22] hover:shadow-[0_0_20px_rgba(0,255,65,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
          >
            <span className="mb-0.5 block text-[9px] font-normal tracking-normal text-green-500/60">$ ./launch --execute</span>
            {!state.plan
              ? 'PLAN YÜKLENİYOR...'
              : loading
                ? loopActive ? (starting ? 'LOOP BAŞLATILIYOR...' : 'BAŞLATILIYOR...') : 'BAŞLATILIYOR...'
                : loopActive
                  ? 'LOOP BAŞLAT'
                  : 'SALDIRI BAŞLAT'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default AttackForm;
