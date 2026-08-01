import React, { useEffect, useRef } from 'react';
import { StressTestProvider, useStressTest } from './context/StressTestContext';
import { apiClient } from './services/apiClient';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

const AppContent = () => {
  const { state, setUser, logout, addLog, showToast } = useStressTest();
  // StrictMode'da effect'in cift calismasini engelle
  const sessionValidatedRef = useRef(false);

  useEffect(() => {
    if (sessionValidatedRef.current) return;
    sessionValidatedRef.current = true;

    const validateSession = async () => {
      // Aktif session gecersizse kayitli diger hesaplara sirayla dus;
      // her 401'de apiClient.logout() o hesabi defterden de sildigi icin dongu sonlanir.
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
            // Oturum gercekten gecersiz; defterden de sil
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
    };

    validateSession();
  }, [setUser, logout, addLog, showToast]);

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
