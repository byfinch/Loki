/**
 * DiamWall challenge cozucu.
 *
 * stresse.st bazi IP/istemcilerde DiamWall anti-bot duvari koyuyor:
 * ilk istek 307/51x ile JS dogrulama sayfasina dusuyor, duvar ancak gercek
 * bir tarayici JS'i calistirdiktan sonra clearance cookie'si veriyor.
 * Node/axios bu JS'i calistiramadigi icin headless Chrome ile cozuyoruz.
 *
 * solveChallenge() -> stresse.st cookie'lerini dondurur; bunlar session
 * CookieJar'ina enjekte edilir, sonraki axios istekleri duvari gecer.
 */

let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch {
  // puppeteer kurulu degilse cozucu devre disi kalir; cagiran taraf
  // solveChallenge cagrisinda acik bir hata alir.
}

const TARGET = 'https://stresse.st';

function isAvailable() {
  return !!puppeteer;
}

function looksLikeChallenge(status, body) {
  if (status === 511 || status === 513 || status === 517) return true;
  if (typeof body === 'string' && body.includes('diamwall')) return true;
  return false;
}

/**
 * Headless Chrome ile stresse.st'in DiamWall dogrulamasini cozer.
 * @returns {Promise<Array<{name,value,domain,path}>>} stresse.st cookie'leri
 */
async function solveChallenge(timeoutMs = 45000) {
  if (!puppeteer) {
    throw new Error('puppeteer kurulu degil (backend dizininde: npm install puppeteer)');
  }
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Duvar dogrulamasi bitene kadar bekle: baslik DiamWall olmaktan cikar,
    // dogrulama iframe'i kaybolur.
    const deadline = Date.now() + timeoutMs;
    let cleared = false;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        title: document.title || '',
        hasIframe: !!document.querySelector('iframe#verification')
      })).catch(() => ({ title: '', hasIframe: true }));
      if (!state.title.includes('DiamWall') && !state.hasIframe) {
        cleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
      // Bazi challenge'lar sayfayi yeniden yukler; body bos kaldiysa reload dene.
      if (!cleared && !state.hasIframe && state.title === '') {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    if (!cleared) {
      // Teshis: Chrome'un gordugu sayfayi kaydet (baslik + body + ekran goruntusu).
      try {
        const state = await page.evaluate(() => ({
          title: document.title || '',
          url: location.href,
          body: (document.body ? document.body.innerText : '').slice(0, 500),
          html: document.documentElement.outerHTML.slice(0, 1500)
        }));
        const shot = '/root/diamwall-fail.png';
        await page.screenshot({ path: shot }).catch(() => {});
        console.error('[diamwall] Cozulemedi. Sayfa durumu:', JSON.stringify(state, null, 2));
        console.error('[diamwall] Ekran goruntusu:', shot);
      } catch {}
      throw new Error('DiamWall dogrulamasi zaman asimina ugradi');
    }

    const cookies = await page.cookies(TARGET);
    if (!cookies || cookies.length === 0) {
      throw new Error('DiamWall cozuldu ama cookie alinamadi');
    }
    return cookies;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { isAvailable, looksLikeChallenge, solveChallenge };
