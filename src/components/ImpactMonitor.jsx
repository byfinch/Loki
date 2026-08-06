import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../services/apiClient';

/**
 * Etki Monitoru (Faz 1)
 * Aktif saldiri/loop hedeflerinin check-host.net olcumlerini gosterir.
 * 30 sn'de bir /api/impact poll eder (yalnizca kart gorunurken, lg ve ustu).
 *
 * Liste her zaman onem sirasina gore dizilir:
 * down -> degraded -> redirect -> up -> measuring (kritik durumlar ustte).
 * 4'ten fazla hedef varsa kart sabit yukseklikte kalir, liste dahili kayar
 * (.impact-scroll, index.css).
 */

const POLL_MS = 30000;
const MAX_VISIBLE = 4;

// Onem sirasi: dusuk deger ustte
const STATE_ORDER = { down: 0, degraded: 1, redirect: 2, up: 3, measuring: 4 };

// "Kritik" sayaci: saldirinin etki ettigi durumlar
const CRITICAL_STATES = new Set(['down', 'degraded', 'redirect']);

const STATE_CONFIG = {
  down: {
    icon: '🔴',
    label: 'Düştü',
    pill: 'text-red-400 border-red-500/40 bg-red-500/10',
    accent: 'rgba(248, 113, 113, 0.8)'
  },
  degraded: {
    icon: '🟠',
    label: 'Yavaşlıyor',
    pill: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
    accent: 'rgba(251, 191, 36, 0.8)'
  },
  redirect: {
    icon: '🟠',
    label: 'Yönlendirme',
    pill: 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10',
    accent: 'rgba(250, 204, 21, 0.8)'
  },
  up: {
    icon: '🟢',
    label: 'Ayakta',
    pill: 'text-green-400 border-green-500/40 bg-green-500/10',
    accent: 'rgba(0, 255, 65, 0.8)'
  },
  measuring: {
    icon: '⚪',
    label: 'Ölçülüyor',
    pill: 'text-gray-400 border-gray-500/40 bg-gray-500/10',
    accent: 'rgba(156, 163, 175, 0.5)'
  }
};

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour12: false });
}

function formatNext(nextCheckAt) {
  if (!nextCheckAt) return null;
  const diffMs = nextCheckAt - Date.now();
  if (diffMs <= 0) return '<1 dk';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `~${Math.max(1, mins)} dk`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `~${hours} sa ${rem} dk` : `~${hours} sa`;
}

function shortenHost(host) {
  if (!host) return '—';
  // Goruntude sade domain (protokol ve sondaki / kirpilir)
  const bare = String(host).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return bare.length > 28 ? `${bare.slice(0, 25)}...` : bare;
}

function nodeShortName(node) {
  // tr1.node.check-host.net -> tr1
  return String(node || '').split('.')[0] || node;
}

const ImpactMonitor = () => {
  const [targets, setTargets] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let interval = null;
    // Panel 'hidden lg:block' wrapper'da: poll yalnizca kart gorunurken
    // (min-width: 1024px) calissin; media query degisimini de dinle.
    const mql = window.matchMedia('(min-width: 1024px)');

    const load = async () => {
      try {
        const data = await apiClient.getImpact();
        if (cancelled) return;
        setTargets(data.targets || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
      }
    };

    const startPolling = () => {
      if (interval) return;
      load();
      interval = setInterval(load, POLL_MS);
    };

    const stopPolling = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };

    const onMediaChange = (e) => (e.matches ? startPolling() : stopPolling());

    if (mql.matches) startPolling();
    mql.addEventListener('change', onMediaChange);
    return () => {
      cancelled = true;
      stopPolling();
      mql.removeEventListener('change', onMediaChange);
    };
  }, []);

  // Her zaman onem sirasina gore dizilmis liste (kritik durumlar ustte)
  const sortedTargets = useMemo(
    () =>
      [...targets].sort(
        (a, b) => (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99)
      ),
    [targets]
  );

  const criticalCount = useMemo(
    () => targets.filter((t) => CRITICAL_STATES.has(t.state)).length,
    [targets]
  );

  const scrollable = sortedTargets.length > MAX_VISIBLE;

  // Lite satir stili: durum nokta + metin rengi
  const DOT = {
    down: 'bg-[#ff2d2d] shadow-[0_0_8px_#ff2d2d] animate-pulse',
    degraded: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]',
    redirect: 'bg-yellow-300 shadow-[0_0_8px_rgba(250,204,21,0.7)]',
    up: 'bg-green-400 shadow-[0_0_8px_rgba(0,255,65,0.6)]',
    measuring: 'bg-gray-500'
  };
  const STATE_TEXT = {
    down: 'text-[#ff5c5c]',
    degraded: 'text-amber-400',
    redirect: 'text-yellow-300',
    up: 'text-green-400',
    measuring: 'text-gray-500'
  };

  return (
    <div className="relative flex w-full flex-col overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
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
        <span className="text-green-500/60">$ watcher --interval 30s --source check-host.net</span>
        <span className="animate-pulse">▊</span>
        {targets.length > 0 && (
          <span className="ml-auto whitespace-nowrap text-[10px] text-green-500/60">
            {targets.length} hedef
            {criticalCount > 0 && <span className="font-bold text-[#ff5c5c]"> · {criticalCount} kritik</span>}
          </span>
        )}
      </div>

      <div className="relative z-10 p-3 sm:p-4">
        {error && (
          <div className="flex items-center gap-2 rounded-sm border border-[#ff2d2d]/45 border-l-[3px] border-l-[#ff2d2d] bg-[#ff2d2d]/10 px-3 py-2 text-[11px] text-[#ff5c5c]">
            <span className="font-bold text-[#ff2d2d]">[ERR]</span>
            <span className="truncate">veri alinamadi: {error}</span>
          </div>
        )}

        {!error && targets.length === 0 && (
          <div className="py-10 text-center text-green-500/50">
            <p>aktif saldiri yok.</p>
            <p className="mt-2 text-[10px] text-green-500/30"># etki olcumu saldiri baslayinca gorunur</p>
          </div>
        )}

        {/* Hedef listesi: 4'ten fazlaysa sabit yukseklikte dahili scroll */}
        <div className={scrollable ? 'max-h-[420px] overflow-y-auto impact-scroll pr-1.5' : ''}>
          {sortedTargets.map((t) => {
            const state = STATE_CONFIG[t.state] || STATE_CONFIG.measuring;
            const next = formatNext(t.nextCheckAt);
            return (
              <div
                key={t.key}
                className="border-b border-dashed border-green-500/10 px-2 py-2.5 transition-colors hover:bg-green-500/5"
              >
                {/* Satir 1: nokta + hedef + chip'ler + durum */}
                <div className="flex items-center gap-2.5">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT[t.state] || DOT.measuring}`} />
                  <span className="truncate text-[12px] font-bold text-green-100" title={t.host}>
                    {shortenHost(t.host)}
                  </span>
                  <span className="flex-shrink-0 rounded-sm border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-px text-[9px] text-cyan-400/90">
                    {t.layer}
                  </span>
                  {t.isLoop && (
                    <span className="flex-shrink-0 rounded-sm border border-purple-500/30 bg-purple-500/10 px-1.5 py-px text-[9px] text-purple-400">
                      loop
                    </span>
                  )}
                  {t.final && (
                    <span className="flex-shrink-0 rounded-sm border border-gray-500/30 bg-gray-500/10 px-1.5 py-px text-[9px] text-gray-400">
                      final
                    </span>
                  )}
                  <span className={`ml-auto flex-shrink-0 text-[11px] font-bold ${STATE_TEXT[t.state] || STATE_TEXT.measuring}`}>
                    {state.label}
                  </span>
                </div>

                {/* Satir 2: gecikme + node ozeti */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[18px] text-[10px] text-gray-500">
                  <span>
                    gecikme <span className="text-gray-200">{t.avgMs != null ? `${t.avgMs}ms` : '—'}</span>
                    <span className="text-gray-700"> / </span>
                    baseline <span className="text-gray-200">{t.baselineMs != null ? `${t.baselineMs}ms` : '—'}</span>
                  </span>
                  {t.perNode && t.perNode.length > 0 && (
                    <span className="flex flex-wrap gap-x-2.5">
                      {t.perNode.map((n) => (
                        <span key={n.node}>
                          <span className="text-gray-600">{nodeShortName(n.node)} </span>
                          <span className={n.ok ? 'text-green-500/80' : 'text-[#ff5c5c]'}>
                            {n.ok ? `${n.ms != null ? `${n.ms}ms` : 'ok'}` : 'timeout'}
                          </span>
                        </span>
                      ))}
                    </span>
                  )}
                </div>

                {/* Satir 3: zaman */}
                <div className="mt-0.5 pl-[18px] text-[9px] text-gray-600">
                  # son ölçüm {formatTime(t.lastCheckAt)}
                  {next ? ` · sıradaki ${next}` : t.final ? ' · takip tamamlandı' : ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ImpactMonitor;
