import React, { useEffect, useRef, useState } from 'react';

/**
 * AccountSwitcher.jsx
 *
 * Sag ustteki "Hesap: X" rozeti + coklu hesap dropdown'i.
 * - Rozet tiklanabilir; acikken disari tiklama / Escape ile kapanir.
 * - Kayitli hesaplar listelenir; aktif olan yesil nokta + check ile isaretli.
 * - Baska hesaba tiklayinca onSwitch(username) cagrilir (sifresiz gecis);
 *   gecis sirasinda satirlar kilitlenir.
 * - "Hesap Ekle" satiri onAddAccount() cagirir; kayitli hesaplari silmez.
 *
 * Props:
 *   accounts: [{ username, sessionId, addedAt }]
 *   activeUsername: aktif hesap kullanici adi
 *   onSwitch(username): hesap secilince cagrilir (async olabilir)
 *   onAddAccount(): "Hesap Ekle" secilince cagrilir
 */
const AccountSwitcher = ({ accounts = [], activeUsername, onSwitch, onAddAccount }) => {
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState(null);
  const containerRef = useRef(null);

  const close = () => setOpen(false);

  // Disari tiklayinca kapat
  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) close();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSelect = async (username) => {
    if (switchingTo || username === activeUsername) {
      if (username === activeUsername) close();
      return;
    }
    setSwitchingTo(username);
    try {
      await onSwitch(username);
    } finally {
      setSwitchingTo(null);
      close();
    }
  };

  const handleAdd = () => {
    close();
    onAddAccount();
  };

  return (
    <div ref={containerRef} className="fixed top-4 right-4 z-50">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`glass-panel rounded-full px-4 py-1.5 flex items-center gap-2 text-xs font-mono transition-all duration-300 focus:outline-none ${
          open
            ? 'border-green-400/50 shadow-[0_0_15px_rgba(0,255,65,0.15)]'
            : 'hover:border-green-400/30 hover:shadow-[0_0_12px_rgba(0,255,65,0.1)]'
        }`}
      >
        <i className="ph ph-user-circle text-green-400 text-sm"></i>
        <span className="text-gray-400">Hesap:</span>
        <span className="text-green-400 font-semibold max-w-[10rem] truncate">{activeUsername || '—'}</span>
        <svg
          className={`w-3 h-3 text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-dropdown-in absolute right-0 mt-2 w-60 rounded-lg border border-white/10 bg-[#0a0a0a] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.65),0_0_18px_rgba(0,255,65,0.06)]"
        >
          <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-600">
            Kayıtlı Hesaplar
          </div>

          {accounts.map((account) => {
            const isActive = account.username === activeUsername;
            const isSwitching = switchingTo === account.username;
            return (
              <button
                key={account.username}
                type="button"
                role="menuitem"
                disabled={!!switchingTo}
                onClick={() => handleSelect(account.username)}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm font-mono transition-colors disabled:cursor-wait ${
                  isActive
                    ? 'bg-green-500/15 text-green-400 shadow-[inset_2px_0_0_0_#00ff41]'
                    : 'text-gray-300 hover:bg-green-500/[0.07] hover:text-white'
                }`}
              >
                {isActive ? (
                  <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(0,255,65,0.8)] flex-shrink-0" aria-label="Aktif hesap"></span>
                ) : (
                  <span className="w-2 h-2 rounded-full bg-gray-700 flex-shrink-0"></span>
                )}
                <span className="truncate flex-1 min-w-0">{account.username}</span>
                {isSwitching ? (
                  <svg className="animate-spin h-3.5 w-3.5 text-green-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : isActive ? (
                  <svg
                    className="w-3.5 h-3.5 flex-shrink-0"
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
                ) : null}
              </button>
            );
          })}

          <div className="mx-3 my-1 h-px bg-white/10"></div>

          <button
            type="button"
            role="menuitem"
            disabled={!!switchingTo}
            onClick={handleAdd}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm font-mono text-gray-400 hover:bg-green-500/[0.07] hover:text-green-400 transition-colors disabled:cursor-wait"
          >
            <i className="ph ph-user-plus text-base flex-shrink-0"></i>
            <span>Hesap Ekle</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default AccountSwitcher;
