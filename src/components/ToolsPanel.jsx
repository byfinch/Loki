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

  const handleTargetChange = (value) => {
    setTarget(extractDomain(value));
  };

  const renderToolContent = () => {
    switch (activeTool) {
      case 'check-host': {
        const checkHostUrl = target
          ? `https://check-host.net/check-${checkType}?host=${encodeURIComponent(target)}`
          : '';
        return (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">
              Hedefi check-host.net üzerinden uluslararası nodelarla kontrol edin.
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={target}
                onChange={(e) => handleTargetChange(e.target.value)}
                placeholder="IP veya domain"
                className="flex-1 bg-black border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-white/30 focus:outline-none"
              />
              <div className="relative">
                <select
                  value={checkType}
                  onChange={(e) => setCheckType(e.target.value)}
                  className="bg-black border border-white/10 rounded-lg px-4 py-3 pr-10 text-white focus:border-white/30 focus:outline-none appearance-none"
                >
                  <option value="ping">Ping</option>
                  <option value="http">HTTP</option>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                  <option value="dns">DNS</option>
                </select>
                <svg
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            <a
              href={checkHostUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`block w-full text-center py-3 rounded-lg font-semibold transition ${
                target
                  ? 'bg-white hover:bg-gray-100 text-black'
                  : 'bg-white/20 text-gray-500 cursor-not-allowed pointer-events-none'
              }`}
            >
              Kontrol Et
            </a>
          </div>
        );
      }

      case 'ping-pe': {
        const pingPeUrl = target ? `https://ping.pe/${encodeURIComponent(target)}` : '';
        return (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">
              ping.pe üzerinden hedefin MTR ve rota analizini görüntüleyin.
            </p>
            <input
              type="text"
              value={target}
              onChange={(e) => handleTargetChange(e.target.value)}
              placeholder="IP veya domain"
              className="w-full bg-black border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-white/30 focus:outline-none"
            />
            <a
              href={pingPeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`block w-full text-center py-3 rounded-lg font-semibold transition ${
                target
                  ? 'bg-white hover:bg-gray-100 text-black'
                  : 'bg-white/20 text-gray-500 cursor-not-allowed pointer-events-none'
              }`}
            >
              Ping.pe'de Aç
            </a>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="glass-panel rounded-xl p-6 hover-glow transition-all duration-300">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
        Keşif ve Doğrulama Araçları
      </h2>

      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {[
          { id: 'check-host', label: 'Check-Host' },
          { id: 'ping-pe', label: 'Ping.pe' }
        ].map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all duration-300 ${
              activeTool === tool.id
                ? 'bg-cyan-500 text-black'
                : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {renderToolContent()}
    </div>
  );
};

export default ToolsPanel;
