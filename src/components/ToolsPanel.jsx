import React, { useState } from 'react';

const ToolsPanel = () => {
  const [activeTool, setActiveTool] = useState('check-host');
  const [target, setTarget] = useState('');
  const [checkType, setCheckType] = useState('http');

  const extractDomain = (value) => {
    try {
      const trimmed = value.trim();
      if (!trimmed) return '';
      // Eger IP adresi ise portu temizle
      const ipMatch = trimmed.match(/^(?:https?:\/\/)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/.*)?$/);
      if (ipMatch) return ipMatch[1];
      // URL ise hostname'i al
      const url = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
      const hostname = new URL(url).hostname;
      return hostname;
    } catch {
      return value.trim();
    }
  };

  // Donusum sadece link olusturulurken uygulanir; yazarken input'a dokunulmaz
  const extractedTarget = extractDomain(target);
  const targetUrl = activeTool === 'check-host'
    ? (extractedTarget ? `https://check-host.net/check-${checkType}?host=${encodeURIComponent(extractedTarget)}` : '')
    : (extractedTarget ? `https://ping.pe/${encodeURIComponent(extractedTarget)}` : '');

  return (
    <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
      {/* CRT scanline dokusu */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }}
      />

      {/* Title bar */}
      <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        <span className="text-green-300/90">root@loki:~/araclar</span>
        <span className="text-green-500/60">$ ./tools</span>
        <span className="animate-pulse">▊</span>
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        {/* Arac sekmeleri */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="inline-flex overflow-hidden rounded-sm border border-green-500/30">
            {[
              { id: 'check-host', label: 'check-host' },
              { id: 'ping-pe', label: 'ping.pe' }
            ].map((tool) => (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                className={`px-4 py-1.5 text-[11px] font-bold transition-all ${
                  activeTool === tool.id
                    ? 'bg-green-500/15 text-green-400 [text-shadow:0_0_8px_rgba(0,255,65,0.6)]'
                    : 'text-green-500/50 hover:text-green-400'
                }`}
              >
                [{tool.label}]
              </button>
            ))}
          </div>
          <span className="text-[9px] text-gray-600">
            # {activeTool === 'check-host' ? 'uluslararası nodelarla kontrol' : 'MTR ve rota analizi'}
          </span>
        </div>

        <div className={`grid gap-3 ${activeTool === 'check-host' ? 'grid-cols-[1fr_130px]' : 'grid-cols-1'}`}>
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; hedef</label>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="IP veya domain"
              className="w-full rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 placeholder-green-500/30 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
            />
          </div>
          {activeTool === 'check-host' && (
            <div>
              <label className="mb-1 block text-[10px] tracking-wider text-green-500/55">&gt; tip</label>
              <select
                value={checkType}
                onChange={(e) => setCheckType(e.target.value)}
                className="w-full appearance-none rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
              >
                <option value="http">HTTP</option>
                <option value="ping">Ping</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="dns">DNS</option>
              </select>
            </div>
          )}
        </div>

        {/* Dis baglanti: check-host.net / ping.pe yeni sekmede acilir */}
        <a
          href={targetUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-4 block w-full rounded-sm border py-3 text-center text-[12px] font-bold tracking-widest transition-all duration-300 ${
            extractedTarget
              ? 'border-green-500/50 bg-green-500/[0.14] text-green-400 [text-shadow:0_0_10px_rgba(0,255,65,0.5)] hover:bg-green-500/[0.22] hover:shadow-[0_0_20px_rgba(0,255,65,0.25)]'
              : 'cursor-not-allowed border-white/10 bg-white/[0.03] text-gray-600'
          }`}
        >
          <span className="mb-0.5 block text-[9px] font-normal tracking-normal text-green-500/60">
            $ ./{activeTool === 'check-host' ? 'check' : 'ping-pe'} --open
          </span>
          {activeTool === 'check-host' ? 'KONTROL ET' : "PING.PE'DE AÇ"}
        </a>
      </div>
    </div>
  );
};

export default ToolsPanel;
