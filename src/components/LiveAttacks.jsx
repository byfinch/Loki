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

// Normalize imza: ham target farklari (protokol, sondaki /, buyuk-kucuk harf)
// ve method buyuklugu ayni mantiksal satiri eslesir kilar.
const targetKeyNorm = (t) => String(t || '')
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');
const sigOf = (target, method) => `${targetKeyNorm(target)}::${String(method || '').toLowerCase()}`;

// Satir anahtari = hedef+yontem imzasi. ID'den bagimsizdir: loop turlari
// ve attack ID rotasyonlari satiri yeniden DOGURMAZ; ayni hedef+yontem
// her zaman tek ve ayni satirda kalir.
const rowKeyOf = (g) => sigOf(g.target, g.method);

// V2 "Status Flip" satir kapsayicisi:
//  - Yeni satir kapali baslar, ilk frame'de yumusakca acilir (kutu ziplamaz).
//  - phase 'done'  : kirmizi serit + "[--] bitti" (~1.1sn gorunur kalir)
//  - phase 'exit'  : saga kayarak solar
//  - phase 'closed': 1fr->0fr grid kapanisiyla yumusakca yok olur
const AttackRow = ({ phase, initialOpen = false, child = false, children }) => {
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
          } ${phase === 'exit' ? 'translate-x-7 opacity-0' : ''} ${child ? 'bg-green-500/[0.03] shadow-[inset_2px_0_0_rgba(0,255,65,0.25)]' : ''}`}
          style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 110px 60px 180px' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

const LiveAttacks = () => {
  const { state, setLiveAttacks, setLoops, addLog, showToast, setStopProgress, setActiveStopKey, setStopCancelled, resetStopProgress } = useStressTest();
  const [lastUpdate, setLastUpdate] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [copiedKey, setCopiedKey] = useState(null);
  const [stopping, setStopping] = useState(new Set());
  const stopCancelledRef = useRef(state.stopCancelled || false);
  // Kullanici tarafindan durdurulan satirlar: cikis animasyonunda
  // "[--] bitti" yerine "[!!] durd." gosterilsin diye isaretlenir
  const stoppedKeysRef = useRef(new Set());
  const stoppedSigsRef = useRef(new Set());
  // dying satirlarin key takibi (zamanlayici tekrarini onlemek icin)
  const dyingKeysRef = useRef(new Set());
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
    // Hedef+yontem basina TEK satir: loop turlari ve farkli zamanlarda
    // baslatilan ayni imzali saldirilar ayni satirda birlesir (adet
    // toplanir, kalan sure en buyuk/guncel deger). Satir kimligi imzaya
    // bagli oldugundan tur gecislerinde satir yerinde kalir; kaybolup
    // yeniden dogmaz (titreme/yeniden belirme bug'i).
    const byKey = new Map();
    state.liveAttacks
      .map((attack) => {
        const attackId = attack.attack_id;
        const serverTime = parseInt(attack.timeLeft, 10);
        // id'siz satirlar imza ile anahtarlanir: ortak "null" sepetime dusmez,
        // yine de akici geri sayimdan yararlanir.
        const key = attackId || sigOf(attack.target, attack.method);
        const currentTime = serverTimeLefts[key] ?? serverTime;
        return { ...attack, timeLeft: Number.isFinite(currentTime) ? currentTime : 0 };
      })
      .filter((attack) => attack.timeLeft > 0)
      .forEach((attack) => {
        const key = sigOf(attack.target, attack.method);
        const existing = byKey.get(key);
        if (existing) {
          existing.count += 1;
          existing.ids.push(attack.attack_id);
          // Grupta notu olan ilk saldirinin notu satira tasinir (salt-okunur)
          if (!existing.note && attack.note) existing.note = attack.note;
          if (attack.timeLeft > existing.timeLeft) existing.timeLeft = attack.timeLeft;
        } else {
          byKey.set(key, { ...attack, count: 1, ids: [attack.attack_id] });
        }
      });
    return [...byKey.values()].sort((a, b) => {
      const ka = targetKeyNorm(a.target);
      const kb = targetKeyNorm(b.target);
      if (ka !== kb) return ka.localeCompare(kb);
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return b.timeLeft - a.timeLeft;
    });
  }, [state.liveAttacks, serverTimeLefts]);

  const handleStopSingle = async (attackId, rowKey = null, sig = null) => {
    if (!attackId) return;
    if (rowKey) stoppedKeysRef.current.add(rowKey);
    if (sig) stoppedSigsRef.current.add(sig);
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

  const handleStopRow = async (attackIds, rowKey = null, sig = null) => {
    if (!attackIds || attackIds.length === 0) return;
    if (rowKey) stoppedKeysRef.current.add(rowKey);
    if (sig) stoppedSigsRef.current.add(sig);
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
    groupedAttacks.forEach((g) => {
      stoppedKeysRef.current.add(rowKeyOf(g));
      stoppedSigsRef.current.add(sigOf(g.target, g.method));
    });
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
          // id'siz satirlar imza ile anahtarlanir (ortak null sepeti yok)
          const key = a.attack_id || sigOf(a.target, a.method);
          const lastServer = lastServerValues[key];
          const isNew = lastServer === undefined;
          // Sadece gercekten yeni bir saldiri veya sunucu degeri DEGISMISSE
          // sayaci guncelle; ayni degeri tekrar eden (bayat) veri yoksayilir.
          // Ayni id icin sunucu degerinin YUKARI sicramasi upstream
          // glitch'idir (kuyruk/yeniden sayma); gercek yeni tur yeni id ile
          // gelir. Yukari sicramalari yoksay, client geri sayimi sursun.
          if (!isNew && t > lastServer + 2) return;
          if (isNew || t !== lastServer) {
            next[key] = t;
          }
        });
        return next;
      });
      // Raporlanan tum degerleri kaydet (degisim tespiti icin)
      const freshRef = {};
      (attacks || []).forEach((a) => {
        const t = parseInt(a.timeLeft, 10);
        if (Number.isFinite(t)) freshRef[a.attack_id || sigOf(a.target, a.method)] = t;
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
  // Loop tur arasi bekleme satirlari: loop'un bir turu bitip yeni turu
  // baslayana kadar satir "[..] tur arasi" olarak kalir; bitti animasyonu
  // ve cift satir (eski+yeni tur) olusmaz.
  const [waitingRows, setWaitingRows] = useState([]);
  const prevGroupsRef = useRef(new Map());

  // Calisan loop'larin imzalari (hedef+yontem)
  const loopSigs = useMemo(
    () => new Set(
      Object.values(state.activeLoops || {})
        .filter((l) => l && l.running !== false)
        .map((l) => sigOf(l.params?.host, l.params?.method))
    ),
    [state.activeLoops]
  );

  useEffect(() => {
    const current = new Map(groupedAttacks.map((g) => [rowKeyOf(g), g]));
    const currentSigs = new Set(groupedAttacks.map((g) => sigOf(g.target, g.method)));
    const prev = prevGroupsRef.current;

    const vanished = [];
    const waitingAdd = [];
    prev.forEach((g, key) => {
      if (current.has(key)) return;
      const sig = sigOf(g.target, g.method);
      const isStopped = stoppedKeysRef.current.has(key) || stoppedSigsRef.current.has(sig);
      if (isStopped) {
        stoppedKeysRef.current.delete(key);
        stoppedSigsRef.current.delete(sig);
        vanished.push([key, g, true]);
        return;
      }
      // Loop tur rotasyonu: bitti animasyonu YOK; tur arasi bekleme satiri
      if (loopSigs.has(sig)) {
        waitingAdd.push([sig, g]);
        return;
      }
      // ID kaymasi / veri glitchi (sure >2 iken kaybolma): atla
      const isNaturalEnd = (parseInt(g.timeLeft, 10) || 0) <= 2;
      if (!isNaturalEnd) return;
      vanished.push([key, g, false]);
    });

    if (vanished.length > 0) {
      // Faz zamanlayicilari SADECE gercekten yeni eklenen satirlar icin kur;
      // aksi halde ayni imza 2.1sn icinde tekrar duserse yeni zamanlayici
      // seti eski dying kaydini erken kapatir/siler.
      const freshKeys = vanished.filter(([key]) => !dyingKeysRef.current.has(key)).map(([key]) => key);
      freshKeys.forEach((key) => dyingKeysRef.current.add(key));
      if (freshKeys.length > 0) {
        setDyingRows((d) => {
          const existing = new Set(d.map((r) => r.key));
          const fresh = vanished
            .filter(([key]) => freshKeys.includes(key) && !existing.has(key))
            .map(([key, g, isStopped]) => ({ key, group: g, phase: 'done', stopped: isStopped }));
          return fresh.length > 0 ? [...d, ...fresh] : d;
        });
        freshKeys.forEach((key) => {
          setTimeout(() => setDyingRows((d) => d.map((r) => (r.key === key ? { ...r, phase: 'exit' } : r))), 1100);
          setTimeout(() => setDyingRows((d) => d.map((r) => (r.key === key ? { ...r, phase: 'closed' } : r))), 1530);
          setTimeout(() => {
            dyingKeysRef.current.delete(key);
            setDyingRows((d) => d.filter((r) => r.key !== key));
          }, 2100);
        });
      }
    }

    // Bekleme satirlarini guncelle: yeni turu baslayan (sig artik listede)
    // veya loop'u kapanan / 120sn'yi asan satirlar duser.
    const now = Date.now();
    setWaitingRows((w) => {
      const kept = w.filter((r) => !currentSigs.has(r.sig) && loopSigs.has(r.sig) && now - r.since < 120000);
      const keptSigs = new Set(kept.map((r) => r.sig));
      waitingAdd.forEach(([sig, g]) => {
        if (!keptSigs.has(sig)) {
          kept.push({ sig, group: g, since: now });
          keptSigs.add(sig);
        }
      });
      return kept.length === w.length && waitingAdd.length === 0 ? w : kept;
    });

    prevGroupsRef.current = current;
  }, [groupedAttacks, loopSigs]);

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

  // Loop listesini her sekmede taze tut: LoopManager sadece Looplar
  // sekmesinde mount oldugundan state.activeLoops baska sekmelerde bayat
  // kalir; loopSigs eslesmeleri (tur rotasyonu/bekleme satirlari) her
  // sekmede dogru calissin diye burada da senkronlanir.
  useEffect(() => {
    if (!state.isAuthenticated) return undefined;
    let cancelled = false;
    const sync = async () => {
      try {
        const data = await apiClient.getLoops();
        if (cancelled) return;
        const map = {};
        (data.loops || []).forEach((l) => { map[l.loopId] = l; });
        setLoops(map);
      } catch {
        // bir sonraki tazelemede tekrar dener
      }
    };
    sync();
    const interval = setInterval(sync, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.isAuthenticated]);

  // Tek siralama: aktif + tur-arasi + olmakte olan satirlar ayni liste
  // icinde konumlanir. Biten satir listenin ALTINA dusmez; kendi sirasinda
  // "[--] bitti" olur ve oradan kaybolur.
  const combinedRows = useMemo(() => {
    const rows = groupedAttacks.map((g) => ({
      key: rowKeyOf(g), type: 'active', group: g,
      sortTarget: targetKeyNorm(g.target), sortMethod: String(g.method || '').toLowerCase(), sortTime: g.timeLeft || 0
    }));
    // Aktif sig'lerle cakisan bekleme satirlarini burada ele: efektin
    // temizlemesini beklemeden ayni key'in iki kez render edilmesini onler.
    const activeSigs = new Set(groupedAttacks.map((g) => sigOf(g.target, g.method)));
    waitingRows.forEach((r) => {
      if (activeSigs.has(r.sig)) return;
      rows.push({
        // Aktif satirla ayni anahtar: tur baslayinca satir yerinde guncellenir
        key: r.sig, type: 'wait', group: r.group,
        sortTarget: targetKeyNorm(r.group.target), sortMethod: String(r.group.method || '').toLowerCase(), sortTime: r.group.timeLeft || 0
      });
    });
    dyingRows.forEach((r) => rows.push({
      key: `dying::${r.key}`, type: 'dying', row: r, group: r.group,
      sortTarget: targetKeyNorm(r.group.target), sortMethod: String(r.group.method || '').toLowerCase(), sortTime: r.group.timeLeft || 0
    }));
    return rows.sort((a, b) =>
      a.sortTarget.localeCompare(b.sortTarget) ||
      a.sortMethod.localeCompare(b.sortMethod) ||
      b.sortTime - a.sortTime
    );
  }, [groupedAttacks, waitingRows, dyingRows]);

  // Grup ayraçları (salt okunur): loop'un grubu (veya dogrudan saldirinin
  // grubu) varsa satir o grubun basliginin altinda cizilir. Atama/duzenleme
  // burada yapilmaz; Aktif Looplar'dan yapilir.
  const groupOfRow = (row) => {
    // active/dying/wait tum satir tipleri gruplanabilir: bitis satiri
    // da kendi yerinde, grup icinde gorunur (blok disina kacmaz).
    const a = row.group;
    const direct = state.activeLoops?.[a.loopId]?.group || a.group;
    if (direct) return direct;
    // ID'siz satirlar: hedef+yontem imzasiyla loop'u bul, grubunu al
    // (protokol, port ve sondaki / farklari yok sayilir: upstream L7'de
    // "host/:443" formu donebiliyor)
    const stripPort = (t) => String(t || '').toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/:\d+(\/)?$/, '')
      .replace(/\/+$/, '');
    const normT = stripPort(a.target);
    const normM = String(a.method || '').toLowerCase();
    const loop = Object.values(state.activeLoops || {}).find((l) =>
      String(l.params?.method || '').toLowerCase() === normM &&
      stripPort(l.displayTarget || l.params?.host || '') === normT
    );
    return loop?.group || null;
  };
  const displayRows = useMemo(() => {
    const out = [];
    const headPos = new Map();
    combinedRows.forEach((row) => {
      const g = groupOfRow(row);
      if (!g) { out.push(row); return; }
      if (!headPos.has(g)) {
        headPos.set(g, out.length);
        out.push({ key: `grouphead::${g}`, type: 'groupHeader', name: g, members: [] });
      }
      out[headPos.get(g)].members.push(row);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combinedRows, collapsedGroups, state.activeLoops]);

  const renderCombinedRow = (row) => {
                  // Grup blogu (salt okunur): baslik + uyeler TEK konteynirda;
                  // ac/kapa iki yonlu akordeon animasyonlu (.rw)
                  if (row.type === 'groupHeader') {
                    const isOpen = !collapsedGroups[row.name];
                    return (
                      <div key={row.key} className="mx-0 mb-2 mt-2 overflow-hidden rounded-sm border border-green-500/25">
                        <div
                          onClick={() => setCollapsedGroups((c) => ({ ...c, [row.name]: !c[row.name] }))}
                          className="flex cursor-pointer select-none items-center gap-2.5 bg-green-500/[0.06] px-3 py-2 transition-colors hover:bg-green-500/[0.11]"
                        >
                          <span className={`inline-block text-[11px] text-green-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                          <span className="text-[11px] font-bold tracking-wider text-green-300">{row.name.toLocaleLowerCase('tr')}</span>
                          <span className="rounded-sm border border-green-500/25 bg-black/60 px-1.5 py-0.5 text-[10px] text-green-400">{row.members.length} işlem</span>
                        </div>
                        <div className={`rw ${isOpen ? '' : 'closed'}`}>
                          <div className="rw-inner">
                            {row.members.map((m) => renderCombinedRow({ ...m, __child: true }))}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  // Tur arasi bekleme satiri (loop): yeni tur bekleniyor
                  if (row.type === 'wait') {
                    const g = row.group;
                    return (
                      <AttackRow key={row.key} initialOpen>
                        <div className="flex items-center gap-2">
                          <span className="inline-block max-w-[230px] truncate text-left text-green-200/70">
                            {formatTargetShort(formatTargetForDisplay(g.target, g.layer, g.method))}
                          </span>
                        </div>
                        <span className="text-gray-400">{g.method}</span>
                        <span className="font-bold text-cyan-400/80">[..] tur arası</span>
                        <span className="text-gray-500">x{g.count}</span>
                        <div />
                      </AttackRow>
                    );
                  }
  
                  // Bitmis/durdurulmus satir: kendi sirasinda V2 status-flip
                  if (row.type === 'dying') {
                    const r = row.row;
                    const g = row.group;
                    return (
                      <AttackRow key={row.key} phase={r.phase} initialOpen>
                        <div className="flex items-center gap-2">
                          <span className="inline-block max-w-[230px] truncate text-left text-gray-500">
                            {formatTargetShort(formatTargetForDisplay(g.target, g.layer, g.method))}
                          </span>
                        </div>
                        <span className="text-gray-600">{g.method}</span>
                        <span className="font-bold text-[#ff5c5c]">{r.stopped ? '[!!] durd.' : '[--] bitti'}</span>
                        <span className="text-gray-600">x{g.count}</span>
                        <div />
                      </AttackRow>
                    );
                  }
  
                  // Aktif satir
                  const attack = row.group;
                  const rowKey = row.key;
                  const displayTarget = formatTargetShort(formatTargetForDisplay(attack.target, attack.layer, attack.method));
                  const isCopied = copiedKey === rowKey;
                  const rowKeyStopping = stopping.has(attack.ids.join(','));
                  const firstId = attack.ids[0];
                  const isFirstStopping = stopping.has(firstId);
  
                  return (
                    <AttackRow key={rowKey} child={!!row.__child}>
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
                          onClick={() => handleStopSingle(firstId, rowKey, sigOf(attack.target, attack.method))}
                          disabled={isFirstStopping}
                          title="Tek durdur"
                          className="inline-flex h-7 w-[76px] items-center justify-center rounded-sm border border-white/10 bg-white/[0.03] px-2 text-[10px] text-gray-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                        >
                          {isFirstStopping ? '…' : '■ durdur'}
                        </button>
                        <button
                          onClick={() => attack.count > 1 && handleStopRow(attack.ids, rowKey, sigOf(attack.target, attack.method))}
                          disabled={attack.count <= 1 || rowKeyStopping}
                          title={attack.count > 1 ? `Bu satırdaki ${attack.count} saldırıyı durdur` : 'Tek saldırı - satır durdurma kullanılamaz'}
                          className="inline-flex h-7 w-[60px] items-center justify-center rounded-sm border border-white/10 bg-white/[0.03] px-2 text-[10px] text-gray-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          {rowKeyStopping ? '…' : `■ x${attack.count}`}
                        </button>
                      </div>
                    </AttackRow>
                  );
                
                };
  
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
        {state.liveAttacks.length === 0 && dyingRows.length === 0 && waitingRows.length === 0 ? (
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

              {displayRows.map((row) => renderCombinedRow(row))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveAttacks;
