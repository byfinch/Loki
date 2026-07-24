import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

const PlanInfo = () => {
  const { state, setPlan, addLog } = useStressTest();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadPlan = async () => {
      try {
        const username = apiClient.getUsername();
        if (!username) return;

        const [userData, planData] = await Promise.all([
          apiClient.getUser(username),
          apiClient.getPlan(username)
        ]);

        // Plan alanlari user alanlarini ezsin; user verisi sadece planda olmayan alanlari doldurur
        setPlan({ ...userData, ...planData });
        addLog(`Plan yüklendi: ${planData?.name || 'Bilinmiyor'}`);
      } catch (err) {
        addLog(`Plan yüklenemedi: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    if (state.isAuthenticated) loadPlan();
  }, [state.isAuthenticated]);

  if (loading) {
    return (
      <div className="glass-panel rounded-xl p-6 animate-pulse">
        <div className="h-4 bg-white/10 rounded w-1/3 mb-4"></div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="h-16 bg-white/5 rounded-lg"></div>
          <div className="h-16 bg-white/5 rounded-lg"></div>
          <div className="h-16 bg-white/5 rounded-lg"></div>
          <div className="h-16 bg-white/5 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (!state.plan) return null;

  const { name, Concurrents, MaxTime, limit, UdpAccess, expiry, balance, premium } = state.plan;

  const stats = [
    { label: 'Plan', value: name || '-', accent: 'text-cyan-400' },
    { label: 'Concurrents', value: Concurrents || 0, accent: 'text-green-400' },
    { label: 'Max Süre (sn)', value: MaxTime ? MaxTime.toLocaleString() : '-', accent: 'text-yellow-400' },
    { label: 'Limit', value: limit ? limit.toLocaleString() : '-', accent: 'text-purple-400' },
    { label: 'UDP Erişim', value: UdpAccess ? 'Evet' : 'Hayır', accent: UdpAccess ? 'text-green-400' : 'text-red-400' },
    { label: 'Bitiş', value: expiry || '-', accent: 'text-blue-400' },
    { label: 'Bakiye', value: balance !== undefined ? `$${balance}` : '-', accent: 'text-emerald-400' },
    { label: 'Premium', value: premium ? 'Evet' : 'Hayır', accent: premium ? 'text-amber-400' : 'text-gray-400' }
  ];

  return (
    <div className="glass-panel rounded-xl p-6 hover-glow transition-all duration-300">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        Abonelik Bilgileri
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat, index) => (
          <div key={index} className="bg-black/40 border border-white/5 rounded-lg p-3 hover:border-green-500/30 transition-colors duration-300 group">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider group-hover:text-green-400 transition-colors">{stat.label}</p>
            <p className={`font-mono font-bold mt-1 ${stat.accent}`}>{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PlanInfo;
