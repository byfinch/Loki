// API anahtarı
const apiKey = '77cda2c82272';

/**
 * Yük testini başlatır
 * @param {Object} params - Test parametreleri
 * @param {string} params.targetIp - Hedef IP adresi
 * @param {number} params.port - Port numarası
 * @param {number} params.duration - Süre (saniye)
 * @param {string} params.method - HTTP metodu (GET, POST, vb.)
 * @returns {Promise<string>} Saldırı ID'si
 */
const startLoadTest = async (params) => {
  try {
    const response = await fetch('https://stress.st/api/v1/load-test/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        target_ip: params.targetIp,
        port: params.port,
        duration: params.duration,
        method: params.method
      })
    });

    if (!response.ok) {
      throw new Error(`API isteği başarısız: ${response.status}`);
    }

    const data = await response.json();
    return data.id;
  } catch (error) {
    console.error('Hata:', error);
    throw error;
  }
};

/**
 * Saldırıyı durdurur
 * @param {string} id - Saldırı ID'si
 * @returns {Promise<void>}
 */
const stopLoadTest = async (id) => {
  try {
    const response = await fetch(`https://stress.st/api/v1/load-test/stop?id=${id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Saldırı durdurma isteği başarısız: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Hata:', error);
    throw error;
  }
};

module.exports = {
  startLoadTest,
  stopLoadTest
};