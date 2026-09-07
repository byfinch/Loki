# Kalici RRT profili icin elle dogrulama penceresi: acilir, 10 dk acik kalir.
# Kullanici Google dogrulamasini elle tamamlar, pencere kapaninca profil saklanir.
import asyncio
from playwright.async_api import async_playwright

PROFILE = "C:/Users/efsun/Desktop/Loki/.rrt-profile"

async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE, headless=False,
            args=["--disable-blink-features=AutomationControlled", "--start-maximized"],
            no_viewport=True, locale="tr-TR"
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto("https://accounts.google.com/ServiceLogin", wait_until="domcontentloaded", timeout=45000)
        print("Pencere acik: dogrulamayi elle tamamla. 10 dakika sonra kapanir.")
        await page.wait_for_timeout(600000)
        await ctx.close()
        print("Profil kaydedildi.")

asyncio.run(main())
