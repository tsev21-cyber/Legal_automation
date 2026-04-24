const Anthropic = require('@anthropic-ai/sdk');
const { getPrompt } = require('../../config/prompts');

class ClaudeAgent {
  constructor({ apiKey } = {}) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
  }

  // Build prompt from real Projuris + e-SAJ + Drive data
  buildPrompt({ task, processDetails, downloadedDocs, styleExamples }) {
    const hoje = new Date().toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'long', year: 'numeric'
    });

    const tipo = (task.tipoTarefa || task.tipo || '').toLowerCase();
    const partes = processDetails?.partes || {};
    const exequente = partes.exequente || partes.autor || task.cliente || 'Exequente';
    const executado = partes.executado || partes.reu || task.devedor || 'Executado';
    const processo = processDetails?.numero || task.processoVinculado || task.processo || '';
    const valor = processDetails?.valorCausa || task.valor || '';
    const tribunal = processDetails?.vara || task.tribunal || 'TJSP';
    const descricao = task.descricao || '';

    // Style reference block (2-3 Drive examples)
    let styleBlock = '';
    if (styleExamples && styleExamples.length > 0) {
      styleBlock = `\n\nEXEMPLOS DE PEÇAS FCAdv PARA REFERÊNCIA DE ESTILO (adapte, não copie):
${styleExamples.map((e, i) => `--- Exemplo ${i + 1}: ${e.name} ---\n${e.text}`).join('\n\n')}`;
    }

    // Downloaded document content block
    let docBlock = '';
    if (downloadedDocs && downloadedDocs.length > 0) {
      docBlock = `\n\nDOCUMENTOS DO PROCESSO BAIXADOS DO e-SAJ:
${downloadedDocs.map(d => `[${d.label}]: ${d.textContent || '(PDF - ver referência)'}`).join('\n')}`;
    }

    if (tipo.includes('agravo')) {
      return `Elabore um AGRAVO DE INSTRUMENTO para o seguinte processo:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Descrição/Contexto: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore o agravo de instrumento completo no padrão FCAdv (art. 1.015 do CPC).
Estrutura: Cabimento do agravo → Síntese dos fatos → Decisão agravada → Razões do recurso → Pedido de efeito suspensivo/ativo (se aplicável) → Pedido de provimento.
Requeira a reforma integral da decisão agravada.`;
    }

    if (tipo.includes('impugna')) {
      return `Elabore uma IMPUGNAÇÃO AO CUMPRIMENTO DE SENTENÇA para o seguinte processo:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Descrição/Contexto: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore a impugnação completa no padrão FCAdv (art. 525 do CPC).
Analise o cálculo apresentado, aponte eventuais excessos, e formule os pedidos de forma numerada.`;
    }

    if (tipo.includes('embargo')) {
      return `Elabore EMBARGOS DE DECLARAÇÃO para o seguinte processo:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Descrição/Contexto: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore os embargos de declaração completos no padrão FCAdv (art. 1.022 do CPC).
Aponte com precisão os vícios da decisão embargada (omissão, contradição, obscuridade ou erro material).
Requeira o saneamento dos vícios e, se cabível, o efeito modificativo.`;
    }

    if (tipo.includes('recurso')) {
      return `Elabore um RECURSO INOMINADO para o seguinte processo:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Descrição da tarefa: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore o recurso completo no padrão FCAdv, atacando os fundamentos da decisão agravada e requerendo reforma.`;
    }

    if (tipo.includes('contrar')) {
      return `Elabore CONTRARRAZÕES ao recurso interposto pelo executado:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Descrição da tarefa: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore as contrarrazões completas no padrão FCAdv, refutando ponto a ponto os argumentos do recorrente.`;
    }

    // Default: petição / petição complexa / informações
    return `Elabore uma PETIÇÃO para o seguinte processo:

DADOS DO PROCESSO:
- Número: ${processo}
- Tribunal: ${tribunal}
- Exequente: ${exequente}
- Executado: ${executado}
- Valor em execução: ${valor}
- Tipo de tarefa: ${task.tipoTarefa || task.tipo}
- Descrição: ${descricao}
${docBlock}${styleBlock}

DATA: ${hoje}

Elabore a petição completa no padrão FCAdv.`;
  }

  // Generate with streaming — calls onChunk(text) for each token
  async generateStreaming({ task, processDetails, downloadedDocs, styleExamples, onChunk }) {
    const userPrompt = this.buildPrompt({ task, processDetails, downloadedDocs, styleExamples });
    const systemPrompt = getPrompt(task.tipoTarefa || task.tipo || '');
    let fullText = '';

    const stream = this.client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        fullText += text;
        if (onChunk) onChunk(text);
      }
    }

    return fullText;
  }

  // Generate without streaming (for background/batch use)
  async generate({ task, processDetails, downloadedDocs, styleExamples }) {
    const userPrompt = this.buildPrompt({ task, processDetails, downloadedDocs, styleExamples });
    const systemPrompt = getPrompt(task.tipoTarefa || task.tipo || '');

    const response = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return response.content[0].text;
  }
}

module.exports = ClaudeAgent;
