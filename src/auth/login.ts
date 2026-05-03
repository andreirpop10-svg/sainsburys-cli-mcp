import { chromium } from 'playwright';
import * as fs from 'fs';
import * as readline from 'readline';
import { CONFIG_DIR, SESSION_FILE, isDebugMode, ensureConfigDir } from '../config/paths.js';

export interface SessionData {
  cookies: any[];
  expiresAt: string;
  lastLogin: string;
}

export async function login(email: string, password: string): Promise<SessionData> {
  console.log('🔐 Logging in to Sainsbury\'s...');
  
  const browser = await chromium.launch({ headless: !isDebugMode() });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    // Go to login page (OAuth endpoint)
    console.log('📍 Navigating to login page...');
    await page.goto('https://account.sainsburys.co.uk/gol/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    
    // Handle cookie consent if present
    try {
      console.log('🍪 Checking for cookie consent...');
      const acceptButton = page.locator('#onetrust-accept-btn-handler');
      if (await acceptButton.isVisible({ timeout: 3000 })) {
        console.log('🍪 Accepting cookies...');
        await acceptButton.click();
        console.log('🍪 Waiting for banner to dismiss...');
        await page.waitForTimeout(3000);
        // Wait for overlay to disappear
        await page.waitForSelector('#onetrust-consent-sdk.ot-hide, .onetrust-pc-dark-filter.ot-hide', { timeout: 5000 }).catch(() => {});
      }
    } catch (e) {
      console.log('🍪 No cookie consent found or already accepted');
    }
    
    // Wait for login form to appear
    console.log('⏳ Waiting for login form...');
    await page.waitForSelector('input[type="email"], input[name="username"], #username', { timeout: 10000 });
    
    // Fill in email
    console.log('📧 Entering email...');
    await page.fill('input[type="email"], input[name="email"], #username', email);
    await page.waitForTimeout(500);
    
    // Fill in password
    console.log('🔑 Entering password...');
    await page.fill('input[type="password"], input[name="password"], #password', password);
    await page.waitForTimeout(500);
    
    // Force remove any cookie overlays blocking interactions
    console.log('🧹 Removing cookie overlays...');
    // @ts-ignore - runs in browser context
    await page.evaluate(() => {
      // @ts-ignore
      const overlay = document.querySelector('.onetrust-pc-dark-filter');
      // @ts-ignore
      const banner = document.querySelector('#onetrust-consent-sdk');
      if (overlay) overlay.remove();
      if (banner) banner.remove();
    });
    await page.waitForTimeout(1000);
    
    // Click login button
    console.log('👆 Clicking login...');
    await page.click('button[type="submit"], button[data-testid="log-in"]');

    // Wait for redirect away from the login/account domain (or to MFA page)
    // Using waitForURL is more reliable than a fixed timeout, especially in WSL/Linux
    try {
      await page.waitForURL(
        (url) => !url.includes('account.sainsburys.co.uk') || url.includes('/mfa'),
        { timeout: 30000 }
      );
    } catch {
      // If waitForURL times out, fall back to a fixed delay
      await page.waitForTimeout(5000);
    }

    // Only do banner/cookie dance when not on MFA page — MFA can be triggered here too
    if (!page.url().includes('/mfa')) {
      // Accept cookie banner that appears on the post-login groceries page.
      // Use a longer timeout (10s) because WSL/Linux can be slower to render the page.
      try {
        const acceptButton = page.locator('#onetrust-accept-btn-handler');
        if (await acceptButton.isVisible({ timeout: 10000 })) {
          console.log('🍪 Accepting cookies on groceries page...');
          await acceptButton.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {}

      // Wait for WC_AUTHENTICATION_* cookie (set by JS after cookie consent)
      console.log('⏳ Waiting for auth cookie...');
      for (let i = 0; i < 20; i++) {
        const cookies = await context.cookies();
        if (cookies.some((c: any) => c.name.startsWith('WC_AUTHENTICATION_'))) break;
        await page.waitForTimeout(1000);
      }

      // The OAuth redirect from account.sainsburys.co.uk can land on a guest session.
      // If "Log in / Register" is still visible, click it to start the proper OAuth flow
      // from www.sainsburys.co.uk (/gol-ui/oauth/login), which generates a fresh challenge.
      const loginRegisterLink = page.locator('[data-testid="login-register-link"]');
      if (await loginRegisterLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('⚠️ Landed as guest — clicking "Log in / Register" for proper OAuth flow...');
        await loginRegisterLink.click();
        await page.waitForTimeout(3000);

        // Cookie banner on account.sainsburys.co.uk (fresh challenge page)
        try {
          const btn = page.locator('#onetrust-accept-btn-handler');
          if (await btn.isVisible({ timeout: 3000 })) {
            console.log('🍪 Accepting cookies on login page...');
            await btn.click();
            await page.waitForTimeout(2000);
          }
        } catch (e) {}

        console.log('⏳ Waiting for login form...');
        await page.waitForSelector('input[type="email"], input[name="username"], #username', { timeout: 10000 });

        console.log('📧 Re-entering email...');
        await page.fill('input[type="email"], input[name="email"], #username', email);
        await page.waitForTimeout(500);
        console.log('🔑 Re-entering password...');
        await page.fill('input[type="password"], input[name="password"], #password', password);
        await page.waitForTimeout(500);

        await page.evaluate(`(() => {
          document.querySelector('.onetrust-pc-dark-filter')?.remove();
          document.querySelector('#onetrust-consent-sdk')?.remove();
        })()`);
        await page.waitForTimeout(500);

        console.log('👆 Clicking login...');
        await page.click('button[type="submit"], button[data-testid="log-in"]');

        try {
          await page.waitForURL(
            (url) => !url.includes('account.sainsburys.co.uk') || url.includes('/mfa'),
            { timeout: 30000 }
          );
        } catch {
          await page.waitForTimeout(5000);
        }

        // MFA may also be triggered on the second login attempt
        if (!page.url().includes('/mfa')) {
          try {
            const btn = page.locator('#onetrust-accept-btn-handler');
            if (await btn.isVisible({ timeout: 10000 })) {
              console.log('🍪 Accepting cookies on groceries page...');
              await btn.click();
              await page.waitForTimeout(2000);
            }
          } catch (e) {}

          for (let i = 0; i < 20; i++) {
            const cookies = await context.cookies();
            if (cookies.some((c: any) => c.name.startsWith('WC_AUTHENTICATION_'))) break;
            await page.waitForTimeout(1000);
          }
        }
      }
    }

    // Check current URL — MFA may have been triggered on either login attempt
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    // Handle MFA if required
    if (currentUrl.includes('/mfa')) {
      console.log('🔐 MFA required - SMS code sent');
      console.log('📱 Check your phone for the 6-digit code');
      
      // Prompt for MFA code
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const mfaCode = await new Promise<string>((resolve) => {
        rl.question('Enter 6-digit MFA code: ', (answer: string) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      
      if (!mfaCode || mfaCode.length !== 6) {
        throw new Error('Invalid MFA code - must be 6 digits');
      }
      
      console.log('🔑 Submitting MFA code...');
      await page.fill('#code, input[name="code"]', mfaCode);
      await page.waitForTimeout(500);
      
      // Remove cookie overlays again (they may reappear on MFA page)
      // @ts-ignore - runs in browser context
      await page.evaluate(() => {
        // @ts-ignore
        const overlay = document.querySelector('.onetrust-pc-dark-filter');
        // @ts-ignore
        const banner = document.querySelector('#onetrust-consent-sdk');
        if (overlay) overlay.remove();
        if (banner) banner.remove();
      });
      await page.waitForTimeout(500);
      
      await page.click('button[data-testid="submit-code"], button[type="submit"]:has-text("Continue")');
      
      console.log('⏳ Waiting for redirect...');
      await page.waitForTimeout(5000);
      
      const finalUrl = page.url();
      console.log(`Final URL after MFA: ${finalUrl}`);
      
      if (finalUrl.includes('login') || finalUrl.includes('mfa')) {
        throw new Error('MFA verification failed - check code and try again');
      }
    } else if (currentUrl.includes('login')) {
      throw new Error('Login failed - still on login page');
    }
    
    console.log('✅ Login successful!');
    
    // Get cookies
    const cookies = await context.cookies();
    
    const sessionData: SessionData = {
      cookies: cookies,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      lastLogin: new Date().toISOString()
    };
    
    // Save session
    saveSession(sessionData);
    
    await browser.close();
    
    return sessionData;
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export function saveSession(session: SessionData) {
  ensureConfigDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`💾 Session saved to ${SESSION_FILE}`);
}

export function loadSession(): SessionData | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }

  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    const session: SessionData = JSON.parse(data);

    // Check if expired
    if (new Date(session.expiresAt) < new Date()) {
      console.log('⚠️  Session expired');
      return null;
    }

    return session;
  } catch (error) {
    console.log('⚠️  Corrupt session file, removing');
    fs.unlinkSync(SESSION_FILE);
    return null;
  }
}

export function getCookieString(session: SessionData): string {
  return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log('🗑️  Session cleared');
  }
}
