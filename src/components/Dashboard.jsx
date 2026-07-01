import React from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import PlanInfo from './PlanInfo';
import AttackForm from './AttackForm';
import LiveAttacks from './LiveAttacks';
import ToolsPanel from './ToolsPanel';
import LoopManager from './LoopManager';
import ToastContainer from './ToastContainer';

const Dashboard = () => {
  const { state, setActiveTab, logout, addLog } = useStressTest();

  const handleLogout = () => {
    apiClient.logout();
    logout();
    addLog('Çıkış yapıldı');
  };

  const tabs = [
    { id: 'attack', label: 'Saldırı' },
    { id: 'loops', label: 'Looplar' },
    { id: 'tools', label: 'Araçlar' }
  ];

  return (
    <div className="min-h-screen bg-black text-white cyber-grid">
      <ToastContainer />
      {/* Floating Sidebar */}
      <aside className="fixed top-4 left-4 h-auto glass-panel rounded-xl hidden md:flex flex-col items-center py-3 px-2 gap-2 z-50">
        {[
          { id: 'attack', icon: 'ph-lightning' },
          { id: 'loops', icon: 'ph-repeat' },
          { id: 'tools', icon: 'ph-wrench' }
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
      <main className="pt-6 pb-12 px-6 md:pl-20 max-w-7xl mx-auto">
        <PlanInfo />

        {/* Mobile Tabs */}
        <div className="md:hidden flex gap-2 mt-6 mb-6 overflow-x-auto pb-2">
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

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.35fr] items-start gap-6 mt-6">
          {state.activeTab === 'attack' && (
            <>
              <AttackForm />
              <LiveAttacks />
            </>
          )}

          {state.activeTab === 'loops' && (
            <LoopManager />
          )}

          {state.activeTab === 'tools' && (
            <>
              <ToolsPanel />
              <LiveAttacks />
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
