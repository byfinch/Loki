---
name: loki-dev
description: Loki panel projesinde ozellik gelistirme, hata duzeltme ve degisiklik uygulama is akisi — kullanicinin istegini proje kurallarina uygun sekilde uctan uca uygular (AGENTS.md bagli)
type: prompt
whenToUse: Kullanici Loki projesinde bir ozellik eklenmesini, degisiklik, duzeltme, entegrasyon veya gelistirme istediginde
arguments:
  - istek
---

Loki projesinde kullanicinin istegini uygulayacaksin: $istek

Once repo kokundeki `AGENTS.md`'yi oku; modul haritasi, saglayici mimarisi,
build/deploy kalibi ve kod stili orada tanimli. Onlara BIREBIR uy.

CALISMA AKISI:

1. ANLA: Istegi tek cumleyle ozetle. Belirsiz nokta varsa once netlestirici
   soru sor; netlesmeden kod yazma.
2. YERLES: Degisecek dosyalari bul (modul haritasini kullan). Ilgisiz
   dosyalara dokunma; kapsami minimumda tut.
3. TASARLA: En kucuk dogru degisikligi sec. Yeni modul gerekiyorsa kalip:
   `backend/<modul>.js` + server.js sonunda `init<Modul>()` +
   `src/components/<Modul>.jsx` + Dashboard tab'i + apiClient metodlari.
4. UYGULA — su kurallarla:
   - Kod stili: Turkce yorum, teknik terim Ingilizce, 2 bosluk girinti.
   - Kalici yazma hep tmp+rename (atomic).
   - Backend endpoint'leri sessionId ister (SSE'de `?sid=`).
   - Saglayici kurallari: rackghost 1 istek/sn disiplini korunur; 2x slot
     methodlarinda limit/gosterim tuketim uzerinden; stresse icin anti-abuse
     dostu (gereksiz poll ekleme, backoff koru).
   - Telegram mesajlari Turkce, kisa; foto gonderimde dosya adi+content-type.
   - Canli veri dosyalarina (backend/data/*.json) ELLE dokunma; kod yoluyla.
5. DOGRULA: `node --check` (backend) + `npm run build` (frontend) hatasiz
   gecmeli. Mumkunse canli test et (ilgili endpoint'e gercek istek).
6. TESLIM: Yapilanlari kisa liste halinde ozetle (dosya -> ne degisti).
   Deploy gerekliyse kalibi AGENTS.md'den uygula veya kullaniciya bildir.

SINIRLAR (sistemi korumak icin):
- Git mutasyonu (commit/push/reset) ancak kullanici acikca isterse.
- Gizli degerleri (token/sifre/proxy kimligi) degistirme, rapora tasima.
- Mevcut calisan davranisi bozma: loop motoru, canli akis, telegram
  bildirimleri ve saglayici entegrasyonlari calisir durumda kalmali.
- Buyuk mimari degisiklik onerisi gerekiyorsa once plani sun, onay al.
