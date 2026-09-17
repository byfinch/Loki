import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';

/**
 * GroupPicker.jsx — degisebilen grup kutusu.
 * Normal hali secici (mevcut gruplar + "yeni grup olustur"). "Yeni grup"
 * secilince AYNI kutu yazilabilir input'a doner; ✓ (veya Enter) olusturur,
 * × (veya Escape) vazgecer. Baska alana tiklamak (blur) yazili isim varsa
 * olusturur — secicide yeni isim hemen gorunur (optimistik option), geri
 * sarilmaz.
 */

// Gruplar icin hafif paylasim: her picker fetch eder; birinde degisiklik
// olunca 'loki-groups-changed' eventi ile digerleri tazelenir.
export const notifyGroupsChanged = () => window.dispatchEvent(new Event('loki-groups-changed'));

export function useGroups() {
  const [groups, setGroups] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const list = await apiClient.getGroups();
      setGroups(list.map((g) => g.name));
    } catch { /* sessiz */ }
  }, []);
  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener('loki-groups-changed', h);
    return () => window.removeEventListener('loki-groups-changed', h);
  }, [refresh]);
  return groups;
}

const GroupPicker = ({ groups, value, onChange, compact = false }) => {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');

  const selCls = compact
    ? 'w-full appearance-none rounded-sm border border-green-500/30 bg-black px-2 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]'
    : 'w-full appearance-none rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]';
  const inpCls = compact
    ? 'w-full rounded-sm border border-cyan-500/50 bg-black pl-2 pr-14 py-1.5 text-[11px] text-cyan-300 focus:outline-none focus:shadow-[0_0_10px_rgba(0,212,255,0.2)]'
    : 'w-full rounded-sm border border-cyan-500/50 bg-black pl-3 pr-16 py-2.5 text-[13px] text-cyan-300 focus:outline-none focus:shadow-[0_0_12px_rgba(0,212,255,0.2)]';

  const commit = () => {
    const v = draft.trim();
    if (v) onChange(v);
    setWriting(false);
    setDraft('');
  };
  const cancel = () => { setWriting(false); setDraft(''); };

  if (writing) {
    return (
      <div className="relative">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') cancel();
          }}
          // Baska alana gecis: isim yaziliysa olustur (kaybolmaz), bossa vazgec
          onBlur={() => { if (draft.trim()) commit(); else cancel(); }}
          placeholder="yeni grup adı yaz..."
          className={inpCls}
        />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-1">
          <button
            type="button"
            title="Oluştur"
            onMouseDown={(e) => { e.preventDefault(); commit(); }}
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-cyan-500/50 bg-cyan-500/15 text-[11px] font-bold text-cyan-300 transition hover:bg-cyan-500/30"
          >
            ✓
          </button>
          <button
            type="button"
            title="Vazgeç"
            onMouseDown={(e) => { e.preventDefault(); cancel(); }}
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-red-500/35 bg-black/60 text-[11px] text-red-400 transition hover:bg-red-500/15"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  return (
    <select
      value={value || ''}
      onChange={(e) => {
        if (e.target.value === '__new__') { setWriting(true); return; }
        onChange(e.target.value || null);
      }}
      className={selCls}
    >
      <option value="">grupsuz</option>
      {groups.map((g) => (
        <option key={g} value={g}>{g.toLocaleLowerCase('tr')}</option>
      ))}
      {/* Az önce yazilan yeni isim liste fetch'i bitmeden secicide gorunsun;
          aksi halde deger seceneksiz kalip "grupsuz"a geri sariliyordu
          (kullaniciya "grup silindi" hissi veren bug). */}
      {value && !groups.includes(value) && (
        <option value={value}>{value.toLocaleLowerCase('tr')}</option>
      )}
      <option value="__new__">＋ yeni grup oluştur</option>
    </select>
  );
};

export default GroupPicker;
