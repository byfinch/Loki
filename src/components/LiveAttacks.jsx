import React, { useEffect, useState, useMemo, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

const LiveAttacks = () => {
  const { state, setLiveAttacks, addLog, showToast, setStopProgress, setActiveStopKey, setStopCancelled, resetStopProgress } = useStressTest();
  const [lastUpdate, setLastUpdate] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const [stopping, setStopping] = useState(new Set());
  const stopCancelledRef = useRef(state.stopCancelled || false);
  const [serverTimeLefts, setServerTimeLefts] = useState({});

  // Sayfa degisince ref'i context ile senkronize tut
  useEffect(() => {
    stopCancelledRef.current = state.stopCancelled || false;
  }, [state.stopCancelled]);

  const fallbackCopyTextToClipboard = (text) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    } catch (err) {
      document.body.removeChild(textArea);
      return false;
    }
  };

  const copyTextToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return fallbackCopyTextToClipboard(text);
  };

  const stripPortFromUrl = (target) => {
    if (!target || typeof target !== 'string') return target;
    // Garip formatlar icin once duzeltme: "https://host/:443" -> "https://host:443"
    let normalized = target.replace(/\/:(\d+)$/, ':$1');
    try {
      const url = new URL(normalized.includes('://') ? normalized : `http://${normalized}`);
      url.port = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return normalized.replace(/:\d+(?=\/|$)/g, '').replace(/\/$/, '');
    }
  };

  const handleCopy = async (target, key) => {
    const copyTarget = stripPortFromUrl(target);
    try {
      const success = await copyTextToClipboard(copyTarget);
      if (success) {
        setCopiedKey(key);
        addLog(`Hedef kopyalandı: ${copyTarget}`);
        setTimeout(() => setCopiedKey(null), 1500);
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

    // En son sunucu degerini veya client-side geri sayimi kullan
    const attacksWithTime = state.liveAttacks.map((attack) => {
      const attackId = attack.attack_id;
      const serverTime = parseInt(attack.timeLeft, 10);
      const currentTime = serverTimeLefts[attackId] ?? serverTime;
      return { ...attack, timeLeft: Number.isFinite(currentTime) ? currentTime : 0 };
    });

    const sorted = [...attacksWithTime].sort((a, b) => {
      if (a.target !== b.target) return a.target.localeCompare(b.target);
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return b.timeLeft - a.timeLeft;
    });

    const groups = [];
    sorted.forEach((attack) => {
      const existing = groups.find(
        (g) =>
          g.target === attack.target &&
          g.method === attack.method &&
          Math.abs(g.timeLeft - attack.timeLeft) <= THRESHOLD
      );

      if (existing) {
        existing.count += 1;
        existing.ids.push(attack.attack_id);
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

    const updateTimeLefts = (attacks) => {
      const next = {};
      (attacks || []).forEach((a) => {
        const t = parseInt(a.timeLeft, 10);
        next[a.attack_id] = Number.isFinite(t) ? t : 0;
      });
      setServerTimeLefts(next);
    };

    const poll = async () => {
      try {
        const data = await apiClient.getOngoing(username);
        const attacks = Array.isArray(data) ? data : [];
        setLiveAttacks(attacks);
        updateTimeLefts(attacks);
        setLastUpdate(new Date());
      } catch (err) {
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
          if (data.ongoing) {
            setLiveAttacks(data.ongoing);
            updateTimeLefts(data.ongoing);
          }
          if (data.user) addLog(`Canlı güncelleme alındı`);
        },
        () => {}
      );
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

  return (
    <div className="glass-panel rounded-xl p-6 hover-glow transition-all duration-300">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          Aktif Saldırılar
          <span className="ml-2 px-2 py-0.5 bg-black/60 border border-white/10 rounded text-xs text-green-400 font-mono">
            {state.liveAttacks.length}
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
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="pb-3 font-medium w-auto pl-3">Hedef</th>
                <th className="pb-3 font-medium w-32">Yöntem</th>
                <th className="pb-3 font-medium w-24">Kalan Süre</th>
                <th className="pb-3 font-medium w-16 text-right">Adet</th>
                <th className="pb-3 font-medium w-44 text-right pr-6">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {groupedAttacks.map((attack) => {
                const displayTarget = stripPortFromUrl(attack.target);
                const rowKey = `${attack.target}::${attack.method}::${attack.timeLeft}`;
                const rowKeyStopping = stopping.has(attack.ids.join(','));
                const firstId = attack.ids[0];
                const isFirstStopping = stopping.has(firstId);

                return (
                  <tr key={rowKey} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="py-3 pr-2 pl-3">
                      <button
                        onClick={() => handleCopy(attack.target, rowKey)}
                        title="Hostname'i kopyala"
                        className="text-left text-gray-300 font-mono truncate max-w-[220px] hover:text-green-400 transition-colors"
                      >
                        {copiedKey === rowKey ? (
                          <span className="text-green-400 text-xs font-bold">Kopyalandı!</span>
                        ) : (
                          displayTarget
                        )}
                      </button>
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
    </div>
  );
};

export default LiveAttacks;
