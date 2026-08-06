import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

// RRT (Google Rich Results Test) otomasyon karti:
// Saldiri/loop baslayinca hedef ~5sn sonra Google RRT'den gecirilir;
// sonuclar ve kuyruk durumu bu kartta listelenir.
const POLL_MS = 15000;

const RrtMonitor = () => {
  const { state } = useStressTest();
  const [results, setResults] = useState([]);
  const [pending, setPending] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!state.isAuthenticated) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiClient.getRrt();
        if (cancelled) return;
        setResults(data.results || []);
        setPending(data.pending || []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [state.isAuthenticated]);

  const verdictView = (r) => {
    if (r.verdict === 'items') {
      const valid = (r.items || []).reduce((s, i) => s + (i.valid || 0), 0);
      return { cls: 'text-green-400 [text-shadow:0_0_8px_rgba(0,255,65,0.5)]', text: `[OK] ${(r.items || []).length} öğe · ${valid} geçerli` };
    }
    if (r.verdict === 'none') return { cls: 'text-gray-500', text: '[--] no items' };
    if (r.verdict === 'crawl_error') return { cls: 'text-[#ff5c5c]', text: '[X] taranamadı' };
    return { cls: 'text-[#ff5c5c]', text: '[X] hata' };
  };

  const pendingLabel = (p) => (p.state === 'running' ? '[..] test çalışıyor' : p.state === 'queued' ? '[..] kuyrukta' : '[..] zamanlandı');

  // Yeniden denemesi kuyrukta/calisiyor olan hostlarin eski (hata) satirini
  // gosterme; aksi halde ayni host hem bekleyen hem sonuc olarak cift gorunur.
  const pendingHosts = new Set(pending.map((p) => p.host));

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
        <span className="text-green-300/90">root@loki:~</span>
        <span className="text-green-500/60">$ rrt --watch attacks</span>
        <span className="animate-pulse">▊</span>
        <span className="ml-auto whitespace-nowrap text-[10px] text-green-500/50">rich results</span>
      </div>

      <div className="relative z-10 p-3 sm:p-4">
        {error && (
          <div className="flex items-center gap-2 rounded-sm border border-[#ff2d2d]/45 border-l-[3px] border-l-[#ff2d2d] bg-[#ff2d2d]/10 px-3 py-2 text-[11px] text-[#ff5c5c]">
            <span className="font-bold text-[#ff2d2d]">[ERR]</span>
            <span className="truncate">veri alinamadi: {error}</span>
          </div>
        )}

        {!error && results.length === 0 && pending.length === 0 && (
          <div className="py-8 text-center text-green-500/50">
            <p>henuz rrt sonucu yok.</p>
            <p className="mt-2 text-[10px] text-green-500/30"># saldiri baslayinca hedef ~20sn icinde test edilir</p>
          </div>
        )}

        {/* Liste sabit yukseklikte: ~4 satir gorunur, fazlasi dahili scroll
            (Etki Monitoru ile ayni pattern; sayfalama yerine canli akis) */}
        <div className="max-h-[190px] overflow-y-auto impact-scroll pr-1">
        {!error && pending.map((p) => (
          <div key={`p-${p.host}`} className="flex items-center gap-2.5 border-b border-dashed border-green-500/10 px-2 py-2.5 text-[12px]">
            <span className="truncate font-bold text-green-100/70">{p.host}</span>
            <span className="text-[11px] text-cyan-400/80">{pendingLabel(p)}</span>
            <span className="animate-pulse text-cyan-400/60">▊</span>
          </div>
        ))}

        {!error && results.filter((r) => !pendingHosts.has(r.host)).map((r) => {
          const v = verdictView(r);
          return (
            <div key={r.host} className="flex items-center gap-2.5 border-b border-dashed border-green-500/10 px-2 py-2.5 text-[12px] last:border-b-0">
              <span className="w-[150px] flex-shrink-0 truncate font-bold text-green-100" title={r.host}>{r.host}</span>
              <span
                className={`min-w-0 truncate text-[11px] font-bold ${v.cls}`}
                title={r.crawlError || (r.verdict === 'items' ? (r.items || []).map((i) => i.name).join(', ') : '')}
              >
                {v.text}
              </span>
              {r.partialLoad > 0 && (
                <span className="whitespace-nowrap text-[10px] text-[#fb923c]">[!] {r.partialLoad} kaynak</span>
              )}
              <span className="ml-auto flex flex-shrink-0 items-center gap-3">
                <span className="whitespace-nowrap text-[10px] text-gray-600">
                  {r.durationSec != null ? `${r.durationSec}sn` : ''}
                </span>
                {r.resultUrl && (
                  <a
                    href={r.resultUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="whitespace-nowrap border-b border-dotted border-green-500/50 text-[10px] text-green-400 transition hover:text-green-300"
                  >
                    &gt;&gt; google'da aç
                  </a>
                )}
              </span>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};

export default RrtMonitor;
