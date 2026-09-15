import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import AccountSwitcher from './AccountSwitcher';
import AccountSwitchOverlay from './AccountSwitchOverlay';
import AttackForm from './AttackForm';
import LiveAttacks from './LiveAttacks';
import ToolsPanel from './ToolsPanel';
import LoopManager from './LoopManager';
import AttackHistory from './AttackHistory';
import PhishPanel from './PhishPanel';
import LinkWatcher from './LinkWatcher';
import InvaderPanel from './InvaderPanel';
import SiteWatcher from './SiteWatcher';
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

  // Backend'deki hesap listesinden secim: once siber temali gecis overlay'i
  // oynatilir (~2.5sn), sonra aktif oturum degisip sayfa yeniden yuklenir.
  const [switchTarget, setSwitchTarget] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Mobil cekmece + masaustu tab etiketleri ortak kaynak
  const NAV_ITEMS = [
    { id: 'attack', icon: 'ph-lightning', label: 'Saldırı' },
    { id: 'loops', icon: 'ph-repeat', label: 'Looplar' },
    { id: 'watch', icon: 'ph-link', label: 'Gözcü' },
    { id: 'invader', icon: 'ph-shield-check', label: 'Invader' },
    { id: 'sitewatch', icon: 'ph-pulse', label: 'Watcher' },
    { id: 'tools', icon: 'ph-wrench', label: 'Araçlar' },
    { id: 'history', icon: 'ph-clock-counter-clockwise', label: 'Geçmiş' },
    { id: 'phish', icon: 'ph-shield-warning', label: 'Phish' }
  ];

  const handleSwitchAccount = useCallback((account) => {
    if (!account?.sessionId || !account?.username) return;
    addLog(`Hesaba geçiliyor: ${account.username}`);
    setSwitchTarget(account);
  }, [addLog]);

  const completeSwitch = useCallback(() => {
    if (!switchTarget) return;
    apiClient.setActiveSession(switchTarget.username, switchTarget.sessionId);
    window.location.reload();
  }, [switchTarget]);

  // Cikis: aktif oturum kapanir, login ekranina dusulur. Hesaplar defterde
  // kalir; baska hesapla giris yapildiginda ikisi de listede gorunur.
  const handleLogout = async () => {
    addLog('Çıkış yapıldı');
    apiClient.logout();
    logout();
  };

  return (
    <div className="min-h-screen bg-black text-white cyber-grid">
      <ToastContainer />
      {switchTarget && (
        <AccountSwitchOverlay
          targetUsername={switchTarget.username}
          onComplete={completeSwitch}
        />
      )}
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
          { id: 'watch', icon: 'ph-link' },
          { id: 'invader', icon: 'ph-shield-check' },
          { id: 'sitewatch', icon: 'ph-pulse' },
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

      {/* Mobil: hamburger + soldan kayan cekmece navigasyon */}
      <button
        onClick={() => setDrawerOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-lg glass-panel flex items-center justify-center text-green-400 shadow-[0_0_15px_rgba(0,255,65,0.2)]"
        title="Menü"
        aria-label="Menüyü aç"
      >
        <i className="ph ph-list text-xl"></i>
      </button>
      {drawerOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <aside className="md:hidden fixed top-0 left-0 bottom-0 z-50 w-64 glass-panel border-r border-green-500/25 bg-black/95 flex flex-col py-4 px-3 gap-1 overflow-y-auto">
            <div className="flex items-center justify-between px-2 pb-3 border-b border-green-500/20 mb-2">
              <span className="text-[11px] font-bold tracking-widest text-green-400">LOKİ · MENÜ</span>
              <button onClick={() => setDrawerOpen(false)} className="text-gray-500 hover:text-red-400 text-lg leading-none" aria-label="Kapat">×</button>
            </div>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => { setActiveTab(item.id); setDrawerOpen(false); }}
                className={`flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-all ${
                  state.activeTab === item.id
                    ? 'bg-green-500/15 text-green-400 [text-shadow:0_0_8px_rgba(0,255,65,0.5)]'
                    : 'text-gray-400 hover:bg-white/5 hover:text-green-300'
                }`}
              >
                <i className={`ph ${item.icon} text-lg`}></i>
                <span className="text-[13px] font-medium">{item.label}</span>
              </button>
            ))}
            <div className="mt-auto pt-3 border-t border-white/10">
              <button
                onClick={handleLogout}
                className="flex items-center gap-3 rounded-lg px-3 py-3 text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition w-full text-left"
              >
                <i className="ph ph-sign-out text-lg"></i>
                <span className="text-[13px] font-medium">Çıkış</span>
              </button>
            </div>
          </aside>
        </>
      )}

      {/* Main Content */}
      <main className="pt-8 pb-12 px-3 sm:px-6 md:pl-20 max-w-7xl mx-auto">

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

          {state.activeTab === 'watch' && (
            <LinkWatcher />
          )}

          {state.activeTab === 'invader' && (
            <InvaderPanel />
          )}

          {state.activeTab === 'sitewatch' && (
            <SiteWatcher />
          )}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
