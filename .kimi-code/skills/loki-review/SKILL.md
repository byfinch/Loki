---
name: loki-review
description: Loki panel projesini (Node backend + React frontend, stresse.st/RackGhost saglayicili stres-test konsolu) denetler ve yapilandirilmis bulgu raporu uretir
type: prompt
whenToUse: Kullanici Loki projesinin incelenmesini, denetlenmesini, saglik kontrolu veya hata/risk raporu istediginde
arguments:
  - odak
---

Loki projesini denetleyeceksin. Once repo kokundeki `AGENTS.md` dosyasini oku —
sistem haritasi, saglayici mimarisi ve inceleme kurallari orada; onlara BIREBIR uy.

Kesin kurallar:
- SALT-OKUNUR calis. Kod degisikligi, git mutasyonu (commit/push/reset/rebase),
  servis durdurma/baslatma (pm2/systemd) YAPMA.
- Gizli deger iceren dosyalarin (ecosystem.config.cjs, backend/data/*.json)
  ICERIGINI rapora kopyalama; varliklarini not etmek yeterli.
- Varsayim uydurma; emin olamadigin noktayi "dogrulanamadi" diye isaretle.

Calisma akisi:
1. `AGENTS.md`'yi oku, modul haritasini cikar.
2. Asagidaki odaklari sirayla incele (kullanici odak belirttiyse onceliklendir: $odak):
   - Loop motoru (backend/server.js): tur zamanlamasi, 30 ardisik hata + ustel
     backoff, persistence geri yukleme (rackghost buyuk-harf istisnasi),
     iki saglayici dispatch, statik buffer (rackghost) vs ongoing dogrulama (stresse).
   - Canli akis (SSE): kayit defteri birlesimi (taze saldirilar aninda),
     upstream gecikmesi, hesap bazli izolasyon, rackghost satir koruma (titreme),
     hedef normalize (slash varyantlari).
   - Saglayici disiplini: stresse anti-abuse (PoW cozucu, whitelist, backoff),
     rackghost rate limit (backend throttle + servis ici bosluklar), 2x slot
     carpani dogrulama ve gosterimi, hiz sinirinda otomatik yeniden deneme.
   - Telegram akislari: sessiz tur (watch boot-scan), Tam Sonuc buton callback'i,
     sendPhoto (dosya adi/content-type sarti), DM alarm yollari.
   - Guvenlik: sessionId kontrolu olan/olmayan endpoint'ler, sessionId sizintisi,
     giris dogrulama, hata mesajlarinda bilgi sizintisi.
   - Kod kalitesi: yarismalar, bellek sizintisi, zamanlayici temizligi,
     hata yutma (sessiz catch'ler), tutarsizliklar.
3. Her bulguyu su formatta raporla:
   `dosya:satir — sorun — siddet (kritik/orta/dusuk) — neden onemli — onerilen duzeltme (taslak)`
4. Sonuca genel degerlendirme ekle: sistem geneli saglik notu (1-10) ve
   oncelikli 3 aksiyon. Sorun bulamazsan bunu acikca belirt; uydurma bulgu yazma.
