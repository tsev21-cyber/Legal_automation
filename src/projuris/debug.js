const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.PROJURIS_URL || 'https://app.projurisadv.com.br';
const OUTPUT = path.join(__dirname, '../../output');
if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// Login, capture screenshot + intercept API calls to discover real endpoints
async function debugProjuris() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const apiCalls = [];

  // Intercept all API/XHR requests
  page.on('request', req => {
    const url = req.url();
    const method = req.method();
    if (
      (url.includes('/api/') || url.includes('/rest/') || url.includes('/graphql') ||
       url.includes('tarefa') || url.includes('task') || url.includes('processo')) &&
      !url.includes('.js') && !url.includes('.css')
    ) {
      apiCalls.push({ method, url, headers: req.headers() });
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (
      (url.includes('/api/') || url.includes('/rest/') ||
       url.includes('tarefa') || url.includes('task')) &&
      !url.includes('.js') && !url.includes('.css')
    ) {
      try {
        const body = await resp.text();
        const existing = apiCalls.find(c => c.url === url);
        if (existing) existing.responsePreview = body.slice(0, 500);
        else apiCalls.push({ url, status: resp.status(), responsePreview: body.slice(0, 500) });
      } catch { /* ignore */ }
    }
  });

  // Step 1: Navigate to login
  console.log('Navigating to Projuris...');
  await page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle', timeout: 30000 });

  const ss1 = path.join(OUTPUT, 'debug_1_initial.png');
  await page.screenshot({ path: ss1, fullPage: true });
  console.log(`Screenshot 1 (initial page): ${ss1}`);
  console.log('URL after initial load:', page.url());

  // Step 2: Login if needed
  if (page.url().includes('login') || page.url().includes('auth') || await page.$('input[type="password"]')) {
    console.log('Login form detected — filling credentials...');

    // Try multiple selectors for email/user field
    for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[name="username"]', '#username', '#email', 'input[placeholder*="e-mail" i]', 'input[placeholder*="usuário" i]']) {
      const el = await page.$(sel);
      if (el) { await el.fill(process.env.PROJURIS_EMAIL); console.log(`Filled email with: ${sel}`); break; }
    }

    for (const sel of ['input[type="password"]', 'input[name="password"]', '#password']) {
      const el = await page.$(sel);
      if (el) { await el.fill(process.env.PROJURIS_PASSWORD); console.log(`Filled password with: ${sel}`); break; }
    }

    const ss2 = path.join(OUTPUT, 'debug_2_filled.png');
    await page.screenshot({ path: ss2 });
    console.log(`Screenshot 2 (form filled): ${ss2}`);

    // Submit
    for (const sel of ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Entrar")', 'button:has-text("Login")', 'button:has-text("Acessar")']) {
      const el = await page.$(sel);
      if (el) { await el.click(); console.log(`Clicked submit: ${sel}`); break; }
    }

    await page.waitForTimeout(3000);
  }

  const ss3 = path.join(OUTPUT, 'debug_3_after_login.png');
  await page.screenshot({ path: ss3, fullPage: true });
  console.log(`Screenshot 3 (after login): ${ss3}`);
  console.log('URL after login:', page.url());

  // Step 3: Navigate to task page and wait for tasks to load
  if (!page.url().includes('/home/tarefa')) {
    await page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);
  }

  const ss4 = path.join(OUTPUT, 'debug_4_tasks_page.png');
  await page.screenshot({ path: ss4, fullPage: true });
  console.log(`Screenshot 4 (tasks page): ${ss4}`);

  // Step 4: Extract page HTML structure (first 5000 chars)
  const html = await page.content();
  const htmlFile = path.join(OUTPUT, 'debug_tasks_page.html');
  fs.writeFileSync(htmlFile, html);
  console.log(`HTML saved: ${htmlFile}`);

  // Step 5: Try to find task elements by exploring DOM
  const domInfo = await page.evaluate(() => {
    const info = {
      title: document.title,
      url: window.location.href,
      bodyClasses: document.body.className,
      likelyCandidates: [],
    };

    // Find elements that look like task rows
    const selectors = [
      'tr', 'li', '[class*="tarefa"]', '[class*="task"]', '[class*="item"]',
      '[class*="row"]', '[class*="card"]', '[data-id]', '[class*="lista"]'
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length < 200) {
        info.likelyCandidates.push({
          selector: sel,
          count: els.length,
          firstClass: els[0].className,
          firstText: els[0].textContent?.trim().slice(0, 100),
          firstDataId: els[0].dataset?.id,
        });
      }
    }

    return info;
  });

  // Step 6: Check auth tokens in localStorage/cookies
  const storage = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const tokens = {};
    keys.forEach(k => {
      if (k.toLowerCase().includes('token') || k.toLowerCase().includes('auth') || k.toLowerCase().includes('jwt')) {
        tokens[k] = localStorage.getItem(k)?.slice(0, 100);
      }
    });
    return tokens;
  });

  const cookies = await context.cookies();
  const authCookies = cookies.filter(c =>
    c.name.toLowerCase().includes('token') ||
    c.name.toLowerCase().includes('auth') ||
    c.name.toLowerCase().includes('session') ||
    c.name.toLowerCase().includes('jwt')
  );

  await browser.close();

  return {
    screenshots: [ss1, ss3, ss4].map(s => path.basename(s)),
    finalUrl: page.url(),
    domInfo,
    apiCalls: apiCalls.slice(0, 20),
    authTokens: storage,
    authCookies: authCookies.map(c => ({ name: c.name, value: c.value?.slice(0, 80), domain: c.domain })),
    htmlFile: path.basename(htmlFile),
  };
}

module.exports = { debugProjuris };
