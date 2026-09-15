# AGENTS.md — Loki Panel

Bu dosya, projeyi inceleyen/gelistiren yapay zeka ajanlari icin teknik rehberdir.

## Sistem Nedir

Loki, ticari yuk/stres testi saglayicilarinin (stresse.st ve RackGhost) yonetim
konsoludur. Operasyon ekibi bu panelden test isleri (saldiri/loop) baslatir,
canli izler, gruplar ve raporlar. Ekip ortak kullanir; tum ozellikler cok
kullanicili ortak panel mantigiyla tasarlanmistir.

- **Backend:** Node.js + Express (`backend/`), pm2 ile `loki-backend` servisi (127.0.0.1:3001)
- **Frontend:** React + Vite (`src/`), `dist/` ciktisi LiteSpeed uzerinden sunulur
- **Kalici veri:** `backend/data/*.json` (dbms yok; json dosya + atomic rename kalibi)

## Modul Haritasi

| Dosya | Gorev |
|---|---|
| `backend/server.js` | Ana sunucu: saglayici proxy'leri, loop motoru, SSE canli akis, gruplar, oturumlar |
| `backend/rackghost.js` | RackGhost adapteri — yerel oturum servisine (127.0.0.1:3210) baglanir |
| `backend/rg_service.py` | RackGhost oturum servisi (CapSolver->login->stresser_api zinciri; systemd: rackghost-session) |
| `backend/watch.js` | Link Gozcusu: keyword->link izleme, telegram butonlu bildirim |
| `backend/sitewatch.js` | Uptime izleme (SiteWatcher), headless Chrome kanit gorseli, telegram |
| `backend/invader.js` | Site cloak/durum kontrolu (curl-impersonate + Chrome kart gorseli) |
| `backend/impact.js` | Etki Monitoru: hedefleri check-host.net ile olcer |
| `backend/telegram.js` | Panel bildirim botu modulu |

Frontend bilesenleri `src/components/` altinda modul basina bir dosya
(AttackForm, LoopManager, LiveAttacks, LinkWatcher, InvaderPanel, SiteWatcher,
ImpactMonitor, PhishPanel, Dashboard). API erisimi tek noktadan:
`src/services/apiClient.js`.

## Saglayici Mimarisi (kritik)

Iki saglayici vardir; `provider` alaniyla ayristirilir ('stresse' | 'rackghost'):

- **stresse.st:** Web + API erisimi. IP whitelist zorunlu (sunucu IP'leri
  135.181.60.116 ve .97). Anti-bot PoW challenge'i backend cozer
  (server.js icinde `solveStresseChallenge`).
- **RackGhost:** Public API yok; `rg_service.py` CapSolver ile Cloudflare'i
  cozup `panel/stresser_api.php`'ye vekalet eder. Rate limit: 1 istek/sn
  (hem backend throttle hem servis ici bosluklarla korunur).
- Bazi RackGhost methodlari girilen concurrents'in kati slot tuketir
  (HTTPSMIX, HTTPSCUSTOM = 2x). Limit tuketim uzerinden (girilen x carpan <= 15)
  dogrulanir; gosterim de tuketimi yansitir.

## Loop Motoru (server.js)

- Loop'lar `active-loops.json`'da; restart'ta geri yuklenir (rackghost
  methodlari BUYUK harf tasar — "eski format" filtresi buna istisna icerir).
- Hata toleransi: 30 ardisik hata + ustel backoff (30sn x hata, max 3dk).
- stresse turleri arasinda onceki tur /ongoing'den dogrulanir; rackghost'ta
  statik 3sn buffer (saldiri suresi bitince kesin duser).
- Taze saldirilar canli akisa backend kayit defterinden ANINDA duser
  (upstream gecikmesi beklenmez); upstream yakalayinca ayni satir devam eder.

## Guvenlik ve Gizli Veriler

- Endpoint'ler `sessionId` header'i ister; SSE `?sid=` query ile alir.
- Gizli degerler (bot tokenlari, hesap sifreleri, proxy kimlikleri) **repoda
  degil**, sunucudaki `ecosystem.config.cjs` ve `backend/data/*.json` icinde.
  Inceleme sirasinda bunlarin icerigi rapora KOPYALANMAMALI.
- `backend/data/*.json` canli uretim verisidir; salt-okunur muamele edilmeli.

## Inceleme Kurallari (review yapan ajan icin)

1. **Salt-okunur calis:** kod degisikligi yapma, git mutasyonu yapma
   (commit/push/reset), servisleri (pm2/systemd) durdurma/yeniden baslatma.
2. Gizli deger iceren dosyalarin icerigini rapora tasima; varligini not et yeter.
3. Varsayim uydurma; emin olamadigin noktayi "dogrulanamadi" diye isaretle.
4. Bulgu raporu formati: dosya:satir — sorun — siddet (kritik/orta/dusuk) —
   neden onemli — onerilen duzeltme (taslak).

## Build / Deploy

```
npm run build            # frontend dist/
git push origin main     # sunucuda: cd /opt/Loki && git pull && npm run build && pm2 restart loki-backend
```

Backend degisikligi: `pm2 restart loki-backend`. ecosystem degisikligi:
`pm2 delete loki-backend && pm2 start ecosystem.config.cjs && pm2 save`.
Yan servisler: `systemctl restart rackghost-session` (rackghost oturumu),
`phishguard-xvfb` (goruntu birimi, DISPLAY=:99).

## Kod Stili

- Yorumlar Turkce, teknik terimler Ingilizce. Girinti 2 bosluk.
- Kalici yazma: tmp dosya + rename (atomic).
- Telegram mesajlari Turkce, kisa, HTML parse mode.
- Yeni modul: `backend/<modul>.js` + `init<Modul>()` cagrisi server.js sonunda +
  panelde `src/components/<Modul>.jsx` + Dashboard tab'i.
