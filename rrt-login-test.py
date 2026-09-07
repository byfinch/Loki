# RRT fizibilite: kalici profil ile Google girisi + tek URL testi
import asyncio, sys
from playwright.async_api import async_playwright

PROFILE = "C:/Users/efsun/Desktop/Loki/.rrt-profile"
EMAIL = "elifsen33690220@gmail.com"
PASSWORD = "ri?8-3C.RCg"

async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE, headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900}, locale="tr-TR"
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        # Zaten girisliyse dogrudan RRT'ye git
        await page.goto("https://accounts.google.com/ServiceLogin", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)
        if "myaccount" in page.url or "signin" not in page.url.lower():
            print("[*] zaten girisli gorunuyor")
        else:
            print("[*] giris akisi basliyor")
            try:
                await page.locator("input[type=email]").fill(EMAIL)
                await page.locator("input[type=email]").press("Enter")
                await page.wait_for_timeout(3500)
                pw = page.locator("input[type=password]").first
                await pw.fill(PASSWORD)
                await pw.press("Enter")
                await page.wait_for_timeout(6000)
            except Exception as e:
                print("[!] giris akisi hatasi:", e)
        print("[*] su anki url:", page.url)
        await page.screenshot(path="rrt_login_state.png")
        await ctx.close()

asyncio.run(main())
