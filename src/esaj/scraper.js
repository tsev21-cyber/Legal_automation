const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { chromiumLaunchOptions } = require('../utils/chrome');

const SESSION_FILE = path.join(__dirname, '../../.esaj-session.json');
const KEEPALIVE_INTERVAL_MS = 35 * 60 * 1000; // 35 min (below 40-min ESAJ timeout)

class EsajScraper {
  constructor({ login, password, downloadDir } = {}) {
    this.login = login || process.env.ESAJ_LOGIN;
    this.password = password || process.env.ESAJ_PASSWORD;
    this.downloadDir = downloadDir || path.join(__dirname, '../../downloads');
    this.browser = null;
    this.context = null;
    this.page = null;
    this._keepaliveTimer = null;

    if (!fs.existsSync(this.downloadDir)) fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  async init() {
    this.browser = await chromium.launch(chromiumLaunchOptions());

    // Restore saved session if available
    const storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
    this.context = await this.browser.newContext({
      storageState,
      acceptDownloads: true,
    });
    this.page = await this.context.newPage();
  }

  async ensureLoggedIn() {
    if (!this.page) await this.init();

    // Try portal directly — if session cookies are valid we land on the portal, not the login page
    await this.page.goto('https://esaj.tjsp.jus.br/esaj-layout/ui/index', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

    const url = this.page.url();
    if (url.includes('login')) {
      throw new Error('e-SAJ session expired or not found. Run "node login-esaj.js" to log in again.');
    }

    console.log('✅ e-SAJ session valid');
    this._startKeepalive();
  }

  async _wait2FACode(timeoutMs = 5 * 60 * 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const code = process.env.ESAJ_2FA_CODE;
      if (code) {
        delete process.env.ESAJ_2FA_CODE; // consume it
        return code;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Timeout waiting for ESAJ_2FA_CODE environment variable');
  }

  _startKeepalive() {
    if (this._keepaliveTimer) return;
    this._keepaliveTimer = setInterval(async () => {
      try {
        // Lightweight navigation to keep session alive
        await this.page.evaluate(() => {
          const img = document.querySelector('img');
          if (img) img.click();
        });
      } catch { /* ignore */ }
    }, KEEPALIVE_INTERVAL_MS);
  }

  // ── Pasta Digital ────────────────────────────────────────────────────────────

  async getPastaDigital(processNumber) {
    await this.ensureLoggedIn();

    // Step 1: search for the process to get cdProcesso + cdForo
    const searchUrl = `https://esaj.tjsp.jus.br/cpopg/search.do?conversationId=&cbPesquisa=NUMPROC&numeroDigitoAnoUnificado=&foroNumeroUnificado=&dadosConsulta.valorConsultaNuUnificado=${encodeURIComponent(processNumber)}&dadosConsulta.valorConsulta=&dadosConsulta.tipoNuProcesso=UNIFICADO`;
    await this.page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // May redirect straight to show.do, or list results — find the show.do link
    let showUrl = this.page.url();
    if (!showUrl.includes('show.do')) {
      const link = await this.page.$(`a[href*="show.do"][href*="${processNumber.replace(/\D/g, '').slice(0,7)}"], a[href*="show.do"]`);
      if (link) {
        showUrl = await link.getAttribute('href');
        if (!showUrl.startsWith('http')) showUrl = `https://esaj.tjsp.jus.br${showUrl}`;
        await this.page.goto(showUrl, { waitUntil: 'networkidle', timeout: 30000 });
        showUrl = this.page.url();
      }
    }

    console.log(`📂 Process page: ${showUrl}`);

    // Step 2: find the "Visualizar autos" link — it has the full Pasta Digital URL with all params
    const pastaHref = await this.page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(el =>
        el.textContent.trim().toLowerCase().includes('visualizar autos') ||
        (el.href && el.href.includes('abrirPastaProcessoDigital'))
      );
      return a ? a.href : null;
    });

    if (!pastaHref) throw new Error(`"Visualizar autos" link not found for process ${processNumber}`);
    console.log(`📂 Pasta Digital URL: ${pastaHref}`);

    // Step 3: open Pasta Digital in new page and wait for the tree iframe to load
    const pastaPage = await this.context.newPage();
    await pastaPage.goto(pastaHref, { waitUntil: 'networkidle', timeout: 30000 });
    await pastaPage.waitForTimeout(3000);

    // The document tree loads inside an iframe — wait for it
    const allFrames = pastaPage.frames();
    console.log(`📂 Pasta Digital loaded: ${allFrames.length} frames`);
    allFrames.forEach((f, i) => console.log(`  frame[${i}]: ${f.url()}`));

    // Step 4: extract movimentação text directly from DOM (skip PDF download entirely)
    const docs = await pastaPage.evaluate(() => {
      const items = [];
      const seen = new Set();

      document.querySelectorAll('a[href*="abrirDocumentoVinculadoMovimentacao"]').forEach(a => {
        if (seen.has(a.href)) return;
        seen.add(a.href);

        const row = a.closest('tr');
        if (!row) return;

        const cells = [...row.querySelectorAll('td')];
        const descCell = cells.find(td =>
          td.textContent.trim().length > 12 &&
          !/^\d{2}\/\d{2}\/\d{4}$/.test(td.textContent.trim())
        );

        // Gather text from subsequent rows until the next doc link row
        let fullText = '';
        let next = row.nextElementSibling;
        while (next && !next.querySelector('a[href*="abrirDocumentoVinculadoMovimentacao"]')) {
          const txt = next.textContent.trim();
          if (txt.length > 20) fullText += txt + ' ';
          if (fullText.length > 3000) break;
          next = next.nextElementSibling;
        }

        const label = (descCell?.textContent || '').trim().replace(/\s+/g, ' ');
        const textContent = (label + ' ' + fullText).trim().replace(/\s+/g, ' ').slice(0, 4000);
        items.push({ label, href: a.href, textContent });
      });

      return items;
    });

    console.log(`  Found ${docs.length} movimentação docs`);
    docs.slice(0, 3).forEach(d => console.log(`    "${d.label.slice(0, 80)}" (${d.textContent.length} chars)`));

    await pastaPage.close();
    return docs;
  }


// Return the most relevant movimentação docs with text already extracted from DOM
  async downloadRelevantDocs(processNumber, tipos = ['Decisão', 'Despacho', 'Petição', 'Embargos', 'Agravo', 'Recurso']) {
    const docs = await this.getPastaDigital(processNumber);

    // Always include the single most recent Decisão first, then fill with other tipo matches
    const decisoes = docs.filter(d => /decis[ãa]o/i.test(d.label));
    const otherMatches = docs.filter(d =>
      !decisoes.includes(d) &&
      tipos.some(t => d.label.toLowerCase().includes(t.toLowerCase()))
    );
    const combined = [...decisoes.slice(0, 1), ...otherMatches].slice(0, 3);
    const selected = combined.length > 0 ? combined : docs.slice(0, 3);

    console.log(`📋 Selected ${selected.length} docs for context:`);
    selected.forEach((d, i) => {
      console.log(`\n--- Doc ${i + 1}: ${d.label.slice(0, 80)} ---`);
      console.log(d.textContent?.slice(0, 1000) || '(empty)');
    });

    // textContent already scraped from DOM — no PDF download needed
    return selected.map(d => ({ label: d.label, path: null, textContent: d.textContent || d.label }));
  }

  async close() {
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
    if (this.browser) await this.browser.close();
  }
}

module.exports = EsajScraper;
