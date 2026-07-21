/**
 * statsBatchJob.js
 * ---------------------------------------------------------
 * Fase 2 do aprendizado adaptativo: recalcula, a cada 5 minutos, o
 * "peso" de cada estratégia — uma média móvel ponderada da taxa de
 * acerto nas últimas N entradas resolvidas (strategy_signals com
 * outcome preenchido), dando mais importância aos resultados mais
 * recentes que aos antigos, exatamente como já estava decidido desde
 * o início do projeto.
 *
 * Decisão de onde isso roda: por simplicidade (evitar criar um
 * terceiro serviço no Railway agora), esse job roda DENTRO do mesmo
 * processo do o-mentor-realtime, mas como módulo isolado — não mexe
 * no buffer em memória do gateway nem no fluxo em tempo real, só lê e
 * escreve no banco de forma assíncrona. Se um dia o volume de dados
 * justificar, dá pra mover isso pra um serviço Railway separado sem
 * reescrever a lógica de cálculo, só trocar onde ela é chamada.
 *
 * "Win" pra fins de cálculo = qualquer outcome que não seja 'loss'
 * (ou seja, win_g0, win_g1 e win_white contam como acerto).
 */

const persistence = require('./persistence');

const WINDOW_SIZE = 50;           // últimas N entradas resolvidas consideradas por estratégia
const DECAY = 0.95;               // fator de decaimento: entradas mais antigas pesam menos
const MIN_SAMPLE_FOR_DORMANT = 15; // amostra mínima pra poder classificar como "adormecida"
const DORMANT_THRESHOLD_PCT = 35;  // abaixo disso (com amostra suficiente) = adormecida
const BATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * outcomes: array de strings ('win_g0'|'win_g1'|'win_white'|'loss'),
 * já ordenado do mais recente pro mais antigo.
 * Retorna um número de 0 a 1.
 */
function computeWeightedWinRate(outcomes) {
  let weightedSum = 0;
  let weightTotal = 0;
  outcomes.forEach((outcome, idx) => {
    const w = Math.pow(DECAY, idx);
    const isWin = outcome !== 'loss';
    weightedSum += isWin ? w : 0;
    weightTotal += w;
  });
  if (weightTotal === 0) return 0;
  return weightedSum / weightTotal;
}

async function runBatch() {
  if (!persistence.ENABLED) return;

  const strategyIds = await persistence.getDistinctStrategyIds();
  for (const strategyId of strategyIds) {
    const rows = await persistence.getRecentResolvedSignals(strategyId, WINDOW_SIZE);
    const outcomes = rows.map((r) => r.outcome);
    const winRateFraction = computeWeightedWinRate(outcomes);
    const winRatePct = Math.round(winRateFraction * 1000) / 10; // 1 casa decimal
    const sampleSize = outcomes.length;
    const dormant = sampleSize >= MIN_SAMPLE_FOR_DORMANT && winRatePct < DORMANT_THRESHOLD_PCT;

    await persistence.upsertStrategyStats({
      strategyId,
      winRate: winRatePct,
      weight: winRateFraction,
      sampleSize,
      dormant,
    });
  }

  if (strategyIds.length > 0) {
    console.log(`[statsBatchJob] recalculado peso/assertividade de ${strategyIds.length} estrategia(s).`);
  }
}

function start() {
  if (!persistence.ENABLED) {
    console.warn('[statsBatchJob] persistencia desabilitada, job nao sera iniciado.');
    return;
  }
  runBatch().catch((err) => console.error(`[statsBatchJob] erro na primeira execucao: ${err.message}`));
  setInterval(() => {
    runBatch().catch((err) => console.error(`[statsBatchJob] erro: ${err.message}`));
  }, BATCH_INTERVAL_MS);
  console.log(`[statsBatchJob] agendado para rodar a cada ${BATCH_INTERVAL_MS / 60000} minutos.`);
}

module.exports = { start, runBatch, computeWeightedWinRate };
