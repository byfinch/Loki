# RRT toplu fizibilite: gozcudeki tum linkleri tek tek test et, sure+sonuc logla
import asyncio, time, json
from playwright.async_api import async_playwright

PROFILE = "C:/Users/efsun/Desktop/Loki/.rrt-profile"
URLS = [
 "https://admex.com.tr/","https://agualimpia.com.co/","https://arabianoparir.com/","https://autoseekergps.com/",
 "https://det.mk","https://digitaltree.com.ua/","https://eimzaci.com/","https://emspackaging.com.au",
 "https://emspan.com/","https://euro-drewno.pl/","https://forticon.nl/","https://germantvstick.com/",
 "https://globalimpactcouncil.com","https://globetradedesign.com/","https://gryphon.az","https://hardymarketing.ca",
 "https://hesselingdruck.de/","https://hidrourgentedesentupidora.com.br","https://icalledsube.com/","https://iraceminiz.com",
 "https://isuperclean.com/","https://iwantsubscribers.com/","https://julatec.name/","https://karaiteaestate.com/",
 "https://legacyassetholdings.org/","https://olmareitrails.com","https://prestigetravelsolutions.com/",
 "https://qazigroupofschools.com/","https://rocklandautocare.ca","https://rojurist.eu","https://shenaworksltd.com/",
 "https://sisasphalt.com/","https://space-gt.com/","https://stylishkiqwetu.co.ke","https://voicesetfree.com/",
 "https://wallxtrade.com/","https://www.chroma-studio.net/","https://www.jeux-anniversaire.net/",
 "https://www.shricom.in/","https://www.washingtonexpressvisas.com/","https://ybabcc.com","https://yiharch.com/"
]
OUT = "C:/Users/efsun/Desktop/Loki/rrt-batch-results.jsonl"

async def test_one(page, url):
    t0 = time.time()
    try:
        await page.goto("https://search.google.com/test/rich-results?hl=en", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2000)
        # Google consent/cerez overlay'i varsa kapat (aksi halde buton tiklanamaz)
        for txt in ["Accept all", "I agree", "Tümünü kabul et", "Reject all"]:
            try:
                c = page.get_by_role("button", name=txt).first
                if await c.count() and await c.is_visible():
                    await c.click()
                    await page.wait_for_timeout(1000)
                    break
            except Exception:
                pass
        inp = page.locator("input[type=url]:visible, input[placeholder*='URL']:visible").first
        if not await inp.count():
            inp = page.locator("input:visible").first
        await inp.click(); await inp.press_sequentially(url, delay=8)
        # Gecmis onerisi acilir menusu TEST butonunu ortuyor; once kapat
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        btn = page.locator("button:visible, [role=button]:visible").filter(has_text="TEST").first
        if not await btn.count():
            btn = page.get_by_text("TEST", exact=False).first
        await btn.click()
        for _ in range(30):  # ~90sn
            await page.wait_for_timeout(3000)
            t = (await page.evaluate("document.body.innerText")).lower()
            if "not available to google" in t:
                return {"url": url, "sec": round(time.time()-t0,1), "result": "not-available"}
            if "eligible for rich results" in t:
                return {"url": url, "sec": round(time.time()-t0,1), "result": "eligible"}
            if "no items detected" in t or "is available to google" in t:
                return {"url": url, "sec": round(time.time()-t0,1), "result": "available-no-rich"}
            if "something went wrong" in t:
                return {"url": url, "sec": round(time.time()-t0,1), "result": "auth-or-error"}
        return {"url": url, "sec": round(time.time()-t0,1), "result": "timeout"}
    except Exception as e:
        return {"url": url, "sec": round(time.time()-t0,1), "result": "error", "err": str(e)[:120]}

async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE, headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1366, "height": 900}, locale="en-US"
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        with open(OUT, "w", encoding="utf-8") as f:
            for i, u in enumerate(URLS, 1):
                r = await test_one(page, u)
                f.write(json.dumps(r, ensure_ascii=False) + "\n"); f.flush()
                print(f"[{i}/{len(URLS)}] {r['result']} ({r['sec']}sn) {u}", flush=True)
        await ctx.close()

asyncio.run(main())
