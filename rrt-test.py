# RRT olabilirlik testi: search.google.com/test/rich-results otomasyonu
import asyncio, sys
from playwright.async_api import async_playwright

TARGET = sys.argv[1] if len(sys.argv) > 1 else "https://voicesetfree.com/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 900}, locale="en-US"
        )
        page = await ctx.new_page()
        print("[1] sayfa aciliyor...")
        await page.goto("https://search.google.com/test/rich-results", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(4000)
        await page.screenshot(path="rrt_1_landing.png")

        # URL input
        inp = page.locator("input[placeholder*='URL'], input[type='url'], input[name='url']").first
        if not await inp.count():
            inp = page.locator("input:visible").first
        await inp.fill(TARGET)
        print("[2] url girildi")

        # TEST URL butonu
        btn = page.get_by_text("TEST URL", exact=False).first
        await btn.click()
        print("[3] test basladi, sonuc bekleniyor...")

        # Sonuc: 90 sn bekle, durumu yakala
        for _ in range(30):
            await page.wait_for_timeout(3000)
            text = await page.evaluate("document.body.innerText")
            low = text.lower()
            if "url is not available to google" in low:
                print("SONUC: KAPALI (URL is not available to Google)")
                break
            if "page is eligible for rich results" in low or "url is available to google" in low.replace("not available","") or "detected" in low and "items" in low:
                print("SONUC: ACIK (eligible/available)")
                break
            if "captcha" in low or "unusual traffic" in low or "verify" in low and "robot" in low:
                print("SONUC: BOTLUK TESPITI (captcha/unusual traffic)")
                break
        else:
            print("SONUC: zaman asimi (90sn icinde karar cikmadi)")
        await page.screenshot(path="rrt_2_result.png", full_page=False)
        # HTML sekmesinde keyword kontrolu icin sayfanin ham metnini de sakla
        open("rrt_body.txt","w",encoding="utf-8").write(text[:5000])
        await browser.close()

asyncio.run(main())
