/**
 * DiamWall cozucu bagimsiz testi.
 * Kullanim (sunucuda): node backend/test-diamwall.js
 *
 * 1) Headless Chrome ile challenge'i cozer, cookie'leri alir.
 * 2) Ayni cookie'lerle axios (Node TLS) istegi dener.
 * Sonuca gore backend entegrasyonunun hangi yoldan gidecegi belli olur.
 */
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { solveChallenge } = require('./diamwall');

(async () => {
  console.log('[1/2] DiamWall challenge cozuluyor (headless Chrome)...');
  const cookies = await solveChallenge();
  console.log('    Cookie alindi:', cookies.map((c) => c.name).join(', '));

  const jar = new CookieJar();
  for (const c of cookies) {
    await jar.setCookie(`${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path || '/'}`, 'https://stresse.st');
  }

  console.log('[2/2] Cookie ile axios GET /login deneniyor...');
  const client = wrapper(axios.create({
    baseURL: 'https://stresse.st',
    jar,
    withCredentials: true,
    family: 4,
    maxRedirects: 5,
    timeout: 15000,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }));

  const loginRes = await client.get('/login');
  console.log('    GET /login ->', loginRes.status);
  const apiRes = await client.get('/api?key=gecersiztest');
  console.log('    GET /api (gecersiz key) ->', apiRes.status,
    typeof apiRes.data === 'string' ? apiRes.data.slice(0, 120) : JSON.stringify(apiRes.data).slice(0, 200));

  if (loginRes.status === 200) {
    console.log('SONUC: axios + cookie duvari geciyor. Backend entegrasyonu bu yoldan yapilacak.');
  } else {
    console.log('SONUC: axios cookie ile de gecmedi. Chrome uzerinden istek atan yaklasim gerekli.');
  }
  process.exit(0);
})().catch((err) => {
  console.error('TEST HATASI:', err.message);
  process.exit(1);
});
