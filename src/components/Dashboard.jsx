import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import AccountSwitcher from './AccountSwitcher';
import AttackForm from './AttackForm';
import LiveAttacks from './LiveAttacks';
import ToolsPanel from './ToolsPanel';
import LoopManager from './LoopManager';
import AttackHistory from './AttackHistory';
import PhishPanel from './PhishPanel';
import ImpactMonitor from './ImpactMonitor';
import ToastContainer from './ToastContainer';

const Dashboard = () => {
  const { state, setActiveTab, logout, addLog, setPlan } = useStressTest();

  // Plan verisi AttackForm'daki limit kontrolleri icin gerekli (eskiden PlanInfo yuklerdi)
  useEffect(() => {
    const loadPlan = async () => {
      const username = apiClient.getUsername();
      if (!username) return;

      // Upstream gecici yavaslayabilir; birkac kez dene, olmazsa formu kilitsiz birak
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const [userData, planData] = await Promise.all([
            apiClient.getUser(username),
            apiClient.getPlan(username)
          ]);
          // Plan alanlari user alanlarini ezsin; user verisi sadece planda olmayan alanlari doldurur
          setPlan({ ...userData, ...planData });
          addLog(`Plan yüklendi: ${planData?.name || 'Bilinmiyor'}`);
          return;
        } catch (err) {
          addLog(`Plan yüklenemedi (deneme ${attempt}/${maxAttempts}): ${err.message}`);
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 4000));
        }
      }

      // Backend checkPlanLimits ile gercek limitleri zaten uyguluyor;
      // plan alinamadi diye form sonsuza kadar kilitli kalmasin.
      setPlan({ name: 'Bilinmiyor', fallback: true });
      addLog('Plan alınamadı; form açık bırakıldı, limitler sunucuda uygulanacak');
    };

    if (state.isAuthenticated) loadPlan();
  }, [state.isAuthenticated, setPlan, addLog]);

  // Backend'deki hesap listesinden secim: aktif oturumu degistirip sayfayi
  // yeniden yukler. Tum veri akislari (SSE, loop, plan, gecmis) yeni
  // session ile temiz baslar; sahte gecis (sadece rozetin degismesi) imkansiz.
  const handleSwitchAccount = useCallback((account) => {
    if (!account?.sessionId || !account?.username) return;
    addLog(`Hesaba geçiliyor: ${account.username}`);
    apiClient.setActiveSession(account.username, account.sessionId);
    window.location.reload();
  }, [addLog]);

  // Cikis: aktif oturum kapanir, login ekranina dusulur. Hesaplar defterde
  // kalir; baska hesapla giris yapildiginda ikisi de listede gorunur.
  const handleLogout = async () => {
    addLog('Çıkış yapıldı');
    apiClient.logout();
    logout();
  };

  const tabs = [
    { id: 'attack', label: 'Saldırı' },
    { id: 'loops', label: 'Looplar' },
    { id: 'tools', label: 'Araçlar' },
    { id: 'history', label: 'Geçmiş' },
    { id: 'phish', label: 'Phish' }
  ];

  return (
    <div className="min-h-screen bg-black text-white cyber-grid">
      <ToastContainer />
      {/* Aktif hesap rozeti + coklu hesap dropdown'i */}
      <AccountSwitcher
        activeUsername={state.user?.username || apiClient.getUsername()}
        onSwitch={handleSwitchAccount}
      />
      {/* Floating Sidebar */}
      <aside className="fixed top-4 left-4 h-auto glass-panel rounded-xl hidden md:flex flex-col items-center py-3 px-2 gap-2 z-50">
        {[
          { id: 'attack', icon: 'ph-lightning' },
          { id: 'loops', icon: 'ph-repeat' },
          { id: 'tools', icon: 'ph-wrench' },
          { id: 'history', icon: 'ph-clock-counter-clockwise' },
          { id: 'phish', icon: 'ph-shield-warning' }
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-300 ${
              state.activeTab === item.id
                ? 'bg-green-500 text-black shadow-[0_0_15px_rgba(0,255,65,0.4)]'
                : 'text-gray-500 hover:text-green-400 hover:bg-white/5'
            }`}
            title={item.id}
          >
            <i className={`ph ${item.icon} text-base`}></i>
          </button>
        ))}

        <div className="w-5 h-px bg-white/10 my-1"></div>

        <button
          onClick={handleLogout}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition"
          title="Çıkış"
        >
          <i className="ph ph-sign-out text-base"></i>
        </button>
      </aside>

      {/* Main Content */}
      <main className="pt-8 pb-12 px-6 md:pl-20 max-w-7xl mx-auto">
        {/* Mobile Tabs */}
        <div className="md:hidden flex gap-2 overflow-x-auto pb-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-300 ${
                state.activeTab === tab.id
                  ? 'bg-green-500 text-black shadow-[0_0_15px_rgba(0,255,65,0.3)]'
                  : 'bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tablo kartlari (LiveAttacks, LoopManager, AttackHistory) tum sutunlari
            yatay scroll olmadan gosterebilsin diye dikey stack + tam genislik;
            form/arac kartlari kompakt kalir */}
        <div className="flex flex-col gap-8 mt-8">
          {state.activeTab === 'attack' && (
            <>
              <div className="flex flex-col lg:flex-row gap-8 w-full items-start">
                <div className="w-full lg:max-w-2xl lg:shrink-0">
                  <AttackForm />
                </div>
                <div className="hidden lg:block flex-1 min-w-0">
                  <ImpactMonitor />
                </div>
              </div>
              <LiveAttacks />
            </>
          )}

          {state.activeTab === 'loops' && (
            <LoopManager />
          )}

          {state.activeTab === 'tools' && (
            <>
              <div className="w-full max-w-2xl">
                <ToolsPanel />
              </div>
              <LiveAttacks />
            </>
          )}

          {state.activeTab === 'history' && (
            <AttackHistory />
          )}

          {state.activeTab === 'phish' && (
            <PhishPanel />
          )}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
