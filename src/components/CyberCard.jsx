import React from 'react';
import useTilt from '../hooks/useTilt';

/**
 * Panel kartlari icin ortak cyber temali kapsayici.
 * - .cyber-card: akan neon gradient border + kose bracket'lari + hover glow (index.css)
 * - .cyber-card-sheen: mouse'u takip eden isik yansimasi (--mx/--my, useTilt yazar)
 * - .scan-sweep: hover'da beliren ince tarama cizgisi (login ile ayni efekt)
 * - useTilt: hover'da hafif 3D tilt
 *
 * Not: glass-panel'deki backdrop-filter, transform-style: preserve-3d'yi duzler;
 * bu yuzden katman derinligi preserve-3d yerine tilt + sheen + golge ile simule edilir.
 */
const CyberCard = ({ className = '', children, ...rest }) => {
  const tiltRef = useTilt();

  return (
    <div ref={tiltRef} className={`cyber-card glass-panel rounded-xl ${className}`} {...rest}>
      <div className="cyber-card-sheen" aria-hidden="true" />
      <span className="scan-sweep" aria-hidden="true" />
      {children}
    </div>
  );
};

export default CyberCard;
