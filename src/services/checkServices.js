/**
 * checkServices.js
 * 
 * Bu modül, Check-Host, Ping.pe ve FOFA servislerini kullanarak hedefin durumunu kontrol eder.
 * 
 * Kullanım:
 * const result = await checkHost('8.8.8.8');
 */

// FOFA API Ayarları (Bunları kendi bilgilerinle doldurmalısın)
const FOFA_EMAIL = 'senin_email@example.com';
const FOFA_KEY = 'senin_api_key';

/**
 * Check-Host Servisi: Hedefin ping durumunu kontrol eder.
 * @param {string} target - Hedef IP veya Domain
 */
async function checkHost(target) {
    try {
        // Check-Host ping endpoint'i
        const url = `https://check-host.net/check-ping?host=${target}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Check-Host Hatası: ${response.status}`);
        }

        const data = await response.json();
        return {
            service: 'Check-Host',
            target: target,
            status: 'checked',
            data: data
        };

    } catch (error) {
        console.error('Check-Host hatası:', error);
        throw error;
    }
}

/**
 * Ping.pe Servisi: Hedefin genel erişilebilirlik durumunu kontrol eder.
 * @param {string} target - Hedef IP veya Domain
 */
async function checkPing(target) {
    try {
        // Ping.pe genellikle HTML döndürür, ancak endpoint'e istek atarız
        const url = `https://ping.pe/${target}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0' // Bazı siteler botları engeller, User-Agent ekleyebiliriz
            }
        });

        if (!response.ok) {
            throw new Error(`Ping.pe Hatası: ${response.status}`);
        }

        // Ping.pe genellikle HTML döndürür, bu yüzden basit bir obje döndürüyoruz
        const html = await response.text();
        return {
            service: 'Ping.pe',
            target: target,
            status: 'checked',
            html: html
        };

    } catch (error) {
        console.error('Ping.pe hatası:', error);
        throw error;
    }
}

/**
 * FOFA Servisi: FOFA API kullanarak hedef hakkında veri arar.
 * @param {string} target - Hedef IP veya Domain
 */
async function checkFofa(target) {
    try {
        const query = `domain="${target}"`; // FOFA sorgu dilini buraya yazıyoruz
        const encodedQuery = encodeURIComponent(query);
        
        // FOFA API Endpoint'i
        const url = `https://fofa.info/api/v1/search/all?email=${FOFA_EMAIL}&key=${FOFA_KEY}&qbase64=${encodedQuery}&size=10`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            // FOFA genellikle hata JSON'ı döndürür
            const errorData = await response.json();
            throw new Error(`FOFA Hatası: ${errorData.errmsg || response.status}`);
        }

        const data = await response.json();
        
        return {
            service: 'FOFA',
            target: target,
            status: 'checked',
            resultCount: data.size,
            results: data.results
        };

    } catch (error) {
        console.error('FOFA hatası:', error);
        throw error;
    }
}

// Modülü export et
module.exports = {
    checkHost,
    checkPing,
    checkFofa
};