import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';

/**
 * GroupPicker.jsx — degisebilen grup kutusu.
 * Normal hali secici (mevcut gruplar + "yeni grup olustur"); "yeni grup"
 * secilince AYNI kutu yazilabilir input'a doner, sag ucundaki x ile geri
 * donulur. Yeni isim girilip onChange disari verildiginde grup backend'de
 * olusur (resolveGroupName) ve tum pickarlar tazelenir.
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
    ? 'w-full rounded-sm border border-green-500/30 bg-black pl-2 pr-7 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]'
    : 'w-full rounded-sm border border-green-500/30 bg-black pl-3 pr-8 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]';

  if (writing) {
    return (
      <div className="relative">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { const v = draft.trim(); if (v) { onChange(v); setWriting(false); setDraft(''); } }
            if (e.key === 'Escape') { setWriting(false); setDraft(''); }
          }}
          onBlur={() => {
            const v = draft.trim();
            if (v) onChange(v);
            setWriting(false); setDraft('');
          }}
          placeholder="yeni grup adı yaz..."
          className={inpCls}
        />
        <button
          type="button"
          title="Vazgeç"
          onMouseDown={(e) => { e.preventDefault(); setWriting(false); setDraft(''); }}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm border border-red-500/35 bg-black/60 text-[11px] text-red-400 transition hover:bg-red-500/15"
        >
          ×
        </button>
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
      <option value="__new__">＋ yeni grup oluştur</option>
    </select>
  );
};

export default GroupPicker;
