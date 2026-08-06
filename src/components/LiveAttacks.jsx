import React, { useEffect, useState, useMemo, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';

// Sunucunun bildirdigi son timeLeft degerleri ve client geri sayimlari modul
// seviyesinde tutulur: tab degisiminde unmount/remount'ta sifirlanmazlar.
// Boylece bayat sunucu degeri "yeni saldiri" sanilmaz, bitmis satirlar
// hayalet olarak geri gelmez. (Bilesen icinde olsaydi attack/tools tab'lari
// ayri instance yaratirdi.)
const lastServerValues = {};
const persistedTimeLefts = {};

// Satir anahtari: grup kimligi (target + method + ilk attack id)
const rowKeyOf = (g) => `${g.target}::${g.method}::${g.ids[0]}`;

// V2 "Status Flip" satir kapsayicisi:
//  - Yeni satir kapali baslar, ilk frame'de yumusakca acilir (kutu ziplamaz).
//  - phase 'done'  : kirmizi serit + "[--] bitti" (~1.1sn gorunur kalir)
//  - phase 'exit'  : saga kayarak solar
//  - phase 'closed': 1fr->0fr grid kapanisiyla yumusakca yok olur
const AttackRow = ({ phase, initialOpen = false, children }) => {
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    if (initialOpen) return undefined;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    return () => cancelAnimationFrame(id);
  }, [initialOpen]);
  const closed = phase === 'closed' || !open;
  const dying = phase === 'done' || phase === 'exit' || phase === 'closed';
  return (
    <div className={`rw${closed ? ' closed' : ''}`}>
      <div className="rw-inner">
        <div
          className={`grid items-center gap-2 border-b border-dashed border-green-500/10 px-3 py-2.5 transition-[background,transform,opacity] duration-300 ${
            dying ? 'bg-[#ff2d2d]/[0.06] shadow-[inset_2px_0_0_#ff2d2d]' : 'hover:bg-green-500/5'
          } ${phase === 'exit' ? 'translate-x-7 opacity-0' : ''}`}
          style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 110px 60px 180px' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

const LiveAttacks = () => {
  const { state, setLiveAttacks, addLog, showToast, setStopProgress, setActiveStopKey, setStopCancelled, resetStopProgress } = useStressTest();
  const [lastUpdate, setLastUpdate] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const [stopping, setStopping] = useState(new Set());
  const stopCancelledRef = useRef(state.stopCancelled || false);
  // Kullanici tarafindan durdurulan satirlar: cikis animasyonunda
  // "[--] bitti" yerine "[!!] durd." gosterilsin diye isaretlenir
  const stoppedKeysRef = useRef(new Set());
  const [serverTimeLefts, setServerTimeLeftsState] = useState(() => ({ ...persistedTimeLefts }));

  // State guncellemelerini modul seviyesindeki depoya da yansit (remount korumasi)
  const setServerTimeLefts = (updater) => {
    setServerTimeLeftsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      Object.keys(persistedTimeLefts).forEach((k) => delete persistedTimeLefts[k]);
      Object.assign(persistedTimeLefts, next);
      return next;
    });
  };

  // Sayfa degisince ref'i context ile senkronize tut
  useEffect(() => {
    stopCancelledRef.current = state.stopCancelled || false;
  }, [state.stopCancelled]);

  const L7_METHODS = ['CLOUDFLARE', 'HTTP-TEMPESTA', 'BROWSER', 'BYPASS', 'PPS', 'HTTP-RAWPACKET', 'HTTP-SOCKETS'];

  const formatTargetForDisplay = (target, layer, method) => {
    if (!target || typeof target !== 'string') return target;
    let effectiveLayer = layer;
    if (!effectiveLayer && method) {
      effectiveLayer = L7_METHODS.includes(method.toUpperCase()) ? 'L7' : 'L4';
    }
    const isL7 = effectiveLayer === 'L7' || /^https?:\/\//i.test(target);
    let t = target.trim();
    if (isL7) {
      // Port bilgisini kaldir (L7'de 443 varsayilir)
      t = t.replace(/:(\d+)(?=\/|$)/, '');
      // Protokol yoksa ekle
      if (!/^https?:\/\//i.test(t)) {
        t = `https://${t}`;
      }
      // http:// varsa https:// yap
      t = t.replace(/^http:\/\//i, 'https://');
      // Sonunda / olsun
      if (!t.endsWith('/')) {
        t += '/';
      }
      return t;
    }
    // L4 hedeflerde protokol/path/port kaldır, sadece IP/domain göster
    t = t.replace(/^https?:\/\//i, '');
    t = t.replace(/:\d+$/, '');
    if (t.endsWith('/')) t = t.slice(0, -1);
    return t;
  };

  // Goruntude sade domain (protokol ve sondaki / kirpilir); kopyalamada tam
  // https:// URL kullanilir (handleCopy formatTargetForDisplay'i cagirir).
  const formatTargetShort = (target) =>
    String(target || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const handleCopy = async (target, layer, method, key) => {
    const copyTarget = formatTargetForDisplay(target, layer, method);
    try {
      const success = await copyTextToClipboard(copyTarget);
      if (success) {
        setCopiedKey(key);
        addLog(`Hedef kopyalandı: ${copyTarget}`);
        setTimeout(() => setCopiedKey(null), 3000);
      } else {
        throw new Error('Kopyalama başarısız');
      }
    } catch (err) {
      addLog(`Kopyalama hatası: ${err.message}`);
      showToast('Kopyalama başarısız. Lütfen bağlantınızı HTTPS üzerinden yapın.', 'error');
    }
  };

  const groupedAttacks = useMemo(() => {
    const THRESHOLD = 7;

    // Ham target farklari (protokol, sondaki /, buyuk-kucuk harf) ayni hedefi
    // ayri gruplara bolmesin; gruplama normalize anahtarla yapilir.
    const targetKey = (t) => String(t || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');

    // En son sunucu degerini veya client-side geri sayimi kullan.
    // Suresi biten (0'a ulasan) saldirilar gosterilmez; sunucu hala bayat
    // veri donduruyor olsa bile satir hayalet olarak kalmaz.
    const attacksWithTime = state.liveAttacks
      .map((attack) => {
        const attackId = attack.attack_id;
        const serverTime = parseInt(attack.timeLeft, 10);
        const currentTime = serverTimeLefts[attackId] ?? serverTime;
        return { ...attack, timeLeft: Number.isFinite(currentTime) ? currentTime : 0 };
      })
      .filter((attack) => attack.timeLeft > 0);

    const sorted = [...attacksWithTime].sort((a, b) => {
      const ka = targetKey(a.target);
      const kb = targetKey(b.target);
      if (ka !== kb) return ka.localeCompare(kb);
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return b.timeLeft - a.timeLeft;
    });

    const groups = [];
    sorted.forEach((attack) => {
      const existing = groups.find(
        (g) =>
          targetKey(g.target) === targetKey(attack.target) &&
          g.method === attack.method &&
          Math.abs(g.timeLeft - attack.timeLeft) <= THRESHOLD
      );

      if (existing) {
        existing.count += 1;
        existing.ids.push(attack.attack_id);
        // Grupta notu olan ilk saldirinin notu satira tasinir (salt-okunur)
        if (!existing.note && attack.note) existing.note = attack.note;
        if (attack.timeLeft > existing.timeLeft) {
          existing.timeLeft = attack.timeLeft;
        }
      } else {
        groups.push({ ...attack, count: 1, ids: [attack.attack_id] });
      }
    });

    return groups;
  }, [state.liveAttacks, serverTimeLefts]);

  const handleStopSingle = async (attackId, rowKey = null) => {
    if (!attackId) return;
    if (rowKey) stoppedKeysRef.current.add(rowKey);
    setStopping((prev) => new Set(prev).add(attackId));
    try {
      const data = await apiClient.stopAttack(attackId);
      if (data && data.error) {
        const msg = `Saldırı durdurulamadı #${attackId}: ${data.message || 'Bilinmeyen hata'}`;
        addLog(msg);
        showToast(msg, 'error');
      } else {
        const msg = `Saldırı durduruldu #${attackId}`;
        addLog(msg);
        showToast(msg, 'success');
      }
    } catch (err) {
      const msg = `Saldırı durdurma hatası #${attackId}: ${err.message}`;
      addLog(msg);
      showToast(msg, 'error');
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(attackId);
        return next;
      });
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const runWithConcurrency = async (items, fn, limit) => {
    const out = [];
    for (let i = 0; i < items.length; i += limit) {
      const chunk = items.slice(i, i + limit);
      const chunkResults = await Promise.all(chunk.map(fn));
      out.push(...chunkResults);
    }
    return out;
  };

  const stopAttacksWithProgress = async (attackIds, { concurrency = 5, delayMs = 150 } = {}) => {
    let successCount = 0;
    let failCount = 0;
    let processed = 0;

    const updateProgress = () => {
      const pct = attackIds.length > 0 ? Math.round((processed / attackIds.length) * 100) : 0;
      setStopProgress({
        current: processed,
        total: attackIds.length,
        successCount,
        failCount,
        percentage: pct,
        label: processed === attackIds.length ? 'Tamamlandı' : 'Durduruluyor'
      });
    };

    updateProgress();

    const stopSingle = async (id) => {
      if (stopCancelledRef.current) {
        return { id, status: 'cancelled' };
      }
      try {
        const data = await apiClient.stopAttack(id);
        if (data && data.error) {
          return { id, status: 'error', message: data.message };
        }
        return { id, status: 'success' };
      } catch (err) {
        return { id, status: 'error', message: err.message };
      }
    };

    for (let i = 0; i < attackIds.length; i += concurrency) {
      if (stopCancelledRef.current) {
        addLog('Toplu durdurma kullanıcı tarafından iptal edildi.');
        showToast('Durdurma işlemi iptal edildi', 'info');
        return { cancelled: true, successCount, failCount };
      }

      const chunk = attackIds.slice(i, i + concurrency);
      const results = await runWithConcurrency(chunk, stopSingle, concurrency);

      for (const r of results) {
        if (r.status === 'success') successCount++;
        else if (r.status === 'error') {
          failCount++;
          addLog(`Saldırı durdurulamadı #${r.id}: ${r.message || 'Bilinmeyen hata'}`);
        }
        processed++;
        updateProgress();
      }

      if (i + concurrency < attackIds.length && !stopCancelledRef.current) {
        await sleep(delayMs);
      }
    }

    return { cancelled: false, successCount, failCount };
  };

  const handleStopRow = async (attackIds, rowKey = null) => {
    if (!attackIds || attackIds.length === 0) return;
    if (rowKey) stoppedKeysRef.current.add(rowKey);
    const key = attackIds.join(',');
    setStopping((prev) => new Set(prev).add(key));
    setActiveStopKey(key);
    setStopCancelled(false);
    stopCancelledRef.current = false;

    try {
      const result = await stopAttacksWithProgress(attackIds);
      if (result.cancelled) return;

      const { successCount, failCount } = result;
      const msg = `Satır durduruldu: ${successCount} başarılı, ${failCount} başarısız`;
      addLog(msg);
      showToast(msg, failCount > 0 ? 'warning' : 'success');
    } catch (err) {
      const msg = `Satır durdurma hatası: ${err.message}`;
      addLog(msg);
      showToast(msg, 'error');
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      resetStopProgress();
    }
  };

  const handleStopAll = async () => {
    const allIds = state.liveAttacks.map((a) => a.attack_id).filter(Boolean);
    if (allIds.length === 0) return;
    groupedAttacks.forEach((g) => stoppedKeysRef.current.add(rowKeyOf(g)));
    setStopping((prev) => new Set(prev).add('__ALL__'));
    setActiveStopKey('__ALL__');
    setStopCancelled(false);
    stopCancelledRef.current = false;

    try {
      // Once tum aktif loop'lari kapat ki sonraki turlarda yeni saldiri baslamasin
      const loopIds = Object.keys(state.activeLoops || {});
      if (loopIds.length > 0) {
        await Promise.all(
          loopIds.map((loopId) =>
            apiClient.stopLoop(loopId).catch((err) => {
              addLog(`Loop durdurma hatası: ${err.message}`);
            })
          )
        );
      }

      const result = await stopAttacksWithProgress(allIds);
      if (result.cancelled) return;

      const { successCount, failCount } = result;
      const msg = `Tüm saldırılar durduruldu: ${successCount} başarılı, ${failCount} başarısız`;
      addLog(msg);
      showToast(msg, failCount > 0 ? 'warning' : 'success');
    } catch (err) {
      const msg = `Tümünü durdurma hatası: ${err.message}`;
      addLog(msg);
      showToast(msg, 'error');
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete('__ALL__');
        return next;
      });
      resetStopProgress();
    }
  };

  const handleCancelStop = () => {
    setStopCancelled(true);
    stopCancelledRef.current = true;
  };

  useEffect(() => {
    if (!state.isAuthenticated) return;

    const username = apiClient.getUsername();
    if (!username) return;

    // Sunucunun bildirdigi son timeLeft degerleri (tazelik kontrolu icin)
    // modul seviyesindeki lastServerValues'ta tutulur; remount'ta korunur.
    // Bayat/degismeyen degerler client geri sayimini resetleyemez; boylece
    // bitmis saldirilar donuk satir olarak kalmaz.
    const updateTimeLefts = (attacks) => {
      setServerTimeLefts((prev) => {
        const next = { ...prev };
        (attacks || []).forEach((a) => {
          const t = parseInt(a.timeLeft, 10);
          if (!Number.isFinite(t)) return;
          const lastServer = lastServerValues[a.attack_id];
          const isNew = lastServer === undefined;
          // Sadece gercekten yeni bir saldiri veya sunucu degeri DEGISMISSE
          // sayaci guncelle; ayni degeri tekrar eden (bayat) veri yoksayilir.
          if (isNew || t !== lastServer) {
            next[a.attack_id] = t;
          }
        });
        return next;
      });
      // Raporlanan tum degerleri kaydet (degisim tespiti icin)
      const freshRef = {};
      (attacks || []).forEach((a) => {
        const t = parseInt(a.timeLeft, 10);
        if (Number.isFinite(t)) freshRef[a.attack_id] = t;
      });
      Object.keys(lastServerValues).forEach((k) => delete lastServerValues[k]);
      Object.assign(lastServerValues, freshRef);
    };

    // SSE baglantisi acikken poll yapma; poll sadece fallback olarak calisir
    let sseConnected = false;
    // Ardiciik hatalarda log/toast spam'ini onle; basari durumunda sifirlanir
    let pollErrorLogged = false;

    const poll = async () => {
      if (sseConnected) return;
      try {
        const data = await apiClient.getOngoing(username);
        const attacks = Array.isArray(data) ? data : [];
        setLiveAttacks(attacks);
        updateTimeLefts(attacks);
        setLastUpdate(new Date());
        pollErrorLogged = false;
      } catch (err) {
        if (pollErrorLogged) return;
        pollErrorLogged = true;
        addLog(`Canlı veri alınamadı: ${err.message}`);
        // Oturum hatası varsa kullanıcıyı bilgilendir
        if (err.message?.includes('401') || err.message?.toLowerCase().includes('session')) {
          showToast('Aktif saldırılar alınamıyor: oturum geçersiz olabilir', 'error');
        }
      }
    };

    poll();
    const interval = setInterval(poll, 3000);

    let eventSource;
    try {
      eventSource = apiClient.connectLiveStream(
        username,
        (data) => {
          sseConnected = true;
          if (data.ongoing) {
            setLiveAttacks(data.ongoing);
            updateTimeLefts(data.ongoing);
          }
        },
        () => {
          // Baglanti koptu; EventSource yeniden baglanana kadar poll devreye girer
          sseConnected = false;
        }
      );
      if (eventSource) {
        eventSource.onopen = () => {
          sseConnected = true;
        };
      }
    } catch (err) {
      // SSE not supported or failed, polling continues
    }

    return () => {
      clearInterval(interval);
      if (eventSource) eventSource.close();
    };
  }, [state.isAuthenticated]);

  // Client-side geri sayim: her saniye timeLeft'leri 1 azalt
  useEffect(() => {
    if (!state.isAuthenticated) return;
    const timer = setInterval(() => {
      setServerTimeLefts((prev) => {
        const next = {};
        let changed = false;
        Object.entries(prev).forEach(([id, time]) => {
          const newTime = Math.max(0, time - 1);
          next[id] = newTime;
          if (newTime !== time) changed = true;
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [state.isAuthenticated]);

  // Gercek anlik toplam: gruplanmis satir adetlerinin toplami (filtrelenmis,
  // canli saldiri sayisi).
  const totalAttacks = useMemo(
    () => groupedAttacks.reduce((sum, g) => sum + g.count, 0),
    [groupedAttacks]
  );

  // V2 Status Flip: listeden dusen satir aninda kaybolmaz. Once ~1.1sn
  // "[--] bitti" (kullanici durdurdusa "[!!] durd.") ve kirmizi seritle
  // gorunur kalir; sonra saga kayar ve 1fr->0fr ile yumusakca kapanir.
  // Boylece kutu bitis/baslangiclarda ziplamadan kuculup buyur.
  const [dyingRows, setDyingRows] = useState([]);
  const prevGroupsRef = useRef(new Map());
  useEffect(() => {
    const current = new Map(groupedAttacks.map((g) => [rowKeyOf(g), g]));
    const prev = prevGroupsRef.current;
    const vanished = [];
    prev.forEach((g, key) => {
      if (!current.has(key)) vanished.push([key, g]);
    });
    if (vanished.length > 0) {
      setDyingRows((d) => {
        const existing = new Set(d.map((r) => r.key));
        const fresh = vanished
          .filter(([key]) => !existing.has(key))
          .map(([key, g]) => ({ key, group: g, phase: 'done', stopped: stoppedKeysRef.current.has(key) }));
        return fresh.length > 0 ? [...d, ...fresh] : d;
      });
      vanished.forEach(([key]) => {
        setTimeout(() => setDyingRows((d) => d.map((r) => (r.key === key ? { ...r, phase: 'exit' } : r))), 1100);
        setTimeout(() => setDyingRows((d) => d.map((r) => (r.key === key ? { ...r, phase: 'closed' } : r))), 1530);
        setTimeout(() => setDyingRows((d) => d.filter((r) => r.key !== key)), 2100);
      });
    }
    prevGroupsRef.current = current;
  }, [groupedAttacks]);

  // Hesaba ozel sayaclar (aktif/toplam kapasite) — canli listeyle beraber tazelenir
  const [stats, setStats] = useState(null);
  useEffect(() => {
    if (!state.isAuthenticated) return undefined;
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const s = await apiClient.getStats();
        if (!cancelled) setStats(s);
      } catch {
        // sayac alinamazsa rozet gosterilmez; akis bozulmaz
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.isAuthenticated]);

  return (
    <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
      {/* CRT scanline dokusu */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }}
      />

      {/* Title bar */}
      <div className="relative z-10 flex flex-wrap items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        <span className="text-green-300/90">root@loki:~/aktif-saldirilar</span>
        <span className="text-green-500/60">$ tail -f attacks.live</span>
        <span className="animate-pulse">▊</span>
        <span className="ml-auto flex items-center gap-2">
          <span
            className="rounded-sm border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-bold text-cyan-400"
            title="Şu an çalışan saldırılar"
          >
            Aktif {totalAttacks}
          </span>
          <span
            className="rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-[11px] font-bold text-green-400"
            title="Çalışan loop kapasitesi + loopsuz aktif saldırılar (tur geçişlerinde değişmez)"
          >
            Toplam {stats?.total ?? totalAttacks}
          </span>
          <button
            onClick={handleStopAll}
            disabled={state.liveAttacks.length === 0 || stopping.has('__ALL__')}
            className="inline-flex h-7 items-center justify-center rounded-sm border border-red-500/30 px-3 text-[11px] text-red-400 transition-all hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {stopping.has('__ALL__') ? 'Durduruluyor...' : 'Tümünü Durdur'}
          </button>
        </span>
      </div>

      {/* Durdurma ilerlemesi */}
      {state.activeStopKey && state.stopProgress && (
        <div className="relative z-10 border-b border-green-500/10 bg-black/40 px-4 py-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-500">
            <span>{state.stopProgress.label}</span>
            <span className="text-green-400">%{state.stopProgress.percentage}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
              style={{ width: `${state.stopProgress.percentage}%` }}
            ></div>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px]">
            <span className="text-gray-600">{state.stopProgress.current}/{state.stopProgress.total}</span>
            <div className="flex items-center gap-2">
              <span className="font-bold text-green-400">{state.stopProgress.successCount} başarılı</span>
              <span className="font-bold text-red-400">{state.stopProgress.failCount} başarısız</span>
              <button
                onClick={handleCancelStop}
                className="rounded-sm border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[10px] text-yellow-400 transition hover:bg-yellow-500/20"
              >
                İptal
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative z-10 p-4 sm:p-5">
        {state.liveAttacks.length === 0 && dyingRows.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>aktif saldiri yok.</p>
            {lastUpdate && <p className="mt-2 text-[11px] text-green-500/30"># son guncelleme: {lastUpdate.toLocaleTimeString()}</p>}
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <div className="min-w-[780px]">
              {/* Baslik satiri */}
              <div
                className="grid gap-2 border-b border-green-500/25 px-3 pb-2 text-[10px] text-green-500/50"
                style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 110px 60px 180px' }}
              >
                <span>&gt; Hedef</span>
                <span>&gt; Yöntem</span>
                <span>&gt; Kalan Süre</span>
                <span>&gt; Adet</span>
                <span className="text-right">&gt; İşlem</span>
              </div>

              {groupedAttacks.map((attack) => {
                const rowKey = rowKeyOf(attack);
                const displayTarget = formatTargetShort(formatTargetForDisplay(attack.target, attack.layer, attack.method));
                const isCopied = copiedKey === rowKey;
                const rowKeyStopping = stopping.has(attack.ids.join(','));
                const firstId = attack.ids[0];
                const isFirstStopping = stopping.has(firstId);

                return (
                  <AttackRow key={rowKey}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          title="URL'yi kopyala"
                          onClick={() => handleCopy(attack.target, attack.layer, attack.method, rowKey)}
                          className="inline-block max-w-[230px] cursor-pointer truncate text-left text-green-200 transition-colors hover:text-green-400"
                        >
                          {displayTarget}
                        </span>
                        <button
                          onClick={() => handleCopy(attack.target, attack.layer, attack.method, rowKey)}
                          title="URL'yi kopyala"
                          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border transition-colors duration-200 ${
                            isCopied
                              ? 'border-green-500/40 bg-green-500/20 text-green-400'
                              : 'border-green-500/15 bg-green-500/5 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                          }`}
                        >
                          {isCopied ? (
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          ) : (
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                          )}
                        </button>
                      </div>
                      {attack.note && (
                        <div className="mt-1 flex max-w-[260px] items-center gap-1.5 truncate text-[10px] text-cyan-400/90">
                          <span className="text-gray-600">📝</span>
                          <span className="truncate" title={attack.note}>{renderNoteWithLinks(attack.note)}</span>
                        </div>
                      )}
                    </div>
                    <span className="text-gray-200">{attack.method}</span>
                    <span className="font-bold text-green-400">{attack.timeLeft}s</span>
                    <span className="text-gray-400">x{attack.count}</span>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleStopSingle(firstId, rowKey)}
                        disabled={isFirstStopping}
                        title="Tek durdur"
                        className="inline-flex h-7 items-center justify-center rounded-sm border border-white/10 bg-white/[0.03] px-2.5 text-[10px] text-gray-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                      >
                        {isFirstStopping ? '…' : '■ durdur'}
                      </button>
                      <button
                        onClick={() => attack.count > 1 && handleStopRow(attack.ids, rowKey)}
                        disabled={attack.count <= 1 || rowKeyStopping}
                        title={attack.count > 1 ? `Bu satırdaki ${attack.count} saldırıyı durdur` : 'Tek saldırı - satır durdurma kullanılamaz'}
                        className="inline-flex h-7 items-center justify-center rounded-sm border border-white/10 bg-white/[0.03] px-2.5 text-[10px] text-gray-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        {rowKeyStopping ? '…' : `■ x${attack.count}`}
                      </button>
                    </div>
                  </AttackRow>
                );
              })}

              {/* Bitmis/durdurulmus satirlar: V2 status-flip cikis animasyonu */}
              {dyingRows.map((r) => (
                <AttackRow key={r.key} phase={r.phase} initialOpen>
                  <div className="flex items-center gap-2">
                    <span className="inline-block max-w-[230px] truncate text-left text-gray-500">
                      {formatTargetShort(formatTargetForDisplay(r.group.target, r.group.layer, r.group.method))}
                    </span>
                  </div>
                  <span className="text-gray-600">{r.group.method}</span>
                  <span className="font-bold text-[#ff5c5c]">{r.stopped ? '[!!] durd.' : '[--] bitti'}</span>
                  <span className="text-gray-600">x{r.group.count}</span>
                  <div />
                </AttackRow>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveAttacks;
