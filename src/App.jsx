import React, { useEffect } from 'react';
import { StressTestProvider, useStressTest } from './context/StressTestContext';
import { apiClient } from './services/apiClient';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

const AppContent = () => {
  const { state, setUser, addLog } = useStressTest();

  useEffect(() => {
    const sessionId = apiClient.getSessionId();
    const username = apiClient.getUsername();
    if (sessionId && username) {
      setUser({ username });
      addLog('Oturum geri yüklendi');
    }
  }, []);

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
