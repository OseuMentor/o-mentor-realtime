/**
 * strategyMeta.js
 * ---------------------------------------------------------
 * Mapa id -> { name, category } das 14 estratégias, espelhando os
 * nomes usados no pattern-engine.js. Existe como arquivo separado
 * porque o pattern-engine só expõe esses nomes dentro do resultado de
 * analyzeAll(history) (que exige um histórico de verdade pra rodar) —
 * aqui precisamos dos nomes mesmo sem nenhum histórico, só pra
 * enriquecer a resposta do endpoint /stats com texto legível.
 *
 * IMPORTANTE: se um dia mudar o nome de alguma estratégia no
 * pattern-engine.js, lembre de espelhar a mudança aqui também — não
 * há verificação automática de que os dois arquivos estão em sincronia.
 */

const STRATEGY_META = {
  number3: { name: 'Number 3', category: 'Contagem numérica' },
  number5: { name: 'Number 5', category: 'Contagem numérica' },
  '2five': { name: '2Five', category: 'Contagem numérica' },
  xadrezFormal: { name: 'Xadrez (Padrão Formal)', category: 'Alternância' },
  xadrezInformal: { name: 'Xadrez Informal', category: 'Alternância' },
  nextXadrez: { name: 'Next Xadrez', category: 'Alternância' },
  blackRedWhite: { name: 'Black/Red White', category: 'Padrões com Branco' },
  nextBlack: { name: 'Next Black', category: 'Padrões com Branco' },
  nextRed: { name: 'Next Red', category: 'Padrões com Branco' },
  nextDoubleWhite: { name: 'Next Double White', category: 'Padrões com Branco' },
  blackDouble: { name: 'Black Double', category: 'Repetição/Espelhamento' },
  repeticaoEspelhamento: { name: 'Repetição (Espelhamento)', category: 'Repetição/Espelhamento' },
  padraoDePares: { name: 'Padrão de Pares', category: 'Repetição/Espelhamento' },
  fechamentoPadrao: { name: 'Fechamento de Padrão', category: 'Fechamento condicional' },
};

module.exports = { STRATEGY_META };
