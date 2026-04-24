const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  BorderStyle, UnderlineType, convertInchesToTwip, LevelFormat,
  TableOfContents, Header, Footer, PageNumber
} = require('docx');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Strip markdown symbols Claude might still emit
function cleanMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^[-*]{3,}\s*$/gm, '')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

// Classify each line for formatting
function classifyLine(line) {
  const t = line.trim();
  if (!t) return 'empty';
  if (/^EXCELENTÍSSIMO|^ILUSTRÍSSIMO|^AO JUÍZO|^EXMO\./i.test(t)) return 'court-header';
  if (/^(DOS |DA |DO |AO )(FATOS|DIREITO|PEDIDOS|MÉRITO|PRELIMINAR|FUNDAMENTO)/i.test(t)) return 'section';
  if (/^(Processo|Proc\.|Autos)/i.test(t)) return 'process-ref';
  if (/^(Termos em que|Nestes termos|E. deferimento|Pede deferimento)/i.test(t)) return 'fecho';
  if (/^(São Paulo,|SP,\s*\d)/i.test(t)) return 'date';
  if (/^(Fernando Cota|OAB\/SP)/i.test(t)) return 'signature';
  if (/^\d+\.\s/.test(t)) return 'numbered';
  return 'body';
}

// Build a styled Paragraph based on line classification
function buildParagraph(line, type) {
  const t = line.trim();

  const BASE = { font: 'Verdana', size: 22 }; // Verdana 11pt — FCAdv standard

  if (type === 'empty') {
    return new Paragraph({ spacing: { after: 0, before: 0 }, children: [new TextRun('')] });
  }

  if (type === 'court-header') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
      children: [new TextRun({ ...BASE, text: t, bold: true, allCaps: true })]
    });
  }

  if (type === 'section') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 360, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2B4C9B', space: 4 } },
      children: [new TextRun({ ...BASE, text: t, bold: true, allCaps: true, color: '1a1a1a' })]
    });
  }

  if (type === 'process-ref') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ ...BASE, text: t, bold: true })]
    });
  }

  if (type === 'fecho') {
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 360, after: 120 },
      children: [new TextRun({ ...BASE, text: t })]
    });
  }

  if (type === 'date') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, after: 120 },
      children: [new TextRun({ ...BASE, text: t })]
    });
  }

  if (type === 'signature') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ ...BASE, text: t, bold: true })]
    });
  }

  if (type === 'numbered') {
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 80, after: 80, line: 360 },
      indent: { left: convertInchesToTwip(0.4), hanging: convertInchesToTwip(0.4) },
      children: [new TextRun({ ...BASE, text: t })]
    });
  }

  // Default body paragraph — 3cm first-line indent (Brazilian legal standard)
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 0, after: 120, line: 360 },
    indent: { firstLine: convertInchesToTwip(1.18) },
    children: [new TextRun({ ...BASE, text: t })]
  });
}

async function generateDocx({ text, task, outputDir }) {
  const dir = outputDir || os.tmpdir();
  const processo = (task.processoVinculado || task.processo || 'processo').replace(/[^0-9]/g, '').slice(0, 15);
  const tipo = (task.tipoTarefa || task.tipo || 'Peticao').replace(/\s+/g, '_').slice(0, 30);
  const filename = `${tipo}_${processo}_${Date.now()}.docx`;
  const filePath = path.join(dir, filename);

  const clean = cleanMarkdown(text);
  const lines = clean.split('\n');

  // Letterhead — left-aligned (FCAdv standard: timbre à esquerda)
  const letterhead = [
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 0, after: 0 },
      border: { bottom: { style: BorderStyle.THICK, size: 12, color: '2B4C9B', space: 4 } },
      children: [
        new TextRun({ text: 'FERNANDO COTA', font: 'Verdana', size: 26, bold: true, color: '2B4C9B' }),
      ]
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 0, after: 480 },
      border: { bottom: { style: BorderStyle.THICK, size: 4, color: '2B4C9B', space: 8 } },
      children: [
        new TextRun({ text: 'Advocacia e Consultoria Jurídica', font: 'Verdana', size: 16, color: '555555', italics: true }),
      ]
    }),
  ];

  // Process number line (top right) — prefer CNJ number over Projuris ID
  const processoNumero = task.processoNumero || task.processoVinculado || task.processo || '';
  const processRef = new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 0, after: 360 },
    children: [
      new TextRun({
        text: `Processo nº ${processoNumero}`,
        font: 'Arial', size: 18, color: '888888',
      })
    ]
  });

  // Body paragraphs
  const bodyParagraphs = lines.map(line => {
    const type = classifyLine(line);
    return buildParagraph(line, type);
  });


  const doc = new Document({
    creator: 'FCAdv – Sistema de Automação',
    title: `${task.tipoTarefa || task.tipo} – ${task.processoVinculado || task.processo || ''}`,
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: 360 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          // Brazilian court margins: 3cm top/left, 2cm right/bottom
          margin: {
            top: convertInchesToTwip(1.18),
            left: convertInchesToTwip(1.18),
            right: convertInchesToTwip(0.79),
            bottom: convertInchesToTwip(0.79),
          }
        }
      },
      children: [
        ...letterhead,
        processRef,
        ...bodyParagraphs,
      ]
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return { filePath, filename };
}

module.exports = { generateDocx };
