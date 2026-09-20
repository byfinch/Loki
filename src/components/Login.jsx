import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import MatrixRain from './login/MatrixRain';

// Acilis boot satirlari: bir kez yazi-yazak belirir (opsiyon A'nin ruhu)
const BOOT_LINES = [
  '[NET]  stresse.st reachability ... OK',
  '[NET]  rackghost relay ......... OK',
  '[SEC]  sifreli kanal ........... HAZIR'
];

const Login = () => {
  const { setUser, addLog } = useStressTest();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bootIndex, setBootIndex] = useState(0);

  // Boot sekansi: satirlar arasi hafif gecikmeyle yazilir
  useEffect(() => {
    if (bootIndex >= BOOT_LINES.length) return undefined;
    const t = setTimeout(() => setBootIndex((i) => i + 1), 520);
    return () => clearTimeout(t);
  }, [bootIndex]);

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
      <style>{`
        @keyframes login-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
        @keyframes login-bracket { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
        @keyframes login-shine { from { transform: translateX(-120%) skewX(-18deg); } to { transform: translateX(240%) skewX(-18deg); } }
        .login-rise { animation: login-rise .6s ease-out both; }
        .login-rise-2 { animation: login-rise .6s ease-out .15s both; }
        .login-rise-3 { animation: login-rise .6s ease-out .3s both; }
        .login-bracket { animation: login-bracket 2.6s ease-in-out infinite; }
        .login-btn-shine { position: absolute; top: 0; bottom: 0; width: 40%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent); animation: login-shine 2.8s ease-in-out infinite; pointer-events: none; }
      `}</style>

      {/* Matrix rain arka plan efekti */}
      <MatrixRain />

      {/* Ambient glow lekeleri */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-green-500/5 rounded-full blur-3xl animate-float motion-reduce:animate-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl animate-float motion-reduce:animate-none" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Boot satirlari (kart uzerunde, bir kez yazar) */}
        <div className="font-mono text-[10px] leading-relaxed text-green-500/50 h-[54px] mb-3 select-none" aria-hidden="true">
          {BOOT_LINES.slice(0, bootIndex).map((l) => (
            <div key={l}>{l}</div>
          ))}
          {bootIndex < BOOT_LINES.length && <span className="inline-block w-1.5 h-3 bg-green-500/70 align-middle animate-caret-blink" />}
        </div>

        {/* Logo: glitch katmanli */}
        <div className="flex justify-center mb-5 sm:mb-6 login-rise select-none">
          <div className="relative h-20 w-20 sm:h-28 sm:w-28">
            <img
              src="/logo.png"
              alt="Loki Panel"
              width="112"
              height="112"
              loading="eager"
              className="h-20 w-20 sm:h-28 sm:w-28 drop-shadow-[0_0_25px_rgba(0,255,65,0.35)] relative z-10"
            />
            <img src="/logo.png" alt="" aria-hidden="true" className="absolute top-0 left-0 h-20 w-20 sm:h-28 sm:w-28 opacity-0 switch-glitch-1" />
            <img src="/logo.png" alt="" aria-hidden="true" className="absolute top-0 left-0 h-20 w-20 sm:h-28 sm:w-28 opacity-0 switch-glitch-2" />
          </div>
        </div>

        {/* Baslik */}
        <div className="text-center mb-6 select-none login-rise-2">
          <h1 className="text-2xl sm:text-3xl font-bold font-mono tracking-[0.35em] text-gradient uppercase">
            Loki
          </h1>
          <p className="mt-1 text-xs sm:text-sm font-mono text-gray-500 tracking-wider">
            <span className="text-green-500">$</span> stress-test paneli --auth
            <span className="inline-block w-2 h-4 ml-1 align-middle bg-green-500 animate-caret-blink"></span>
          </p>
        </div>

        {/* Form karti: HUD kose braketleri + giris animasyonu */}
        <div className="login-rise-3">
          <div className="relative p-[1px]">
            {/* Kose braketleri (opsiyon C'nin cercevesi) */}
            <span aria-hidden="true" className="login-bracket absolute -top-[2px] -left-[2px] w-5 h-5 border-t-2 border-l-2 border-green-400/80 z-20 pointer-events-none" />
            <span aria-hidden="true" className="login-bracket absolute -top-[2px] -right-[2px] w-5 h-5 border-t-2 border-r-2 border-green-400/80 z-20 pointer-events-none" style={{ animationDelay: '.4s' }} />
            <span aria-hidden="true" className="login-bracket absolute -bottom-[2px] -left-[2px] w-5 h-5 border-b-2 border-l-2 border-green-400/80 z-20 pointer-events-none" style={{ animationDelay: '.8s' }} />
            <span aria-hidden="true" className="login-bracket absolute -bottom-[2px] -right-[2px] w-5 h-5 border-b-2 border-r-2 border-green-400/80 z-20 pointer-events-none" style={{ animationDelay: '1.2s' }} />

            <div className="glass-panel rounded-2xl p-5 sm:p-8 neon-border relative overflow-hidden">
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
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[11px] font-mono text-green-500/40 pointer-events-none select-none">root@loki:~$</span>
                    <input
                      id="login-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full min-h-[46px] bg-black/60 border border-white/10 rounded-lg pl-[118px] pr-4 py-3 text-base font-mono text-white placeholder-gray-600 transition-all duration-300 focus:border-green-400/60 focus:outline-none focus:shadow-[0_0_18px_rgba(0,255,65,0.2)] focus:bg-black/80 hover:border-white/20"
                      placeholder="Yavrukurt"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-xs font-medium font-mono text-gray-400 mb-2 uppercase tracking-wider">
                    <span className="text-green-500">&gt;</span> Şifre
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[11px] font-mono text-green-500/40 pointer-events-none select-none">password&nbsp;:</span>
                    <input
                      id="login-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full min-h-[46px] bg-black/60 border border-white/10 rounded-lg pl-[110px] pr-4 py-3 text-base font-mono text-white placeholder-gray-600 transition-all duration-300 focus:border-green-400/60 focus:outline-none focus:shadow-[0_0_18px_rgba(0,255,65,0.2)] focus:bg-black/80 hover:border-white/20"
                      placeholder="••••••••"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="relative overflow-hidden w-full min-h-[48px] bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-black font-bold font-mono py-3 rounded-lg tracking-wider uppercase transition-all duration-300 hover:shadow-[0_0_25px_rgba(0,255,65,0.35)] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0 flex items-center justify-center gap-2"
                >
                  {!loading && <span className="login-btn-shine" aria-hidden="true" />}
                  {loading ? (
                    <>
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Doğrulanıyor...</span>
                    </>
                  ) : (
                    <span>Giriş Yap ▸</span>
                  )}
                </button>
              </form>

              {/* Alt durum satiri: saglayici durumlari (opsiyon C'nin ayak izi) */}
              <div className="mt-5 pt-4 border-t border-green-500/10 flex items-center justify-between font-mono text-[9px] tracking-widest text-green-500/40 select-none" aria-hidden="true">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  STRESSE.ST
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" style={{ animationDelay: '.5s' }} />
                  RACKGHOST
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500/80 animate-pulse" style={{ animationDelay: '1s' }} />
                  UPLINK
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Alt not */}
        <p className="mt-4 text-center font-mono text-[9px] tracking-widest text-gray-600 select-none">
          // yetkili erişim · tüm işlemler kayıt altında
        </p>
      </div>
    </div>
  );
};

export default Login;
