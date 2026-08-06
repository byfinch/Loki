// RRT teshis scripti: worker'in yaptigi Chrome lansmanini birebir dener.
// Kullanim: DISPLAY=:99 node backend/scripts/rrt-diag.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

function resolveChrome() {
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try {
    return execSync('which google-chrome || which chromium', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch { return 'google-chrome'; }
}

(async () => {
  console.log('[diag] DISPLAY =', process.env.DISPLAY || '(bos)');
  const exe = resolveChrome();
  console.log('[diag] chrome path =', exe);
  try {
    const b = await puppeteer.launch({
      executablePath: exe,
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
