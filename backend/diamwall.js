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
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--lang=en-US,en'
    ]
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Duvar dogrulamasi bitene kadar bekle. Basari isareti: _dwa cookie'sinin
    // 1'e donmesi (duvar 5s.html iframe'i icinde dogrulamayi bitirince mesajla
    // title'i gunceller; title basarida da "DiamWall" icerir, o yuzden title'a
    // guvenilmez).
    const deadline = Date.now() + timeoutMs;
    let cleared = false;
    while (Date.now() < deadline) {
      const cookies = await page.cookies(TARGET).catch(() => []);
      const dwa = cookies.find((c) => c.name === '_dwa');
      if (dwa && dwa.value !== '0') {
        cleared = true;
        break;
      }
      // Yedek tespit: dogrulama iframe'i kaybolduysa ve baslik degistiysa.
      const state = await page.evaluate(() => ({
        title: document.title || '',
        hasIframe: !!document.querySelector('iframe#verification')
      })).catch(() => ({ title: '', hasIframe: true }));
      if (!state.hasIframe && state.title && !state.title.startsWith('Verifying')) {
        cleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
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
        // Dogrulama iframe'inin icerigi ne diyor (cogu zaman asil ipucu oradadir).
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            state.frameUrl = frame.url();
            state.frameBody = (await frame.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 500);
            state.frameHtml = (await frame.evaluate(() => document.documentElement.outerHTML)).slice(0, 1200);
          } catch {}
        }
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
