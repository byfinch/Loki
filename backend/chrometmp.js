/**
 * chrometmp.js — Chrome'un /tmp'ye sizdirdigi gecici spool dosyalarini
 * (.com.google.Chrome.* ve com.google.Chrome.chrome_url_fetcher_.*)
 * izole etmek icin TMPDIR saglar. Ortak /tmp'ye yazdiklarinda 51 gunde
 * 25bin+ dosya / 3.3GB birikti (/tmp %99 doldu).
 *
 * Kullanim: execFile(CHROME, [...], { env: chromeEnv() })
 * chromeEnv() her cagrida dizini garanti eder ve 5dk'dan eski kalintilari
 * budar (in-flight dosyalara dokunmaz; Chrome koşulari <=60sn surer).
 */
const fs = require('fs');
const path = require('path');

const CHROME_TMP = path.join(__dirname, 'data', 'chrome-tmp');
const PRUNE_AGE_MS = 5 * 60 * 1000;

function chromeEnv() {
  try { fs.mkdirSync(CHROME_TMP, { recursive: true }); } catch { /* yoksay */ }
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CHROME_TMP)) {
      const p = path.join(CHROME_TMP, f);
      try {
        if (now - fs.statSync(p).mtimeMs > PRUNE_AGE_MS) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch { /* tek dosya hatasi butunu bozmasin */ }
    }
  } catch { /* dizin okunamadiysa yoksay */ }
  return { ...process.env, TMPDIR: CHROME_TMP };
}

module.exports = { chromeEnv, CHROME_TMP };
