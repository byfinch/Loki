import React, { useEffect, useRef, useState } from 'react';

/**
 * AccountSwitchOverlay.jsx
 * Hesap gecisi sirasinda tam ekran siber temali gecis animasyonu (V3 Glitch).
 * Progress kendiliginden dolar; onComplete ~%100 sonrasi "ERISIM ONAYLANDI"
 * parlamasindan sonra cagrilir (ornegin reload icin).
 *
 * Props:
 *   targetUsername: gecilen hesap (stage metinlerinde gosterilir)
 *   onComplete(): animasyon bitince cagrilir
 */
const STAGES = [
  'BAĞLANTI KURULUYOR',
  'OTURUM DOĞRULANIYOR',
  'YETKİ EŞLENİYOR',
  'PANEL YÜKLENİYOR'
];

const AccountSwitchOverlay = ({ targetUsername, onComplete }) => {
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setPct((prev) => {
        const next = Math.min(100, prev + Math.random() * 4 + 1.5);
        return next;
      });
    }, 110);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (pct >= 100 && !completedRef.current) {
      completedRef.current = true;
      setDone(true);
      const t = setTimeout(() => onComplete?.(), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pct, onComplete]);

  const stage = done ? '' : STAGES[Math.min(STAGES.length - 1, Math.floor(pct / 26))];

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center gap-6 font-mono" role="alert" aria-label="Hesap değiştiriliyor">
      {/* Glitch logo */}
      <div className="relative w-[110px] h-[110px]">
        <img src="/logo.png" alt="Loki" className="w-[110px] h-[110px]" />
        <div className="absolute inset-0 pointer-events-none">
          <img src="/logo.png" alt="" aria-hidden="true" className="switch-glitch-1 absolute top-0 left-0 w-[110px] h-[110px]" />
        </div>
        <div className="absolute inset-0 pointer-events-none">
          <img src="/logo.png" alt="" aria-hidden="true" className="switch-glitch-2 absolute top-0 left-0 w-[110px] h-[110px]" />
        </div>
      </div>

      <div className="text-3xl text-green-400 [text-shadow:0_0_18px_rgba(0,255,65,0.5)]">
        {Math.floor(pct)}%
      </div>

      <div className="w-[min(380px,80vw)] h-1.5 border border-green-500/30 rounded-full overflow-hidden bg-green-500/5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-green-400 to-cyan-400 shadow-[0_0_14px_rgba(0,255,65,0.6)] transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="text-xs text-cyan-400 tracking-[3px] min-h-4">
        {stage}
        {!done && pct > 0 && (
          <span className="text-gray-500 normal-case tracking-normal"> · hedef: {targetUsername}</span>
        )}
      </div>

      {done && (
        <div className="switch-done text-green-400 text-[15px] tracking-[3px] [text-shadow:0_0_20px_rgba(0,255,65,0.7)]">
          ERİŞİM ONAYLANDI
        </div>
      )}
    </div>
  );
};

export default AccountSwitchOverlay;
