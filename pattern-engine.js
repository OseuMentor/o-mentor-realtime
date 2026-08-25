/**
 * pattern-engine.js
 * ------------------------------------------------------------------
 * Motor de detecção de padrões para o módulo de Cores do O Mentor.
 *
 * Entrada: `history` — array de resultados no formato produzido pelo
 * double-worker.js: [{ number, color, timestamp }], ordenado do mais
 * ANTIGO para o mais RECENTE (history[history.length - 1] = última casa).
 *
 * Saída de analyzeAll(history):
 * {
 *   strategies: [
 *     {
 *       id, name, category,
 *       status: 'aguardando' | 'formando' | 'disparou',
 *       entryColor: 'red' | 'black' | null,
 *       detail: string,              // texto curto pra exibir na UI
 *       casasRestantes: number|null  // só pras estratégias de contagem
 *     }, ...
 *   ],
 *   confluence: {
 *     color: 'red' | 'black' | null,
 *     count: number,
 *     strategies: [ids das estratégias apontando pra essa cor]
 *   }
 * }
 *
 * IMPORTANTE — leia antes de usar em produção:
 * Esta é a v1 da lógica, escrita a partir da leitura dos prints e das
 * suas descrições. As estratégias determinísticas (padrão fixo, sem
 * ambiguidade) tendem a estar certas. As marcadas com "// HEURÍSTICA"
 * abaixo (Xadrez Informal, Next Xadrez, Fechamento de Padrão) exigem
 * validação contra dados reais no TipMiner antes de confiar 100% —
 * a interpretação de "onde exatamente a alternância quebra" ou "o que
 * conta como tendência favorável" tem mais de uma leitura possível.
 *
 * Limitação conhecida: limites de frequência (ex. Number 3 = até 2
 * entradas/hora, início + a partir do minuto 30) NÃO são calculados
 * aqui, porque exigem estado persistente entre chamadas (quando foi a
 * última entrada dada). Isso deve ser resolvido no realtime-gateway.js
 * com um pequeno registro em memória (ou N8N) de "última entrada por
 * estratégia", e cruzado com o resultado desta função antes de emitir
 * o alerta pro usuário.
 *
 * CORREÇÃO (19/jul/2026): as estratégias de contagem (Number 3, Number 5,
 * 2Five) ficavam marcadas como "disparou" para sempre depois que a
 * contagem passava do ponto certo, mesmo sem nenhum gatilho novo. Agora
 * "disparou" só vale exatamente no momento em que a contagem se
 * completa; depois disso, se não sair um gatilho novo, o status volta
 * pra "aguardando" (o gatilho antigo expira).
 * ------------------------------------------------------------------
 */

function colorOf(n) {
  if (n === 0) return 'white';
  if (n >= 1 && n <= 7) return 'red';
  return 'black';
}

function opposite(color) {
  return color === 'red' ? 'black' : color === 'black' ? 'red' : null;
}

function last(history, n = 1) {
  return history.slice(Math.max(0, history.length - n));
}

// Encontra o índice (na history) da ocorrência MAIS RECENTE que satisfaz `test`.
// Como o buffer é recalculado do zero a cada chamada, isso já resolve
// naturalmente as regras de "reseta se acontecer de novo".
function lastIndexWhere(history, test) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (test(history[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------
// Estratégias de contagem numérica (Number 3, Number 5, 2Five)
// ---------------------------------------------------------------
function countingStrategy(history, { id, name, category, triggerTest, countLength, entryColor }) {
  const triggerIdx = lastIndexWhere(history, triggerTest);
  if (triggerIdx === -1) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Nenhum gatilho recente.', casasRestantes: null };
  }
  const casasContadas = (history.length - 1) - triggerIdx;
  if (casasContadas < countLength) {
    const restantes = countLength - casasContadas;
    return { id, name, category, status: 'formando', entryColor, detail: `Gatilho detectado. Faltam ${restantes} casa(s).`, casasRestantes: restantes };
  }
  if (casasContadas === countLength) {
    return { id, name, category, status: 'disparou', entryColor, detail: `Contagem completa. Entrada em ${entryColor === 'red' ? 'Vermelho' : 'Preto'} até sair.`, casasRestantes: 0 };
  }
  // Passou do ponto de contagem sem novo gatilho aparecer: expira.
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Gatilho expirado, aguardando novo.', casasRestantes: null };
}

// Number 3: cai o número 3 (Vermelho) -> conta 3 casas sem outro 3
// aparecer -> a partir daí, ESPERA o Preto cair de verdade (pode ser
// na 4a, 5a, 6a casa, etc -- não dispara sozinho só por completar a
// contagem). Different de Number 5/2Five, que disparam num ponto fixo
// de casas independente da cor.
function numberThree(history) {
  const id = 'number3', name = 'Number 3', category = 'Contagem numérica', entryColor = 'black';
  const triggerIdx = lastIndexWhere(history, r => r.number === 3);
  if (triggerIdx === -1) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Nenhum gatilho recente.', casasRestantes: null };
  }
  const casasContadas = (history.length - 1) - triggerIdx;
  if (casasContadas < 4) {
    const restantes = 4 - casasContadas;
    return { id, name, category, status: 'formando', entryColor, detail: `Gatilho detectado. Faltam ${restantes} casa(s) até checar o Preto.`, casasRestantes: restantes };
  }
  if (casasContadas === 4) {
    // Janela fechada: essa é a ÚNICA casa que decide o padrão (3 casas
    // de contagem + esta = 4 casas depois do gatilho, 5 no total
    // contando o próprio 3). Se for Preta, confirma o padrão e dispara
    // -- a entrada de verdade (com direito a G1/martingale) é resolvida
    // pelo sistema geral de acompanhamento, olhando a PRÓXIMA casa em
    // diante, igual a qualquer outra estratégia. Se não for Preta,
    // expira aqui mesmo, sem ficar esperando mais.
    const ultimaCasa = last(history, 1)[0];
    if (ultimaCasa.color === 'black') {
      return { id, name, category, status: 'disparou', entryColor, detail: 'Padrão confirmado (Preto na 4ª casa). Entrada em Preto até G1.', casasRestantes: 0 };
    }
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'A 4ª casa não foi Preta -- padrão expirado.', casasRestantes: null };
  }
  // casasContadas > 4: já passou da única janela de checagem (o
  // gatilho ficou "velho"), volta a aguardar um novo 3.
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Janela de checagem expirada, aguardando novo gatilho.', casasRestantes: null };
}

function numberFive(history) {
  return countingStrategy(history, {
    id: 'number5', name: 'Number 5', category: 'Contagem numérica',
    triggerTest: r => r.number === 5,
    countLength: 4,
    entryColor: 'red'
  });
}

function twoFive(history) {
  // Gatilho: dois 5 seguidos.
  let triggerIdx = -1;
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].number === 5 && history[i - 1].number === 5) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) {
    return { id: '2five', name: '2Five', category: 'Contagem numérica', status: 'aguardando', entryColor: null, detail: 'Nenhum gatilho recente.', casasRestantes: null };
  }
  const casasContadas = (history.length - 1) - triggerIdx;
  if (casasContadas < 4) {
    return { id: '2five', name: '2Five', category: 'Contagem numérica', status: 'formando', entryColor: 'red', detail: `Gatilho 5-5 detectado. Faltam ${4 - casasContadas} casa(s).`, casasRestantes: 4 - casasContadas };
  }
  if (casasContadas === 4) {
    return { id: '2five', name: '2Five', category: 'Contagem numérica', status: 'disparou', entryColor: 'red', detail: 'Contagem completa. Entrada em Vermelho.', casasRestantes: 0 };
  }
  // Passou do ponto de contagem sem novo gatilho 5-5 aparecer: expira.
  return { id: '2five', name: '2Five', category: 'Contagem numérica', status: 'aguardando', entryColor: null, detail: 'Gatilho expirado, aguardando novo.', casasRestantes: null };
}

// ---------------------------------------------------------------
// Alternância (Xadrez)
// ---------------------------------------------------------------
function xadrezFormal(history) {
  const h = last(history, 4);
  if (h.length < 4 || h.some(r => r.color === 'white')) {
    return { id: 'xadrezFormal', name: 'Xadrez (Padrão Formal)', category: 'Alternância', status: 'aguardando', entryColor: null, detail: 'Sem alternância formada.', casasRestantes: null };
  }
  const [a, b, c, d] = h.map(r => r.color);
  if (a === c && b === d && a !== b) {
    return { id: 'xadrezFormal', name: 'Xadrez (Padrão Formal)', category: 'Alternância', status: 'disparou', entryColor: a, detail: `4 alternâncias completas. Entrada em ${a === 'red' ? 'Vermelho' : 'Preto'}.`, casasRestantes: null };
  }
  // formando: checa alternância parcial nas últimas 2-3 casas
  const h3 = last(history, 3);
  if (h3.length === 3 && !h3.some(r => r.color === 'white')) {
    const [x, y, z] = h3.map(r => r.color);
    if (x === z && x !== y) {
      return { id: 'xadrezFormal', name: 'Xadrez (Padrão Formal)', category: 'Alternância', status: 'formando', entryColor: x, detail: 'Alternância parcial (3 casas). Falta 1 casa pra confirmar.', casasRestantes: 1 };
    }
  }
  return { id: 'xadrezFormal', name: 'Xadrez (Padrão Formal)', category: 'Alternância', status: 'aguardando', entryColor: null, detail: 'Sem alternância formada.', casasRestantes: null };
}

// Xadrez Informal (Vermelho): sequência fixa e determinística --
// Branco -> Preto -> Preto -> Vermelho -> Preto -> Vermelho -> dispara,
// entrada em Vermelho. Substituiu a versão antiga (heurística, tolerava
// variações) por uma sequência exata definida pelo usuário.
function xadrezInformalRed(history) {
  const id = 'xadrezInformalRed', name = 'Xadrez Informal (Vermelho)', category = 'Alternância';
  const seq = ['white', 'black', 'black', 'red', 'black', 'red'];
  const h = last(history, seq.length);
  if (h.length < seq.length) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const colors = h.map(r => r.color);
  const matches = colors.every((c, i) => c === seq[i]);
  if (matches) {
    return { id, name, category, status: 'disparou', entryColor: 'red', detail: 'Padrão Branco-Preto-Preto-Vermelho-Preto-Vermelho confirmado. Entrada em Vermelho.', casasRestantes: null };
  }
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// Xadrez Informal (Preto): espelho da versão Vermelho --
// Branco -> Vermelho -> Vermelho -> Preto -> Vermelho -> Preto -> dispara,
// entrada em Preto.
function xadrezInformalBlack(history) {
  const id = 'xadrezInformalBlack', name = 'Xadrez Informal (Preto)', category = 'Alternância';
  const seq = ['white', 'red', 'red', 'black', 'red', 'black'];
  const h = last(history, seq.length);
  if (h.length < seq.length) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const colors = h.map(r => r.color);
  const matches = colors.every((c, i) => c === seq[i]);
  if (matches) {
    return { id, name, category, status: 'disparou', entryColor: 'black', detail: 'Padrão Branco-Vermelho-Vermelho-Preto-Vermelho-Preto confirmado. Entrada em Preto.', casasRestantes: null };
  }
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// Next Xadrez (Vermelho): Vermelho -> Preto -> Branco -> Preto -> dispara,
// entrada em Vermelho.
function nextXadrezRed(history) {
  const id = 'nextXadrezRed', name = 'Next Xadrez (Vermelho)', category = 'Alternância';
  const h = last(history, 4);
  if (h.length < 4) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [a, b, w, b2] = h;
  if (a.color === 'red' && b.color === 'black' && w.color === 'white' && b2.color === 'black') {
    return { id, name, category, status: 'disparou', entryColor: 'red', detail: 'Padrão Vermelho-Preto-Branco-Preto confirmado. Entrada em Vermelho.', casasRestantes: null };
  }
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// Next Xadrez (Preto): Preto -> Vermelho -> Branco -> Vermelho -> dispara,
// entrada em Preto.
function nextXadrezBlack(history) {
  const id = 'nextXadrezBlack', name = 'Next Xadrez (Preto)', category = 'Alternância';
  const h = last(history, 4);
  if (h.length < 4) {
    return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [a, b, w, b2] = h;
  if (a.color === 'black' && b.color === 'red' && w.color === 'white' && b2.color === 'red') {
    return { id, name, category, status: 'disparou', entryColor: 'black', detail: 'Padrão Preto-Vermelho-Branco-Vermelho confirmado. Entrada em Preto.', casasRestantes: null };
  }
  return { id, name, category, status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// ---------------------------------------------------------------
// Padrões com Branco
// ---------------------------------------------------------------
// (Black/Red White foi removida a pedido -- não faz mais parte do
// motor de detecção.)

function nextColorWhite(history, color, id, name) {
  const h = last(history, 4);
  if (h.length < 4) {
    return { id, name, category: 'Padrões com Branco', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [a, b, w, c] = h;
  if (a.color === color && b.color === color && w.color === 'white' && c.color === color) {
    return { id, name, category: 'Padrões com Branco', status: 'disparou', entryColor: color, detail: `Padrão confirmado. Entrada em ${color === 'red' ? 'Vermelho' : 'Preto'}.`, casasRestantes: null };
  }
  return { id, name, category: 'Padrões com Branco', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

const nextBlack = h => nextColorWhite(h, 'black', 'nextBlack', 'Next Black');
const nextRed = h => nextColorWhite(h, 'red', 'nextRed', 'Next Red');

function nextDoubleWhite(history) {
  const h = last(history, 5);
  if (h.length < 5) {
    return { id: 'nextDoubleWhite', name: 'Next Double White', category: 'Padrões com Branco', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [w, a1, a2, b1, b2] = h;
  if (
    w.color === 'white' &&
    a1.color !== 'white' && a1.color === a2.color &&
    b1.color !== 'white' && b1.color === b2.color &&
    a1.color !== b1.color
  ) {
    return { id: 'nextDoubleWhite', name: 'Next Double White', category: 'Padrões com Branco', status: 'disparou', entryColor: a1.color, detail: `Branco-2A-2B confirmado. Entrada em ${a1.color === 'red' ? 'Vermelho' : 'Preto'} (cor A).`, casasRestantes: null };
  }
  return { id: 'nextDoubleWhite', name: 'Next Double White', category: 'Padrões com Branco', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// ---------------------------------------------------------------
// Repetição / Espelhamento
// ---------------------------------------------------------------
function blackDouble(history) {
  const h = last(history, 2);
  if (h.length < 2) {
    return { id: 'blackDouble', name: 'Black Double', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [a, b] = h;
  if (a.color === 'black' && b.color === 'black' && a.number === b.number) {
    return { id: 'blackDouble', name: 'Black Double', category: 'Repetição/Espelhamento', status: 'disparou', entryColor: 'red', detail: 'Dois pretos com mesmo número. Entrada em Vermelho.', casasRestantes: null };
  }
  if (b.color === 'black') {
    return { id: 'blackDouble', name: 'Black Double', category: 'Repetição/Espelhamento', status: 'formando', entryColor: 'red', detail: `Aguardando outro Preto ${b.number} pra confirmar.`, casasRestantes: 1 };
  }
  return { id: 'blackDouble', name: 'Black Double', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

function repeticaoEspelhamento(history) {
  const h = last(history, 4);
  if (h.length < 4) {
    return { id: 'repeticaoEspelhamento', name: 'Repetição (Espelhamento)', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const [a, p1, p2, p3] = h;
  const midOk = p2.color === 'black' && p2.number >= 10 && p2.number <= 14;
  if (a.color === 'red' && p1.color === 'black' && p1.number === 9 && midOk && p3.color === 'black' && p3.number === 9) {
    return { id: 'repeticaoEspelhamento', name: 'Repetição (Espelhamento)', category: 'Repetição/Espelhamento', status: 'disparou', entryColor: 'red', detail: 'Espelho V-P9-P(10-14)-P9 confirmado. Entrada em Vermelho.', casasRestantes: null };
  }
  return { id: 'repeticaoEspelhamento', name: 'Repetição (Espelhamento)', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

function padraoDePares(history) {
  const h = last(history, 3);
  if (h.length < 3) {
    return { id: 'padraoDePares', name: 'Padrão de Pares', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null };
  }
  const isEven = n => n !== 0 && n % 2 === 0;
  const [a, b, c] = h;
  if (a.color === 'black' && isEven(a.number) && b.color === 'red' && isEven(b.number) && c.color === 'red' && isEven(c.number)) {
    return { id: 'padraoDePares', name: 'Padrão de Pares', category: 'Repetição/Espelhamento', status: 'disparou', entryColor: 'red', detail: 'Preto par → Vermelho par → Vermelho par confirmado. Entrada em Vermelho.', casasRestantes: null };
  }
  return { id: 'padraoDePares', name: 'Padrão de Pares', category: 'Repetição/Espelhamento', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null };
}

// ---------------------------------------------------------------
// Fechamento condicional
// ---------------------------------------------------------------
// HEURÍSTICA — "após Loss" e "tendência favorável" dependem de estado
// externo (histórico de entradas dadas, e do cálculo de tendência do
// realtime-gateway.js). Aqui só valida o PADRÃO em si; a condição de
// Loss + tendência deve ser cruzada fora desta função, no gateway,
// que já tem acesso a ambos.
function fechamentoDePadrao(history) {
  const h = last(history, 5);
  if (h.length < 5) {
    return { id: 'fechamentoPadrao', name: 'Fechamento de Padrão', category: 'Fechamento condicional', status: 'aguardando', entryColor: null, detail: 'Histórico insuficiente.', casasRestantes: null, requiresExternalCheck: true };
  }
  const [v1, p1, p2, p3, v2] = h;
  const pretos = [p1, p2, p3];
  const abaixoDe10 = pretos.filter(r => r.number < 10).length;
  const acimaDe10 = pretos.filter(r => r.number >= 10).length;
  if (
    v1.color === 'red' && v2.color === 'red' &&
    pretos.every(r => r.color === 'black') &&
    abaixoDe10 === 1 && acimaDe10 === 2
  ) {
    return {
      id: 'fechamentoPadrao', name: 'Fechamento de Padrão', category: 'Fechamento condicional',
      status: 'disparou', entryColor: 'red',
      detail: 'Padrão V-P-P-P-V confirmado. Só usar após Loss e com Tendência favorável ao Vermelho (checar externamente).',
      casasRestantes: null, requiresExternalCheck: true
    };
  }
  return { id: 'fechamentoPadrao', name: 'Fechamento de Padrão', category: 'Fechamento condicional', status: 'aguardando', entryColor: null, detail: 'Sem padrão detectado.', casasRestantes: null, requiresExternalCheck: true };
}

// ---------------------------------------------------------------
// Motor principal
// ---------------------------------------------------------------
const ALL_DETECTORS = [
  numberThree, numberFive, twoFive,
  xadrezFormal, xadrezInformalRed, xadrezInformalBlack, nextXadrezRed, nextXadrezBlack,
  nextBlack, nextRed, nextDoubleWhite,
  blackDouble, repeticaoEspelhamento, padraoDePares,
  fechamentoDePadrao
];

function calcConfluence(strategies) {
  const active = strategies.filter(s => s.status === 'disparou' && s.entryColor);
  const counts = { red: [], black: [] };
  active.forEach(s => counts[s.entryColor].push(s.id));
  const topColor = counts.red.length >= counts.black.length ? 'red' : 'black';
  const topList = counts[topColor];
  const otherList = counts[topColor === 'red' ? 'black' : 'red'];
  if (topList.length === 0) {
    return { color: null, count: 0, strategies: [] };
  }
  return { color: topColor, count: topList.length, strategies: topList, oppositeCount: otherList.length };
}

function analyzeAll(history) {
  if (!Array.isArray(history) || history.length < 5) {
    return { strategies: [], confluence: { color: null, count: 0, strategies: [] } };
  }
  const strategies = ALL_DETECTORS.map(fn => fn(history));
  const confluence = calcConfluence(strategies);
  return { strategies, confluence };
}

module.exports = { analyzeAll, colorOf };
