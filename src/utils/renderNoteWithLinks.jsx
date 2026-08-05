import React from 'react';

// Not metnindeki http(s) linklerini tiklanabilir <a> olarak render eder.
// Metnin geri kalani React tarafindan escape'lenir; sadece protokollu
// URL'ler linklesir (XSS riski yok).
export const renderNoteWithLinks = (text) => {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//i.test(part)) {
      // Sondaki noktalama isaretleri linkin parcasi olmasin
      const trail = part.match(/[.,;!?)>\]]+$/)?.[0] || '';
      const href = part.slice(0, part.length - trail.length);
      return (
        <React.Fragment key={i}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-green-400 border-b border-dotted border-green-500/50 hover:text-green-300 transition"
          >
            {href.replace(/^https?:\/\//i, '')}
          </a>
          {trail}
        </React.Fragment>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
};
