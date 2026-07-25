import { useEffect, useRef } from 'react';

const MAX_TILT = 4; // derece — tablolarin okunabilirligini bozmayacak kadar hafif
const PERSPECTIVE = 900; // px
const RESET_TRANSITION = 'transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Mouse pozisyonuna gore hafif 3D tilt (rotateX/rotateY) uygulayan hook.
 * - Sadece transform ve CSS degiskeni gunceller; rAF ile throttle edilir.
 * - --mx / --my degiskenleri hover sheen efektinin mouse'u takip etmesi icin yazilir.
 * - prefers-reduced-motion veya dokunmatik (coarse pointer) cihazlarda devre disidir.
 * - Unmount'ta listener'lar ve rAF temizlenir.
 *
 * Kullanim: const ref = useTilt(); <div ref={ref} className="cyber-card ...">
 */
const useTilt = () => {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    if (reducedMotion || coarsePointer) return undefined;

    let rafId = null;
    let pending = null;

    const apply = () => {
      rafId = null;
      if (!pending) return;
      const { rx, ry, mx, my } = pending;
      pending = null;
      el.style.transform = `perspective(${PERSPECTIVE}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      el.style.setProperty('--mx', `${mx}%`);
      el.style.setProperty('--my', `${my}%`);
    };

    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(apply);
    };

    const onMouseMove = (e) => {
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      pending = {
        rx: ((0.5 - py) * 2 * MAX_TILT).toFixed(2),
        ry: ((px - 0.5) * 2 * MAX_TILT).toFixed(2),
        mx: (px * 100).toFixed(1),
        my: (py * 100).toFixed(1)
      };
      schedule();
    };

    const onMouseEnter = () => {
      // Takip sirasinda transition olmasin; reset'te yumusak donus icin leave'de eklenir
      el.style.transition = '';
    };

    const onMouseLeave = () => {
      pending = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      el.style.transition = RESET_TRANSITION;
      el.style.transform = '';
    };

    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseleave', onMouseLeave);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      el.removeEventListener('mouseenter', onMouseEnter);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  return ref;
};

export default useTilt;
