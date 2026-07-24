import React, { useState } from 'react';
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
    <div className="min-h-screen bg-black flex items-center justify-center p-4 sm:p-6 cyber-grid scanlines relative overflow-hidden">
      {/* Matrix rain arka plan efekti */}
      <MatrixRain />

      {/* Ambient glow lekeleri */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-green-500/5 rounded-full blur-3xl animate-float motion-reduce:animate-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl animate-float motion-reduce:animate-none" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <img
            src="/logo.png"
            alt="Loki Panel"
            width="112"
            height="112"
            loading="eager"
            className="h-24 w-24 sm:h-28 sm:w-28 drop-shadow-[0_0_25px_rgba(0,255,65,0.35)]"
          />
        </div>

        {/* Başlık */}
        <div className="text-center mb-6 select-none">
          <h1 className="text-2xl sm:text-3xl font-bold font-mono tracking-widest text-gradient uppercase">
            Loki
          </h1>
          <p className="mt-1 text-xs sm:text-sm font-mono text-gray-500 tracking-wider">
            <span className="text-green-500">$</span> stress-test paneli --auth
            <span className="inline-block w-2 h-4 ml-1 align-middle bg-green-500 animate-caret-blink"></span>
          </p>
        </div>

        {/* Form kartı */}
        <div className="glass-panel rounded-2xl p-6 sm:p-8 neon-border relative overflow-hidden">
          <div className="scan-sweep"></div>

          {error && (
            <div
              role="alert"
              className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm font-mono animate-toast-fade-in flex items-start gap-2"
            >
              <span className="text-red-500 font-bold shrink-0">[ERR]</span>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-username" className="block text-xs font-medium font-mono text-gray-400 mb-2 uppercase tracking-wider">
                <span className="text-green-500">&gt;</span> Kullanıcı Adı
              </label>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-black/60 border border-white/10 rounded-lg px-4 py-3 font-mono text-white placeholder-gray-600 transition-all duration-300 focus:border-green-400/60 focus:outline-none focus:shadow-[0_0_18px_rgba(0,255,65,0.2)] focus:bg-black/80 hover:border-white/20"
                placeholder="Yavrukurt"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium font-mono text-gray-400 mb-2 uppercase tracking-wider">
                <span className="text-green-500">&gt;</span> Şifre
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-black/60 border border-white/10 rounded-lg px-4 py-3 font-mono text-white placeholder-gray-600 transition-all duration-300 focus:border-green-400/60 focus:outline-none focus:shadow-[0_0_18px_rgba(0,255,65,0.2)] focus:bg-black/80 hover:border-white/20"
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-black font-bold font-mono py-3 rounded-lg tracking-wider uppercase transition-all duration-300 hover:shadow-[0_0_25px_rgba(0,255,65,0.35)] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0 flex items-center justify-center gap-2"
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
                <span>Giriş Yap</span>
              )}
            </button>
          </form>
        </div>

        {/* Alt bilgi */}
        <p className="mt-6 text-center text-[11px] font-mono text-gray-600 tracking-wider select-none">
          yetkisiz erişim yasaktır // loki v1.0
        </p>
      </div>
    </div>
  );
};

export default Login;
