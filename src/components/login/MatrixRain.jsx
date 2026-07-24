import React, { useEffect, useRef } from 'react';

const GLYPHS = '01ABCDEF0123456789<>/{}[]$#@';
const FONT_SIZE = 14;
const MAX_COLUMNS = 72;
const FRAME_INTERVAL = 66; // ms — ~15fps yeterli, CPU dostu

/**
 * Hafif matrix-rain canvas efekti.
 * - Sınırlı sütun sayısı ve düşük frame rate ile performans korunur.
 * - prefers-reduced-motion aktifse animasyon çalışmaz (tek statik kare).
 * - Unmount'ta rAF ve event listener temizlenir.
 */
const MatrixRain = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    let drops = [];
    let spacing = FONT_SIZE;
    let rafId = null;
    let lastFrame = 0;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas.parentElement || canvas;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const columns = Math.min(Math.floor(w / FONT_SIZE), MAX_COLUMNS);
      // Sütunları tüm genişliğe yay — sağ taraf boş kalmasın
      spacing = columns > 0 ? w / columns : FONT_SIZE;
      drops = Array.from({ length: columns }, () => Math.random() * -50);

      // Arkaplanı sıfırla
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    };

    const draw = () => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      // İz bırakan fade
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.fillRect(0, 0, w, h);

      ctx.font = `${FONT_SIZE}px monospace`;

      for (let i = 0; i < drops.length; i += 1) {
        const char = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        const x = i * spacing;
        const y = drops[i] * FONT_SIZE;

        // Baş karakter parlak, cyan arada
        ctx.fillStyle = Math.random() > 0.97 ? '#00d4ff' : '#00ff41';
        ctx.fillText(char, x, y);

        if (y > h && Math.random() > 0.975) {
          drops[i] = Math.random() * -20;
        }
        drops[i] += 0.5;
      }
    };

    const loop = (timestamp) => {
      if (timestamp - lastFrame >= FRAME_INTERVAL) {
        lastFrame = timestamp;
        draw();
      }
      rafId = requestAnimationFrame(loop);
    };

    resize();
    // reducedMotion'da animasyon loop'u calismadigi icin resize sonrasi
    // sifirlanan arkaplanin uzerine statik kareyi bir kez yeniden ciz
    const onResize = () => {
      resize();
      if (reducedMotion) draw();
    };
    window.addEventListener('resize', onResize);

    if (reducedMotion) {
      // Animasyon yok: tek hafif statik kare
      draw();
    } else {
      rafId = requestAnimationFrame(loop);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full opacity-40 pointer-events-none"
      aria-hidden="true"
    />
  );
};

export default MatrixRain;
