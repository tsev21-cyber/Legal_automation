const fs = require('fs');
const path = require('path');

const PROJECTS_FILE = path.join(__dirname, '../../config/projects.json');

// Metadata for initial migration — prompts are pulled from config/prompts.js
const INITIAL_META = [
  { id: 'agravo',              name: 'Agravo de Instrumento',               keywords: ['agravo de instrumento', 'agravo'], order: 1 },
  { id: 'agravo_interno',      name: 'Agravo Interno / Regimental',          keywords: ['agravo interno', 'regimental'], order: 2 },
  { id: 'analise',             name: 'Análise Processual',                   keywords: ['análise', 'analise', 'anális'], order: 3 },
  { id: 'apelacao',            name: 'Apelação Cível',                       keywords: ['apelação', 'apelacao'], order: 4 },
  { id: 'contrarrazoes',       name: 'Contrarrazões de Apelação',            keywords: ['contrarrazões', 'contrarrazoes', 'contrar'], order: 5 },
  { id: 'convalidacao',        name: 'Convalidação de Intimação',            keywords: ['convalid', 'convalidação', 'intimaç', 'intimac'], order: 6 },
  { id: 'embargos_declaracao', name: 'Embargos de Declaração',               keywords: ['embargos de declaração', 'embargos declaração', 'embargos de declaracao', 'embargos declaracao'], order: 7 },
  { id: 'embargos_execucao',   name: 'Embargos à Execução / Impugnação',     keywords: ['embargos à execução', 'embargos execução', 'impugnação aos embargos', 'impugnacao aos embargos', 'impugnação', 'impugnacao'], order: 8 },
  { id: 'embargos_terceiro',   name: 'Embargos de Terceiro',                 keywords: ['embargos de terceiro', 'embargo de terceiro'], order: 9 },
  { id: 'investigacao',        name: 'Investigação Patrimonial / IDPJ',      keywords: ['investigação', 'investigacao', 'investig', 'idpj'], order: 10 },
  { id: 'memoriais',           name: 'Memoriais / Alegações Finais',         keywords: ['memorial', 'memoriais', 'alegações finais', 'alegacoes finais', 'alegaç', 'alegac'], order: 11 },
  { id: 'penhora',             name: 'Penhora / SISBAJUD',                   keywords: ['penhora', 'sisbajud'], order: 12 },
  { id: 'peticao_estrategica', name: 'Petição Estratégica (Regulatório)',    keywords: ['sisflora', 'ambiental', 'regulat'], order: 13 },
  { id: 'polo_passivo',        name: 'Polo Passivo + Arresto Cautelar',      keywords: ['polo passivo', 'empresa individual', 'arresto cautelar'], order: 14 },
  { id: 'renajud',             name: 'RENAJUD / Penhora de Veículos',        keywords: ['renajud'], order: 15 },
  { id: 'revisao_processo',    name: 'Revisão de Processo',                  keywords: ['revisão de processo', 'revisao de processo'], order: 16 },
  { id: 'peticao',             name: 'Petição (padrão)',                     keywords: [], order: 17 },
];

function _load() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function _save(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function _migrate() {
  console.log('📂 Gerando projects.json a partir de config/prompts.js...');
  const { PROMPTS } = require('../../config/prompts');
  const projects = INITIAL_META.map(meta => ({
    id: meta.id,
    name: meta.name,
    keywords: meta.keywords,
    order: meta.order,
    prompt: PROMPTS[meta.id] || PROMPTS.peticao,
  }));
  const data = { projects };
  _save(data);
  console.log(`✅ ${projects.length} projetos migrados para config/projects.json`);
  return data;
}

function _data() {
  return _load() || _migrate();
}

// ── Public API ─────────────────────────────────────────────────────────────

function getAll() {
  return _data().projects.sort((a, b) => (a.order || 99) - (b.order || 99));
}

function getById(id) {
  return _data().projects.find(p => p.id === id) || null;
}

function create(project) {
  const data = _data();
  if (!project.id || !project.name) throw new Error('id e name são obrigatórios');
  if (data.projects.find(p => p.id === project.id)) throw new Error(`ID "${project.id}" já existe`);
  const maxOrder = Math.max(0, ...data.projects.map(p => p.order || 0));
  const newProject = {
    id: project.id,
    name: project.name,
    keywords: project.keywords || [],
    order: maxOrder + 1,
    prompt: project.prompt || '',
  };
  data.projects.push(newProject);
  _save(data);
  return newProject;
}

function update(id, changes) {
  const data = _data();
  const idx = data.projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Projeto "${id}" não encontrado`);
  data.projects[idx] = { ...data.projects[idx], ...changes, id };
  _save(data);
  return data.projects[idx];
}

function remove(id) {
  const data = _data();
  const idx = data.projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Projeto "${id}" não encontrado`);
  data.projects.splice(idx, 1);
  _save(data);
}

// Returns the prompt text for a given Projuris task type string.
// Matches by keyword — longest keyword first (most specific wins).
function getPrompt(tipoTarefa = '') {
  const t = tipoTarefa.toLowerCase();
  const projects = _data().projects;

  const withKeywords = projects
    .filter(p => p.keywords && p.keywords.length > 0)
    .sort((a, b) => {
      const aMax = Math.max(...a.keywords.map(k => k.length));
      const bMax = Math.max(...b.keywords.map(k => k.length));
      return bMax - aMax;
    });

  for (const project of withKeywords) {
    for (const kw of project.keywords) {
      if (t.includes(kw.toLowerCase())) return project.prompt;
    }
  }

  const def = projects.find(p => p.id === 'peticao');
  return def ? def.prompt : '';
}

// ── File management ────────────────────────────────────────────────────────

const FILES_DIR = path.join(__dirname, '../../config/project-files');

function _filesDir(projectId) {
  const dir = path.join(FILES_DIR, projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function addFile(projectId, { name, text }) {
  const data = _data();
  const idx = data.projects.findIndex(p => p.id === projectId);
  if (idx === -1) throw new Error(`Projeto "${projectId}" não encontrado`);
  const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(_filesDir(projectId), `${fileId}.txt`), text, 'utf8');
  const meta = { id: fileId, name, chars: text.length, uploadedAt: new Date().toISOString() };
  if (!data.projects[idx].files) data.projects[idx].files = [];
  data.projects[idx].files.push(meta);
  _save(data);
  return meta;
}

function removeFile(projectId, fileId) {
  const data = _data();
  const idx = data.projects.findIndex(p => p.id === projectId);
  if (idx === -1) throw new Error(`Projeto "${projectId}" não encontrado`);
  const fIdx = (data.projects[idx].files || []).findIndex(f => f.id === fileId);
  if (fIdx === -1) throw new Error(`Arquivo "${fileId}" não encontrado`);
  const fp = path.join(FILES_DIR, projectId, `${fileId}.txt`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  data.projects[idx].files.splice(fIdx, 1);
  _save(data);
}

function getFileText(projectId, fileId) {
  const fp = path.join(FILES_DIR, projectId, `${fileId}.txt`);
  if (!fs.existsSync(fp)) throw new Error('Arquivo não encontrado');
  return fs.readFileSync(fp, 'utf8');
}

// Returns { name, text }[] for the project matching the given task type
function getStyleExamplesForTask(tipoTarefa = '') {
  const t = tipoTarefa.toLowerCase();
  const projects = _data().projects;
  const sorted = projects
    .filter(p => p.keywords && p.keywords.length > 0)
    .sort((a, b) => Math.max(...b.keywords.map(k => k.length)) - Math.max(...a.keywords.map(k => k.length)));
  let matched = null;
  for (const p of sorted) {
    if (p.keywords.some(kw => t.includes(kw.toLowerCase()))) { matched = p; break; }
  }
  if (!matched) matched = projects.find(p => p.id === 'peticao');
  if (!matched || !matched.files || !matched.files.length) return [];
  return matched.files.map(f => {
    try { return { name: f.name, text: getFileText(matched.id, f.id) }; } catch { return null; }
  }).filter(Boolean);
}

module.exports = { getAll, getById, create, update, remove, getPrompt, addFile, removeFile, getFileText, getStyleExamplesForTask };
