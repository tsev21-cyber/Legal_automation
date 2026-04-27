require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const Orchestrator = require('./src/orchestrator');
const orchestrator = new Orchestrator();
const projectStore = require('./src/projects/store');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-side task cache — populated on first /api/tasks call
let taskCache = new Map();

// --- API Routes --------------------------------------------------------------

app.get('/api/tasks', async (_req, res) => {
  try {
    const tasks = await orchestrator.getTaskQueue();
    taskCache = new Map(tasks.map(t => [t.id, t]));
    res.json(tasks);
  } catch (err) {
    console.error('getTasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  if (taskCache.has(req.params.id)) {
    return res.json(taskCache.get(req.params.id));
  }
  try {
    const task = await orchestrator.api.getTask(req.params.id);
    taskCache.set(task.id, task);
    res.json(task);
  } catch (err) {
    console.error('getTask error:', err.message);
    res.status(404).json({ error: 'Tarefa não encontrada' });
  }
});

// SSE: stream petition generation
app.get('/api/generate/:taskId', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await orchestrator.processTask(req.params.taskId, {
      onProgress: msg => send({ type: 'progress', message: msg }),
      onChunk: text => send({ type: 'text', text }),
      task: taskCache.get(req.params.taskId) || null,
    });
    send({ type: 'done', taskId: req.params.taskId, docxFilename: result.docxFilename });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

// Download .docx
app.get('/api/download/:taskId', async (req, res) => {
  const task = taskCache.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada no cache. Recarregue a lista.' });

  // Find most recent docx for this process in output dir
  const OUTPUT_DIR = path.join(__dirname, 'output');
  const processoDigits = (task.processoNumero || task.processo || '').replace(/\D/g, '').slice(0, 10);
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.docx') && (!processoDigits || f.includes(processoDigits)))
    .map(f => ({ f, t: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  if (!files.length) return res.status(404).json({ error: 'Nenhum .docx encontrado. Gere primeiro.' });

  const filePath = path.join(OUTPUT_DIR, files[0].f);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${files[0].f}"`);
  res.send(fs.readFileSync(filePath));
});

// Debug route
app.get('/api/debug/projuris', async (_req, res) => {
  try {
    const { debugProjuris } = require('./src/projuris/debug');
    const result = await debugProjuris();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/output', express.static(path.join(__dirname, 'output')));

// ── Text extraction (for projects file attach) ────────────────────────────────

// Shared text extraction helper
async function extractText(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'txt') return buffer.toString('utf8').trim();
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text.trim();
  }
  throw new Error(`Formato .${ext} não suportado. Use .txt, .docx ou .pdf`);
}

const rawUpload = express.raw({ type: 'application/octet-stream', limit: '50mb' });

// ── Project file upload/delete/preview ────────────────────────────────────────

app.post('/api/projects/:id/files', rawUpload, async (req, res) => {
  const filename = req.query.filename || '';
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  try {
    const text = await extractText(buffer, filename);
    const meta = projectStore.addFile(req.params.id, { name: filename, text });
    res.status(201).json(meta);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/projects/:id/files/:fileId', (req, res) => {
  try {
    projectStore.removeFile(req.params.id, req.params.fileId);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/projects/:id/files/:fileId/text', (req, res) => {
  try {
    const text = projectStore.getFileText(req.params.id, req.params.fileId);
    res.json({ text });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Projects CRUD ─────────────────────────────────────────────────────────────

app.get('/api/projects', (_req, res) => {
  res.json(projectStore.getAll());
});

app.get('/api/projects/:id', (req, res) => {
  const p = projectStore.getById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projeto não encontrado' });
  res.json(p);
});

app.post('/api/projects', (req, res) => {
  try {
    res.status(201).json(projectStore.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    res.json(projectStore.update(req.params.id, req.body));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    projectStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Start Server ------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n✅ FCAdv rodando em http://localhost:${PORT}\n`);
  try {
    const tasks = await orchestrator.getTaskQueue();
    taskCache = new Map(tasks.map(t => [t.id, t]));
    console.log(`📋 ${tasks.length} tarefas carregadas do Projuris`);
  } catch (err) {
    console.warn('⚠️  Projuris pre-load failed:', err.message);
  }
});
