require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '.esaj-session.json');

(async () => {
  console.log('Opening e-SAJ login page...');
  console.log('Please log in manually (including 2FA if prompted).');
  console.log('The browser will close and save your session once you are logged in.\n');

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://esaj.tjsp.jus.br/sajcas/login', { waitUntil: 'networkidle' });

  // Wait up to 5 minutes for Fernando to complete login
  console.log('Waiting for you to log in... (up to 5 minutes)');
  try {
    await page.waitForFunction(
      () => !document.querySelector('#usernameForm') && (
        document.querySelector('.usuarioLogado') ||
        document.querySelector('[class*="logado"]') ||
        window.location.href.includes('portal') ||
        window.location.href.includes('home') ||
        window.location.href.includes('esaj-layout') ||
        window.location.href.includes('cpopg') ||
        !window.location.href.includes('login')
      ),
      { timeout: 5 * 60 * 1000 }
    );
    console.log('✅ Login detected! URL:', page.url());
  } catch {
    console.log('⚠️  Could not auto-detect login. Saving session anyway...');
  }

  await context.storageState({ path: SESSION_FILE });
  console.log(`\n✅ Session saved to ${SESSION_FILE}`);
  console.log('You can now run the server with ESAJ_MANUAL=false and e-SAJ will work automatically.\n');

  await browser.close();
})().catch(e => console.error('Error:', e.message));
