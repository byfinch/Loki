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
      const sessionId = apiClient.getSessionId();
      const username = apiClient.getUsername();
      if (!sessionId || !username) return;

      try {
        // Session'ın backend'de hâlâ geçerli olduğunu doğrula
        const user = await apiClient.getUser(username);
        setUser(user);
        addLog('Oturum geri yüklendi');
      } catch (err) {
        apiClient.logout();
        logout();
        addLog('Oturum geçersiz, çıkış yapıldı');
        showToast('Oturumunuz sonlanmış, lütfen tekrar giriş yapın', 'error');
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
