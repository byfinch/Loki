import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const LIST_GAP = 8; // tetikleyici ile liste arasi bosluk (px)
const LIST_MAX_HEIGHT = 240;

/**
 * Tema uyumlu ozel dropdown (native <select> yerine).
 * - Kapaliyken AttackForm input'lariyla ayni gorunum; acikken neon border + glow.
 * - Liste createPortal ile body'e cizilir: kartlardaki `overflow: hidden`
 *   (cyber-card) listeyi kirpmasin diye. Viewport'ta yer kalmazsa yukari acilir.
 * - Disari tiklama / Escape / Tab ile kapanir; ArrowUp/ArrowDown + Enter ile
 *   klavye navigasyonu; acilinca secili item gorunur alana kaydirilir.
 * - Animasyon sadece opacity/transform (index.css: .animate-dropdown-in).
 *
 * Props:
 *   value: secili deger
 *   onChange(value): secim degisince cagrilir
 *   options: [{ value, label, description? }] — label mono, description silik gosterilir
 *   placeholder: secim yokken gosterilen metin
 *   emptyPlaceholder: options bosken gosterilen metin (orn. yukleniyor)
 *   disabled: etkilesimi kapatir
 */
const CyberSelect = ({
  value,
  onChange,
  options = [],
  placeholder = 'Seçiniz',
  emptyPlaceholder,
  disabled = false,
  id
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState(null);
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const isEmpty = options.length === 0;

  const updatePos = () => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - LIST_GAP - 8;
    const spaceAbove = rect.top - LIST_GAP - 8;
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    setPos({
      left: rect.left,
      width: rect.width,
      top: openUp ? 'auto' : rect.bottom + LIST_GAP,
      bottom: openUp ? window.innerHeight - rect.top + LIST_GAP : 'auto',
      maxHeight: Math.max(120, Math.min(LIST_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow))
    });
  };

  const toggle = () => {
    if (disabled || isEmpty) return;
    if (!open) updatePos();
    setOpen((prev) => !prev);
  };

  const close = () => setOpen(false);

  const selectAt = (idx) => {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  };

  // Disari tiklayinca kapat (liste portal'da oldugu icin onu da kapsa)
  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      const inTrigger = containerRef.current && containerRef.current.contains(e.target);
      const inList = listRef.current && listRef.current.contains(e.target);
      if (!inTrigger && !inList) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Scroll/resize'da listeyi yeniden konumlandir (karti takip etsin)
  useEffect(() => {
    if (!open) return undefined;
    const onReposition = () => updatePos();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  // Acilinca aktif item'i secili olana al
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Aktif item'i (acilis ve ok tuslariyla gezinmede) gorunur alanda tut
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        toggle();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIndex >= 0) selectAt(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const renderOptionContent = (opt) => (
    <>
      <span className="font-mono flex-shrink-0">{opt.label}</span>
      {opt.description && (
        <span className="text-gray-500 text-xs truncate flex-1 min-w-0">{opt.description}</span>
      )}
    </>
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full bg-black/60 border rounded-lg px-3 py-2.5 pr-8 text-sm text-left transition focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
          open
            ? 'border-green-400/50 shadow-[0_0_15px_rgba(0,255,65,0.1)]'
            : 'border-white/10 focus:border-green-400/50 focus:shadow-[0_0_15px_rgba(0,255,65,0.1)]'
        }`}
      >
        {selected ? (
          <span className="flex items-baseline gap-2 min-w-0">
            {renderOptionContent(selected)}
          </span>
        ) : (
          <span className="text-gray-600">
            {isEmpty ? (emptyPlaceholder || placeholder) : placeholder}
          </span>
        )}
        <svg
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={listRef}
          role="listbox"
          aria-activedescendant={activeIndex >= 0 ? `cyber-select-opt-${activeIndex}` : undefined}
          className="animate-dropdown-in fixed z-[100] overflow-y-auto rounded-lg border border-white/10 bg-[#0a0a0a] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.65),0_0_18px_rgba(0,255,65,0.06)]"
          style={{
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isActive = idx === activeIndex;
            return (
              <button
                key={opt.value}
                id={`cyber-select-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                ref={(el) => { itemRefs.current[idx] = el; }}
                onClick={() => selectAt(idx)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                  isSelected
                    ? 'bg-green-500/15 text-green-400 shadow-[inset_2px_0_0_0_#00ff41]'
                    : isActive
                      ? 'bg-green-500/[0.07] text-white'
                      : 'text-gray-300'
                }`}
              >
                {renderOptionContent(opt)}
                {isSelected && (
                  <svg
                    className="w-3.5 h-3.5 ml-auto flex-shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
};

export default CyberSelect;
