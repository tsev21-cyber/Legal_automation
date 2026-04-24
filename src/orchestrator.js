const ProjurisClient = require('./projuris/client');
const EsajScraper = require('./esaj/scraper');
const DriveClient = require('./drive/client');
const ClaudeAgent = require('./claude/agent');
const { generateDocx } = require('./document/generator');
const { getReviewer } = require('../config/reviewers');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '../output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const PROCESSED_FILE = path.join(__dirname, '../.processed-tasks.json');
function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveProcessed(set) {
  try { fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set])); } catch { /* ignore */ }
}

const GENERATABLE_TYPES = [
  'petição', 'peticao', 'recurso', 'agravo', 'embargos', 'contrarrazões',
  'contrarrazoes', 'impugnação', 'impugnacao', 'réplica', 'replica',
  'penhora', 'apelação', 'apelacao', 'memorial', 'alegações', 'investigação',
];

class Orchestrator {
  constructor() {
    this.api = new ProjurisClient();
    this.esaj = null;
    this.drive = null;
    this.claude = new ClaudeAgent();
    this._driveEnabled = !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_FOLDER_ID);
    this._esajManual = process.env.ESAJ_MANUAL === 'true';
    this._processing = new Set();
    this._processedTasks = loadProcessed(); // persist Revisão-created task IDs across restarts
    console.log('✅ Orchestrator initialized');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async getTaskQueue() {
    return this.api.getTasks();
  }

  // Full automated flow for one task (by task ID)
  // Pass preloadedTask to skip the re-fetch (Projuris has no single-task GET endpoint)
  async processTask(taskId, { onProgress, onChunk, task: preloadedTask } = {}) {
    const log = msg => { console.log(msg); if (onProgress) onProgress(msg); };

    if (this._processing.has(String(taskId))) {
      throw new Error(`Task ${taskId} is already being processed`);
    }
    this._processing.add(String(taskId));

    try {
    let task = preloadedTask;
    if (!task) {
      log(`🔍 Fetching task ${taskId}...`);
      const all = await this.api.getTasks({ pageSize: 100 });
      task = all.find(t => t.id === String(taskId));
      if (!task) throw new Error(`Task ${taskId} not found in queue`);
    }

    if (!this._isGeneratable(task)) {
      throw new Error(`Task type "${task.tipo}" is not configured for auto-generation`);
    }

    log(`📋 Task: ${task.tipo} — ${task.processo}`);

    // Parse reviewer from description
    const reviewer = getReviewer(task.descricao || task.fullText || '');

    // Fetch Drive style examples
    let styleExamples = [];
    if (this._driveEnabled) {
      log(`📂 Fetching style examples from Google Drive...`);
      try {
        if (!this.drive) this.drive = new DriveClient();
        styleExamples = await this.drive.getStyleExamples(task.tipo);
        log(`✅ ${styleExamples.length} style examples from Drive`);
      } catch (e) { log(`⚠️  Drive: ${e.message}`); }
    }

    // Download e-SAJ docs (skip if manual mode)
    let downloadedDocs = [];
    if (!this._esajManual && task.processoNumero) {
      log(`📥 Downloading from e-SAJ...`);
      try {
        if (!this.esaj) this.esaj = new EsajScraper();
        downloadedDocs = await this.esaj.downloadRelevantDocs(task.processoNumero);
        log(`✅ ${downloadedDocs.length} docs from e-SAJ`);
      } catch (e) { log(`⚠️  e-SAJ: ${e.message}`); }
    }

    // Generate with Claude
    log(`✨ Claude generating petition...`);
    let fullText = '';
    fullText = await this.claude.generateStreaming({
      task,
      processDetails: { numero: task.processoNumero || task.processo, vara: task.tribunal },
      downloadedDocs,
      styleExamples,
      onChunk,
    });
    log(`✅ ${fullText.length} chars generated`);

    // Build .docx
    log(`📄 Building .docx...`);
    const { filePath, filename } = await generateDocx({
      text: fullText,
      task: { tipoTarefa: task.tipo, processoVinculado: task.processo, ...task },
      outputDir: OUTPUT_DIR,
    });
    log(`✅ ${filename}`);

    // Upload to Projuris
    if (task.processo) {
      log(`⬆️  Uploading to Projuris...`);
      try {
        await this.api.uploadDocument({ processIdentifier: task.processo, taskEventId: task.id, filePath, fileName: filename });
        log(`✅ Uploaded`);
      } catch (e) { log(`⚠️  Upload: ${e.message}`); }
    }

    // Create Revisão task — skip if already created for this task ID
    if (this._processedTasks.has(String(taskId))) {
      log(`⏭️  Revisão already created for task ${taskId} — skipping`);
    } else {
      log(`📝 Creating Revisão task → ${reviewer}...`);
      try {
        await this.api.createRevisaoTask({
          processIdentifier: task.processo,
          taskEventId: task.id,
          responsavelNome: reviewer,
          prazoFatal: task.raw?.dataFatal || null,
        });
        this._processedTasks.add(String(taskId));
        saveProcessed(this._processedTasks);
        log(`✅ Revisão task created for ${reviewer}`);
      } catch (e) { log(`⚠️  Revisão task: ${e.message}`); }
    }

    this._processing.delete(String(taskId));
    return { petitionText: fullText, docxPath: filePath, docxFilename: filename, reviewer };
    } catch (err) {
      this._processing.delete(String(taskId));
      throw err;
    }
  }

  _isGeneratable(task) {
    const tipo = (task.tipo || task.tipoTarefa || '').toLowerCase();
    return GENERATABLE_TYPES.some(t => tipo.includes(t));
  }

  async shutdown() {
    if (this.esaj) await this.esaj.close();
  }
}

module.exports = Orchestrator;
