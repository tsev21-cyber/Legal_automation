require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const Orchestrator = require('./src/orchestrator');
const orchestrator = new Orchestrator();

const app = express();
app.use(express.json());
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
