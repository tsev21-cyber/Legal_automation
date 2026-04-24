// Configurable reviewer list — update when lawyers join or leave the firm
// Used as fallback when task description does not specify a reviewer

const defaultList = (process.env.REVIEWER_DEFAULT_LIST || 'Fernando Cota,Rodrigo')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

// Parse reviewer name from task description
// Fernando's rule: if description says who should do revision, use that person
function parseReviewer(descricao = '') {
  // Match keyword then optional filler words then a Capitalized Name
  const NAME = '([A-ZÁÀÂÃÉÈÊÍÎÓÔÕÚÛÇ][a-záàâãéèêíîóôõúûç]+(?:\\s+[A-ZÁÀÂÃÉÈÊÍÎÓÔÕÚÛÇ][a-záàâãéèêíîóôõúûç]+)*)';
  // Optional Portuguese/English article before name: o, a, os, as, the
  const ART = '(?:o|a|os|as|the)\\s+';
  const PREP = '(?:para|to|for|de|do|da|em)\\s+';
  const patterns = [
    new RegExp(`(?:revis[ãa]o|revision|revisar)[\\s:]+(?:${PREP})?(?:${ART})?${NAME}`, 'i'),
    new RegExp(`(?:enviar?|mandar?|put|colocar?)[\\s\\w]{0,20}(?:${PREP})(?:${ART})?${NAME}`, 'i'),
    new RegExp(`(?:responsável|responsible|assign(?:ar)?)[\\s:]+(?:${PREP})?(?:${ART})?${NAME}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = descricao.match(pattern);
    if (match) {
      const name = match[1].trim();
      const stopWords = ['para', 'tarefa', 'revisão', 'advogado', 'for', 'the'];
      if (!stopWords.includes(name.toLowerCase())) return name;
    }
  }

  return null; // not found in description
}

// Get reviewer: from description, or random from default list
function getReviewer(descricao = '') {
  const fromDesc = parseReviewer(descricao);
  if (fromDesc) {
    console.log(`📋 Reviewer from description: ${fromDesc}`);
    return fromDesc;
  }

  const random = defaultList[Math.floor(Math.random() * defaultList.length)];
  console.log(`📋 Reviewer assigned randomly: ${random}`);
  return random;
}

module.exports = { getReviewer, parseReviewer, defaultList };
