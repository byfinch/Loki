// RRT teshis scripti: worker'in yaptigi Chrome lansmanini birebir dener.
// Kullanim: DISPLAY=:99 node backend/scripts/rrt-diag.js
const puppeteer = require('puppeteer-core');

(async () => {
  console.log('[diag] DISPLAY =', process.env.DISPLAY || '(bos)');
  try {
    const b = await puppeteer.launch({
      executablePath: 'google-chrome',
      headless: false,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    console.log('[diag] OK: Chrome launched, version:', await b.version());
    const page = await b.newPage();
    await page.goto('https://example.com/', { timeout: 20000 });
    console.log('[diag] OK: page.goto calisti, title =', await page.title());
    await b.close();
    console.log('[diag] TAMAM: worker bu ortamda calisabilir.');
  } catch (e) {
    console.error('[diag] FAIL:', e.message);
    process.exitCode = 1;
  }
})();
