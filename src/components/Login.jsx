import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import MatrixRain from './login/MatrixRain';

const Login = () => {
  const { setUser, addLog } = useStressTest();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const data = await apiClient.login(username, password);
      const user = data?.user;

      if (!user || !user.username) {
        throw new Error('Sunucu yanıtı geçersiz: kullanıcı bilgisi alınamadı');
      }

      setUser(user);
      addLog(`Giriş başarılı: ${user.username}`);
    } catch (err) {
      setError(err.message || 'Giriş başarısız');
      addLog(`Giriş hatası: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4 sm:p-6 relative overflow-hidden">
      {/* 1A arka plani: matrix rain + vinyet */}
      <MatrixRain />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,.8) 100%)' }} />
      <style>{`
        @keyframes login-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        .login-rise { animation: login-rise .5s ease-out both; }
      `}</style>

      <div className="login-rise w-full max-w-[460px] relative z-10">
        <div className="rounded-2xl overflow-hidden border border-[#17492c] bg-[#040b06]/95 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
          {/* Baslik seridi: logo + LOKI (Orbitron) + altbaslik */}
          <div className="flex items-center gap-4 px-6 py-5 bg-green-500/5 border-b border-[#17492c]">
            <img
              src="/logo.png"
              alt="Loki Panel"
              width="104"
              height="104"
              loading="eager"
              className="h-14 w-14 drop-shadow-[0_0_16px_rgba(0,255,65,.35)]"
            />
            <div className="flex flex-col">
              <h1 className="font-bold text-[#f0fff5] text-[22px] leading-none tracking-[10px] [text-shadow:0_0_16px_rgba(0,255,65,.4)]" style={{ fontFamily: 'Orbitron, Consolas, monospace' }}>
                LOKI
              </h1>
              <span className="mt-1.5 text-[9px] tracking-[4px] text-[#54a874]">STRESS-TEST PANELİ</span>
            </div>
          </div>

          {/* Form govdesi */}
          <div className="px-6 py-7">
            {error && (
              <div
                role="alert"
                className="mb-5 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm font-mono animate-toast-fade-in flex items-start gap-2"
              >
                <span className="text-red-500 font-bold shrink-0">[ERR]</span>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="login-username" className="block text-[10px] font-medium font-mono text-[#54a874] mb-2 tracking-[3px]">
                  KULLANICI ADI
                </label>
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full min-h-[46px] bg-[#020a05] border border-[#1a4f2f] rounded-lg px-4 py-3 text-base font-mono text-white placeholder-[#1d4a2e] transition-all duration-300 focus:border-green-400/70 focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,255,65,0.1)] hover:border-[#2a6b42]"
                  placeholder="Yavrukurt"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-[10px] font-medium font-mono text-[#54a874] mb-2 tracking-[3px]">
                  ŞİFRE
                </label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full min-h-[46px] bg-[#020a05] border border-[#1a4f2f] rounded-lg px-4 py-3 text-base font-mono text-white placeholder-[#1d4a2e] transition-all duration-300 focus:border-green-400/70 focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,255,65,0.1)] hover:border-[#2a6b42]"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full min-h-[48px] bg-gradient-to-b from-[#1fe95f] to-[#0aa843] hover:from-[#2af56c] hover:to-[#0bc04b] text-[#03140a] font-bold font-mono py-3 rounded-lg tracking-[5px] transition-all duration-300 hover:shadow-[0_8px_30px_rgba(0,255,65,.35)] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Doğrulanıyor...</span>
                  </>
                ) : (
                  <span>GİRİŞ YAP</span>
                )}
              </button>

              <div className="pt-1 text-center font-mono text-[9px] tracking-[3px] text-[#2e6b44]" aria-hidden="true">
                STRESSE.ST · RACKGHOST · ŞİFRELİ BAĞLANTI
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
