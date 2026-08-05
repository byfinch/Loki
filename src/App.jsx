import React, { useEffect, useRef, useState } from 'react';
import { StressTestProvider, useStressTest } from './context/StressTestContext';
import { apiClient } from './services/apiClient';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

// Session dogrulanirken login ekraninin flas yapmasini engelleyen temali splash.
const ValidatingSplash = () => (
  <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-5 font-mono">
    <div className="relative w-[90px] h-[90px]">
      <img src="/logo.png" alt="Loki" className="w-[90px] h-[90px]" />
      <div className="absolute inset-0 pointer-events-none">
        <img src="/logo.png" alt="" aria-hidden="true" className="switch-glitch-1 absolute top-0 left-0 w-[90px] h-[90px]" />
      </div>
      <div className="absolute inset-0 pointer-events-none">
        <img src="/logo.png" alt="" aria-hidden="true" className="switch-glitch-2 absolute top-0 left-0 w-[90px] h-[90px]" />
      </div>
    </div>
    <div className="text-xs text-cyan-400 tracking-[3px]">OTURUM DOĞRULANIYOR</div>
    <div className="w-40 h-1 border border-green-500/30 rounded-full overflow-hidden bg-green-500/5">
      <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-green-400 to-cyan-400 shadow-[0_0_12px_rgba(0,255,65,0.5)] splash-indeterminate" />
    </div>
  </div>
);

const AppContent = () => {
  const { state, setUser, logout, addLog, showToast } = useStressTest();
  // StrictMode'da effect'in cift calismasini engelle
  const sessionValidatedRef = useRef(false);
  // Session varsa dogrulama bitmeden login gosterme (flash'i onler)
  const [validating, setValidating] = useState(() => Boolean(apiClient.getSessionId()));

  useEffect(() => {
    if (sessionValidatedRef.current) return;
    sessionValidatedRef.current = true;

    const validateSession = async () => {
      // Aktif session gecersizse o hesabi defterden silip kayitli diger
      // hesaplara sirayla dus; hesap kalmazsa login ekranina donulur.
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const sessionId = apiClient.getSessionId();
          const username = apiClient.getUsername();
          if (!sessionId || !username) return;

          try {
            // Session'ın backend'de hâlâ geçerli olduğunu doğrula
            const user = await apiClient.getUser(username);
            setUser(user);
            addLog('Oturum geri yüklendi');
            return;
          } catch (err) {
            if (err.status === 401 || err.status === 403) {
              // Oturum gercekten gecersiz: hesabi defterden sil, siradakine gec
              apiClient.removeAccount(username);
              apiClient.logout();
              const next = apiClient.getAccounts()[0];
              if (next && apiClient.switchAccount(next.username)) {
                addLog(`Oturum geçersiz; ${next.username} hesabı deneniyor`);
                continue;
              }
              logout();
              addLog('Oturum geçersiz, çıkış yapıldı');
              showToast('Oturumunuz sonlanmış, lütfen tekrar giriş yapın', 'error');
              return;
            }
            // Gecici ag/timeout hatasi: gecerli oturumu silme, bir sonraki acilista tekrar denenir
            addLog('Oturum doğrulanamadı (ağ hatası), oturum korunuyor');
            return;
          }
        }
      } finally {
        setValidating(false);
      }
    };

    validateSession();
  }, [setUser, logout, addLog, showToast]);

  if (validating) {
    return <ValidatingSplash />;
  }

  if (!state.isAuthenticated) {
    return <Login />;
  }

  return <Dashboard />;
};

const App = () => {
  return (
    <StressTestProvider>
      <AppContent />
    </StressTestProvider>
  );
};

export default App;
