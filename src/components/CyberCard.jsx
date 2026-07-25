import React from 'react';

/**
 * Panel kartlari icin ortak cyber temali kapsayici (sade versiyon).
 * - .cyber-card: cok yavas akan ince neon border + yumusak golge;
 *   hover'da sadece border/glow hafifce guclenir (index.css)
 * - .scan-sweep: hover'da beliren cok silik tarama cizgisi (login ile ayni efekt)
 */
const CyberCard = ({ className = '', children, ...rest }) => {
  return (
    <div className={`cyber-card glass-panel rounded-xl ${className}`} {...rest}>
      <span className="scan-sweep" aria-hidden="true" />
      {children}
    </div>
  );
};

export default CyberCard;
