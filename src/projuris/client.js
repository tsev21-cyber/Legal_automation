const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { chromiumLaunchOptions } = require('../utils/chrome');

const BASE_URL = process.env.PROJURIS_URL || 'https://app.projurisadv.com.br';
const API_BASE = 'https://service.projurisadv.com.br/adv-service/v2';
const API_ROOT = 'https://service.projurisadv.com.br/adv-service'; // non-versioned endpoints
const TOKEN_CACHE_FILE = path.join(__dirname, '../../.projuris-token.json');

class ProjurisClient {
  constructor() {
    this._token = null;
    this._tokenExpiry = 0;
    this._loadCachedToken();
  }

  _loadCachedToken() {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      if (data.token && data.expiry && Date.now() < data.expiry) {
        this._token = data.token;
        this._tokenExpiry = data.expiry;
        console.log('✅ Projuris token loaded from cache');
      }
    } catch { /* no cache yet */ }
  }

  _saveCachedToken(token, expiry) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token, expiry })); } catch { /* ignore */ }
  }

  // ── Auth (Playwright-based: extracts token from the real browser session) ───

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;

    const token = await this._extractTokenViaBrowser();
    if (!token) throw new Error('Projuris: could not obtain auth token via browser login');

    this._token = token;
    this._tokenExpiry = Date.now() + (8 * 3600 - 120) * 1000;
    this._saveCachedToken(token, this._tokenExpiry);
    console.log('✅ Projuris token obtained via browser login');
    return this._token;
  }

  async _extractTokenViaBrowser() {
    const { chromium } = require('playwright');
    const browser = await chromium.launch(chromiumLaunchOptions());
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'commit', timeout: 60000 });

      // Wait for Keycloak JS-redirect to login page, then for the task dashboard
      await page.waitForSelector('input[type="password"], [class*="tarefa"], [class*="task"]', { timeout: 20000 }).catch(() => {});

      const onLoginPage = await page.$('input[type="password"]');
      if (onLoginPage) {
        for (const sel of ['input[name="username"]', 'input[type="email"]', '#username', '#email']) {
          const el = await page.$(sel);
          if (el) { await el.fill(process.env.PROJURIS_EMAIL); break; }
        }
        await onLoginPage.fill(process.env.PROJURIS_PASSWORD);
        for (const sel of ['button[type="submit"]', 'input[type="submit"]']) {
          const el = await page.$(sel);
          if (el) { await el.click(); break; }
        }
        // Poll until the app stores the JWT in localStorage (up to 25s)
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          await page.waitForTimeout(500);
          const t = await page.evaluate(() => {
            for (const k of Object.keys(localStorage)) {
              const v = localStorage.getItem(k) || '';
              if (v.startsWith('eyJ')) return v;
              try { const p = JSON.parse(v); if (p?.access_token) return p.access_token; } catch { /**/ }
            }
            return null;
          }).catch(() => null);
          if (t) return t;
        }
        return null;
      }

      // Already logged in — extract token directly
      return await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          const v = localStorage.getItem(k) || '';
          if (v.startsWith('eyJ')) return v;
          try { const p = JSON.parse(v); if (p?.access_token) return p.access_token; } catch { /**/ }
        }
        return null;
      }).catch(() => null);
    } finally {
      await browser.close();
    }
  }

  // ── Task Queue ──────────────────────────────────────────────────────────────

  async getTasks({ page = 0, pageSize = 50, escritorio = false } = {}) {
    const token = await this.getToken();
    const qs = `/tarefa/consulta-pendente-execucao?quan-registros=${pageSize}&pagina=${page}&ordenacao-tipo=ASC&ordenacao-chave=ORDENACAO_DATA_PREVISTA`;
    const body = { visaoEscritorio: escritorio, filtroTarefaCompromisso: 'TAREFA', tipoClassificacao: 'TAREFA' };
    const data = await this._apiRequest('POST', qs, body, token);
    return (data.tarefaConsultaResumoResultadoWs || [])
      .map(this._normalizeTask)
      .filter(t => !/^revis[aã]o$/i.test(t.tipo.trim()));
  }

  async getTask(codigoTarefaEvento) {
    const token = await this.getToken();
    const data = await this._apiRequest('GET', `/tarefa/${codigoTarefaEvento}`, null, token);
    return this._normalizeTask(data);
  }

  // ── Create Revisão Task ─────────────────────────────────────────────────────

  // REVISAO_TIPO_CHAVE = 2096716 — Projuris internal code for "Revisão" task type
  // (captured from real network request; specific to this firm's instance)
  static get REVISAO_TIPO_CHAVE() { return 2096716; }

  // taskEventId = the ID of the task being processed (creates tarefa relacionada)
  async createRevisaoTask({ processIdentifier, taskEventId, responsavelNome, prazoFatal }) {
    const token = await this.getToken();

    const { codigoProcesso } = await this.getProcessDetails(processIdentifier, token);
    const user = await this._findUser(responsavelNome, token);

    const hoje = Date.now();
    const amanha = hoje + 86400000;
    const rawPrazo = prazoFatal ? new Date(prazoFatal).getTime() : 0;
    const prazo = rawPrazo > hoje ? rawPrazo : amanha;

    const modulos = [
      { modulo: 'PROCESSO', codigoRegistroVinculo: codigoProcesso, vinculoPrincipal: true },
      ...(taskEventId ? [{ modulo: 'TAREFA_EVENTO', codigoRegistroVinculo: Number(taskEventId), vinculoPrincipal: false }] : []),
    ];

    const body = {
      tarefaEventoWs: {
        usuariosResponsaveis: user ? [{ chave: user.chave, valor: user.valor }] : [],
        gruposResponsaveis: [],
        tipoTarefa: { chave: ProjurisClient.REVISAO_TIPO_CHAVE, valor: 'Revisão' },
        tarefaEventoSituacaoWs: { codigoTarefaEventoSituacao: 1, situacao: 'Pendente' },
        marcadorWs: [],
        notificaResponsavelCriacao: false,
        notificaClienteCriacao: false,
        notificaTerceirosCriacao: false,
        notificaResponsavelConclusao: false,
        notificaClienteConclusao: false,
        notificaTerceirosConclusao: false,
        privado: true,
        terceirosCriacao: [],
        terceirosConclusao: [],
        titulo: '',
        local: '',
        lembreteWs: [],
        kanban: false,
        quadroKanban: { chave: 8495, valor: 'Quadro do Escritório' },
        colunaKanban: { chave: 59460, valor: 'Pendente - Pendente' },
        descricao: 'Prazo protocolado? Se sim, concluir esta tarefa.',
        dataBase: hoje,
        dataConclusaoPrevista: prazo,
        dataLimite: prazo,
        horaConclusao: null,
        horaLimite: null,
        modulos,
      },
      compromisso: false,
      possuiRecorrencia: false,
      tarefaCompromissoEventoWs: null,
      modulos,
    };

    return this._rawRequestJson('POST', `${API_ROOT}/tarefa`, body, token);
  }

  async transferTask(codigoTarefaEvento, { responsavelNome, descricao }) {
    const token = await this.getToken();
    return this._apiRequest('PUT', `/tarefa/${codigoTarefaEvento}`, {
      descricao,
      responsaveis: responsavelNome ? [{ nomeCompleto: responsavelNome }] : [],
    }, token);
  }

  // ── Process Code Lookup ─────────────────────────────────────────────────────

  // Returns { codigoProcesso, nomeEnvolvido } for a process identifier like "PRO.0001417"
  async getProcessDetails(identificador, token) {
    const t = token || await this.getToken();
    const data = await this._apiRequest('POST', '/processo/consulta?pagina=0&quan-registros=1',
      { identificador }, t);
    const p = (data.processoConsultaResumoWs || [])[0];
    if (!p) throw new Error(`Process not found: ${identificador}`);
    return { codigoProcesso: p.codigoProcesso, nomeEnvolvido: p.nomeEnvolvido, nomeCliente: p.nomeCliente };
  }

  // ── Document Upload ─────────────────────────────────────────────────────────

  // processIdentifier = "PRO.0001417", taskEventId = "47848352"
  async uploadDocument({ processIdentifier, taskEventId, filePath, fileName, descricao = 'Gerado pelo Sistema FCAdv' }) {
    const token = await this.getToken();

    const { codigoProcesso } = await this.getProcessDetails(processIdentifier, token);

    const fileBuffer = fs.readFileSync(filePath);
    const name = (fileName || path.basename(filePath)).replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c));
    const ext = path.extname(fileName || path.basename(filePath)).replace('.', '') || 'docx';
    const ts = Date.now();

    const modulosJson = JSON.stringify({
      modulos: [
        { modulo: 'PROCESSO', codigoRegistroVinculo: codigoProcesso, vinculoPrincipal: true, identificadorRegistroVinculo: null },
        ...(taskEventId ? [{ modulo: 'TAREFA_EVENTO', codigoRegistroVinculo: Number(taskEventId), vinculoPrincipal: false, identificadorRegistroVinculo: null }] : []),
      ],
    });

    const qs = `descricao-arquivo=${encodeURIComponent(descricao)}&arquivo-sigiloso=true&arquivo-privado=false&codigo-tipo-arquivo=545&time-data-marcacao=${ts}`;
    const uploadUrl = `https://service.projurisadv.com.br/adv-service/arquivo/lote?${qs}`;

    // Upload via logged-in Chromium session — requires Keycloak cookies + Bearer token
    const { chromium } = require('playwright');
    const browser = await chromium.launch(chromiumLaunchOptions());
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      // Login to get Keycloak session cookies
      await page.goto(`${BASE_URL}/home/tarefa`, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForSelector('input[type="password"], [class*="tarefa"], [class*="task"]', { timeout: 20000 }).catch(() => {});
      const loginEl = await page.$('input[type="password"]');
      if (loginEl) {
        for (const sel of ['input[name="username"]', '#username', 'input[type="email"]']) {
          const el = await page.$(sel);
          if (el) { await el.fill(process.env.PROJURIS_EMAIL); break; }
        }
        await loginEl.fill(process.env.PROJURIS_PASSWORD);
        for (const sel of ['button[type="submit"]', 'input[type="submit"]']) {
          const el = await page.$(sel);
          if (el) { await el.click(); break; }
        }
        await page.waitForTimeout(6000);
      }

      // Now do the upload matching the exact Angular app FormData structure
      const result = await page.evaluate(
        async ({ token, fileBase64, name, ext, fileSize, modulosJson, uploadUrl }) => {
          const fileBytes = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));
          // NO mime type on the file blob — matches Angular: new Blob([t]) with no type
          const fileBlob = new Blob([fileBytes]);

          const form = new FormData();
          // fileName must be a Blob with text/plain charset=UTF-8 — key difference!
          form.append('0:fileName', new Blob([name], { type: 'text/plain; charset=UTF-8' }));
          form.append('0:fileExtension', ext);
          form.append('0:fileSize', String(fileSize));
          // attachment appended WITHOUT filename argument — matches Angular
          form.append('0:attachment', fileBlob);

          // Modulos: fileName is Blob of "modulos_vinculo", extension is "application/json",
          // NO fileSize, attachment is plain JSON string (not Blob)
          form.append('1:fileName', new Blob(['modulos_vinculo'], { type: 'text/plain; charset=UTF-8' }));
          form.append('1:fileExtension', 'application/json');
          form.append('1:attachment', modulosJson);

          const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/json, text/plain, */*',
            },
            body: form,
          });
          const body = await res.text();
          return { status: res.status, body };
        },
        {
          token,
          fileBase64: fileBuffer.toString('base64'),
          name,
          ext,
          fileSize: fileBuffer.length,
          modulosJson,
          uploadUrl,
        },
      );

      if (result.status >= 400) throw new Error(`HTTP ${result.status}: ${result.body.slice(0, 500)}`);
      try { return JSON.parse(result.body); } catch { return result.body; }
    } finally {
      await browser.close();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _normalizeTask(t) {
    return {
      id: String(t.codigoTarefaEvento),
      tipo: t.nomeTarefaTipo || '',
      status: (t.nomeSituacao || 'Pendente').toLowerCase().replace('ê', 'e'),
      cliente: (t.clientes || [])[0] || '',
      processo: t.identificadorModulo || '',          // PRO.0002662
      processoNumero: t.numeroProcesso || '',          // 1114077-93.2023.8.26.0100
      descricao: t.descricao || '',
      prazo: t.dataPrevista ? new Date(t.dataPrevista).toLocaleDateString('pt-BR') : '',
      prazoFatal: t.dataFatal ? new Date(t.dataFatal).toLocaleDateString('pt-BR') : '',
      urgente: t.dataFatal ? (t.dataFatal - Date.now()) < 86400000 : false,  // < 24h
      responsaveis: (t.responsaveis || []).map(r => r.nomeCompleto),
      cor: t.corTarefaTipo || '#FF9800',
      raw: t,
    };
  }

  async _findUser(nome, token) {
    if (!nome) return null;
    try {
      const data = await this._rawRequest('GET', `${API_ROOT}/usuario?nome=${encodeURIComponent(nome)}`, null, {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
      });
      const list = (typeof data === 'string' ? JSON.parse(data) : data)?.simpleDto || [];
      // Find best match (case-insensitive, first name or full name)
      const needle = nome.toLowerCase();
      const match = list.find(u => u.valor?.toLowerCase().includes(needle))
                 || list.find(u => needle.split(' ').some(w => u.valor?.toLowerCase().includes(w)));
      return match || null; // already { chave, valor }
    } catch { return null; }
  }

  async _apiRequest(method, path, body, token) {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    return this._rawRequest(method, `${API_BASE}${path}`, body ? JSON.stringify(body) : null, headers);
  }

  // Like _apiRequest but hits API_ROOT (no /v2/) with JSON body
  async _rawRequestJson(method, url, body, token) {
    return this._rawRequest(method, url, JSON.stringify(body), {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://app.projurisadv.com.br',
    });
  }

  _rawRequest(method, url, body, headers = {}) {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;

    if (bodyBuf && !headers['Content-Length']) {
      headers['Content-Length'] = bodyBuf.length;
    }

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            else resolve(parsed);
          } catch {
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            else resolve(raw);
          }
        });
      });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }
}

module.exports = ProjurisClient;
