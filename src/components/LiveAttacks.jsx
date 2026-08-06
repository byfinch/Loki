import React, { useEffect, useState, useMemo, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';
import CyberCard from './CyberCard';

// Sunucunun bildirdigi son timeLeft degerleri ve client geri sayimlari modul
// seviyesinde tutulur: tab degisiminde unmount/remount'ta sifirlanmazlar.
// Boylece bayat sunucu degeri "yeni saldiri" sanilmaz, bitmis satirlar
// hayalet olarak geri gelmez. (Bilesen icinde olsaydi attack/tools tab'lari
// ayri instance yaratirdi.)
const lastServerValues = {};
const persistedTimeLefts = {};

const LiveAttacks = () => {
  const { state, setLiveAttacks, addLog, showToast, setStopProgress, setActiveStopKey, setStopCancelled, resetStopProgress } = useStressTest();
  const [lastUpdate, setLastUpdate] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const [stopping, setStopping] = useState(new Set());
  const stopCancelledRef = useRef(state.stopCancelled || false);
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

  const handleStopSingle = async (attackId) => {
    if (!attackId) return;
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

  const handleStopRow = async (attackIds) => {
    if (!attackIds || attackIds.length === 0) return;
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
    <CyberCard className="p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 flex-wrap">
          Aktif Saldırılar
          <span className="ml-2 px-2.5 py-1 bg-black/60 border border-cyan-500/30 rounded-md text-sm text-cyan-400 font-mono font-bold shadow-[0_0_12px_rgba(0,212,255,0.12)]" title="Şu an çalışan saldırılar">
            Aktif {totalAttacks}
          </span>
          <span className="px-2.5 py-1 bg-black/60 border border-green-500/30 rounded-md text-sm text-green-400 font-mono font-bold shadow-[0_0_12px_rgba(0,255,65,0.15)]" title="Çalışan loop kapasitesi + loopsuz aktif saldırılar (tur geçişlerinde değişmez)">
            Toplam {stats?.total ?? totalAttacks}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {state.activeStopKey && state.stopProgress && (
            <div className="flex flex-col gap-1.5 min-w-[220px]">
              <div className="flex items-center justify-between text-[10px] text-gray-400 uppercase tracking-wider">
                <span>{state.stopProgress.label}</span>
                <span className="text-white font-mono">%{state.stopProgress.percentage}</span>
              </div>
              <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                  style={{ width: `${state.stopProgress.percentage}%` }}
                ></div>
              </div>
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-500">
                  {state.stopProgress.current}/{state.stopProgress.total}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-green-400 font-bold">{state.stopProgress.successCount} başarılı</span>
                  <span className="text-red-400 font-bold">{state.stopProgress.failCount} başarısız</span>
                  <button
                    onClick={handleCancelStop}
                    className="text-[10px] bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30 px-2 py-0.5 rounded-full transition"
                  >
                    İptal
                  </button>
                </div>
              </div>
            </div>
          )}
          <button
            onClick={handleStopAll}
            disabled={state.liveAttacks.length === 0 || stopping.has('__ALL__')}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-full transition-all duration-300 hover:shadow-[0_0_15px_rgba(239,68,68,0.25)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {stopping.has('__ALL__') ? 'Durduruluyor...' : 'Tümünü Durdur'}
          </button>
        </div>
      </div>

      {state.liveAttacks.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Herhangi bir aktif saldırı bulunmuyor.</p>
          {lastUpdate && <p className="text-xs mt-2">Son güncelleme: {lastUpdate.toLocaleTimeString()}</p>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="cyber-table w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="pb-3 font-medium whitespace-nowrap w-auto pl-3">Hedef</th>
                <th className="pb-3 font-medium whitespace-nowrap w-32">Yöntem</th>
                <th className="pb-3 font-medium whitespace-nowrap min-w-[120px]">Kalan Süre</th>
                <th className="pb-3 font-medium whitespace-nowrap w-16 text-right">Adet</th>
                <th className="pb-3 font-medium whitespace-nowrap w-44 text-right pr-6">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {groupedAttacks.map((attack) => {
                const displayTarget = formatTargetShort(formatTargetForDisplay(attack.target, attack.layer, attack.method));
                const rowKey = `${attack.target}::${attack.method}::${attack.ids[0]}`;
                const isCopied = copiedKey === rowKey;
                const rowKeyStopping = stopping.has(attack.ids.join(','));
                const firstId = attack.ids[0];
                const isFirstStopping = stopping.has(firstId);

                return (
                  <tr key={rowKey} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="py-2 pr-3 pl-4 align-middle">
                      <div className="flex items-center gap-2">
                        <span
                          title="URL'yi kopyala"
                          className="inline-block text-left text-gray-300 font-mono truncate w-[220px] hover:text-green-400 transition-colors cursor-pointer"
                          onClick={() => handleCopy(attack.target, attack.layer, attack.method, rowKey)}
                        >
                          {displayTarget}
                        </span>
                        <button
                          onClick={() => handleCopy(attack.target, attack.layer, attack.method, rowKey)}
                          title="URL'yi kopyala"
                          className={`flex-shrink-0 w-7 h-7 rounded flex items-center justify-center border transition-colors duration-200 ${
                            isCopied
                              ? 'bg-green-500/20 border-green-500/40 text-green-400'
                              : 'bg-white/5 border-white/10 text-gray-500 hover:text-green-400 hover:border-green-500/30'
                          }`}
                        >
                          {isCopied ? (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                          )}
                        </button>
                      </div>
                      {attack.note && (
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono text-cyan-400">
                          <span className="text-gray-600">📝</span>
                          <span className="truncate max-w-[260px]" title={attack.note}>{renderNoteWithLinks(attack.note)}</span>
                        </div>
                      )}
                    </td>
                    <td className="py-3 whitespace-nowrap">
                      <span className="px-2.5 py-1 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                        {attack.method}
                      </span>
                    </td>
                    <td className="py-3 text-green-400 font-mono whitespace-nowrap font-bold">{attack.timeLeft}s</td>
                    <td className="py-3 text-right">
                      <span className="px-2.5 py-1 bg-black/60 border border-white/10 rounded-md text-xs text-gray-300 font-mono">
                        x{attack.count}
                      </span>
                    </td>
                    <td className="py-3 text-right w-44">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => handleStopSingle(firstId)}
                          disabled={isFirstStopping}
                          title="Tek durdur"
                          className="w-7 h-7 rounded-md flex items-center justify-center bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-white/10 transition-all duration-300 hover:border-red-500/30 disabled:opacity-50"
                        >
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                            <rect x="1" y="1" width="10" height="10" rx="2"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => attack.count > 1 && handleStopRow(attack.ids)}
                          disabled={attack.count <= 1 || rowKeyStopping}
                          title={attack.count > 1 ? `Bu satırdaki ${attack.count} saldırıyı durdur` : 'Tek saldırı - satır durdurma kullanılamaz'}
                          className="px-2 h-7 rounded-md flex items-center gap-1.5 bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-white/10 text-xs transition-all duration-300 hover:border-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                            <rect x="1" y="1" width="10" height="10" rx="2"/>
                          </svg>
                          <span>x{attack.count}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CyberCard>
  );
};

export default LiveAttacks;
