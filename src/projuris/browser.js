const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_FILE = path.join(__dirname, '../../.projuris-session.json');
const BASE_URL = process.env.PROJURIS_URL || 'https://app.projurisadv.com.br';

class ProjurisBrowser {
  constructor() {
    this.email = process.env.PROJURIS_EMAIL;
    this.password = process.env.PROJURIS_PASSWORD;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.uploadDir = path.join(__dirname, '../../output');
    if (!fs.existsSync(this.uploadDir)) fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  async init(headless = true) {
    this.browser = await chromium.launch({ headless });
    const storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
    this.context = await this.browser.newContext({ storageState, acceptDownloads: true });
    this.page = await this.context.newPage();
  }

  async ensureLoggedIn() {
    await this.page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle', timeout: 30000 });

    // Check if redirected to login
    if (this.page.url().includes('/login') || this.page.url().includes('/auth')) {
      await this._doLogin();
    }
  }

  async _doLogin() {
    await this.page.fill('input[type="email"], input[name="email"], #username', this.email);
    await this.page.fill('input[type="password"], input[name="password"], #password', this.password);
    await this.page.click('button[type="submit"], input[type="submit"], .btn-login');
    await this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
    await this.context.storageState({ path: SESSION_FILE });
    console.log('✅ Projuris logged in');
  }

  // ── Task Queue ───────────────────────────────────────────────────────────────

  async getTaskQueue() {
    await this.ensureLoggedIn();
    await this.page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle' });

    // Ensure "Personal" view (not Escritório)
    const personalBtn = await this.page.$('button:has-text("Pessoal"), .tab-pessoal, [data-view="pessoal"]');
    if (personalBtn) await personalBtn.click();
    await this.page.waitForTimeout(1000);

    // Extract all visible tasks
    const tasks = await this.page.evaluate(() => {
      const rows = document.querySelectorAll('.tarefa-item, [class*="tarefa"], .task-row, tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td, [class*="cell"], [class*="col"]');
        const text = row.textContent?.trim() || '';
        const link = row.querySelector('a')?.href || '';
        const id = row.dataset?.id || row.id || link.match(/\/tarefa\/(\w+)/)?.[1] || '';

        return {
          id,
          text,
          href: link,
          tipo: cells[3]?.textContent?.trim() || '',
          processo: cells[1]?.textContent?.trim() || '',
          cliente: cells[2]?.textContent?.trim() || '',
          descricao: cells[4]?.textContent?.trim() || '',
          prazo: cells[0]?.textContent?.trim() || '',
        };
      }).filter(t => t.id || t.href);
    });

    return tasks;
  }

  // ── Task Detail ──────────────────────────────────────────────────────────────

  async getTaskDetail(taskHref) {
    await this.ensureLoggedIn();
    await this.page.goto(taskHref, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(500);

    const detail = await this.page.evaluate(() => {
      const get = sel => document.querySelector(sel)?.textContent?.trim() || '';
      const getInput = sel => document.querySelector(sel)?.value?.trim() || '';

      return {
        titulo: get('.tarefa-titulo, [class*="titulo"], h1, h2'),
        tipo: get('[class*="tipo-tarefa"], .tipo'),
        descricao: get('[class*="descricao"], .description, textarea') || getInput('textarea'),
        processo: get('[class*="processo"], [class*="vinculo"]'),
        responsavel: get('[class*="responsavel"]'),
        prazoFatal: get('[class*="fatal"], [class*="prazo"]'),
        fullText: document.body.innerText,
      };
    });

    return detail;
  }

  // Click a task in the list and read the side panel that opens
  async openTask(taskId) {
    await this.ensureLoggedIn();
    await this.page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle' });

    // Click the task row
    const row = await this.page.$(`[data-id="${taskId}"], a[href*="${taskId}"], tr:has-text("${taskId}")`);
    if (row) {
      await row.click();
      await this.page.waitForTimeout(800);
    }

    // Read the side panel
    return this.page.evaluate(() => {
      const panel = document.querySelector('.task-detail, .painel-tarefa, [class*="detail"], aside');
      if (!panel) return { fullText: document.body.innerText };
      return {
        tipo: panel.querySelector('[class*="tipo"]')?.textContent?.trim() || '',
        descricao: panel.querySelector('[class*="descricao"], textarea')?.textContent?.trim() || '',
        processo: panel.querySelector('[class*="processo"], [class*="vinculo"]')?.textContent?.trim() || '',
        responsavel: panel.querySelector('[class*="responsavel"]')?.textContent?.trim() || '',
        fullText: panel.innerText,
      };
    });
  }

  // ── Document Upload ──────────────────────────────────────────────────────────

  async uploadDocument(processNumber, filePath) {
    await this.ensureLoggedIn();

    // Navigate to process
    await this.page.goto(`${BASE_URL}/processo?numero=${encodeURIComponent(processNumber)}`, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(500);

    // Find upload button/input
    const uploadInput = await this.page.$('input[type="file"]');
    if (!uploadInput) {
      // Try clicking an upload button first to reveal the file input
      const uploadBtn = await this.page.$('button:has-text("Upload"), button:has-text("Anexar"), button:has-text("Documento")');
      if (uploadBtn) {
        await uploadBtn.click();
        await this.page.waitForTimeout(500);
      }
    }

    const fileInput = await this.page.$('input[type="file"]');
    if (!fileInput) throw new Error('Upload input not found on process page');

    await fileInput.setInputFiles(filePath);
    await this.page.waitForTimeout(500);

    // Confirm upload
    const saveBtn = await this.page.$('button:has-text("Salvar"), button:has-text("Confirmar"), button[type="submit"]');
    if (saveBtn) await saveBtn.click();
    await this.page.waitForTimeout(1000);

    console.log(`✅ Uploaded ${path.basename(filePath)} to process ${processNumber}`);
  }

  // ── Create Revisão Task ──────────────────────────────────────────────────────

  async createRevisaoTask({ processNumber, tarefaOrigemId, responsavel, descricao = 'Prazo protocolado? Se sim, concluir esta tarefa.' }) {
    await this.ensureLoggedIn();
    await this.page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'networkidle' });

    // Click "Nova Tarefa" / "Novo"
    const novoBtn = await this.page.$('button:has-text("Novo"), button:has-text("Nova Tarefa"), .btn-novo');
    if (!novoBtn) throw new Error('"Nova Tarefa" button not found');
    await novoBtn.click();
    await this.page.waitForTimeout(800);

    // Fill the form
    const hoje = new Date().toLocaleDateString('pt-BR');

    await this._fillField('[name="processo"], [placeholder*="processo"], [placeholder*="Processo"]', processNumber);
    await this._selectOption('select[name="tipoTarefa"], [name="tipo"]', 'Revisão');
    await this._fillField('[name="dataBase"], [placeholder*="data base"]', hoje);
    await this._fillField('[name="dataPrevista"], [placeholder*="prevista"]', hoje);
    await this._fillField('[name="dataFatal"], [placeholder*="fatal"]', hoje);
    await this._fillField('[name="descricao"], textarea[name="descricao"]', descricao);
    await this._fillField('[name="responsavel"], [placeholder*="responsavel"]', responsavel);

    // Save
    const saveBtn = await this.page.$('button:has-text("Salvar"), button[type="submit"]');
    if (saveBtn) await saveBtn.click();
    await this.page.waitForTimeout(1000);

    console.log(`✅ Revisão task created — assigned to ${responsavel}`);
  }

  // ── Transfer Original Task ───────────────────────────────────────────────────

  async transferTask(taskId, { responsavel, descricao }) {
    await this.ensureLoggedIn();

    const row = await this.page.$(`[data-id="${taskId}"], tr:has-text("${taskId}")`);
    if (row) await row.click();
    await this.page.waitForTimeout(600);

    const editBtn = await this.page.$('button:has-text("Editar"), .btn-edit');
    if (editBtn) await editBtn.click();
    await this.page.waitForTimeout(500);

    await this._fillField('[name="responsavel"]', responsavel);
    await this._fillField('[name="descricao"], textarea', descricao);

    const saveBtn = await this.page.$('button:has-text("Salvar"), button[type="submit"]');
    if (saveBtn) await saveBtn.click();
    await this.page.waitForTimeout(800);

    console.log(`✅ Task ${taskId} transferred to ${responsavel}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  async _fillField(selector, value) {
    try {
      const el = await this.page.$(selector);
      if (el) { await el.triple_click?.() || el.click(); await el.fill(value); }
    } catch { /* field may not exist */ }
  }

  async _selectOption(selector, value) {
    try {
      const el = await this.page.$(selector);
      if (el) await this.page.selectOption(selector, { label: value });
    } catch { /* option may not exist */ }
  }

  async screenshot(name) {
    const p = path.join(__dirname, `../../output/screenshot_${name}_${Date.now()}.png`);
    await this.page.screenshot({ path: p, fullPage: false });
    return p;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

module.exports = ProjurisBrowser;
