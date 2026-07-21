/**
 * strategyTracker.js
 * ---------------------------------------------------------
 * Rastreia, PARA CADA ESTRATÉGIA (não só a "em destaque" mostrada no
 * frontend), se ela disparou e qual foi o resultado real da entrada
 * — a base de dados que alimenta o aprendizado adaptativo (Fase 2).
 *
 * Diferença importante em relação ao painel de "Sinal" do frontend:
 * o frontend só acompanha UMA estratégia em destaque por vez (a
 * escolhida pra mostrar pro usuário). Aqui rastreamos TODAS que
 * dispararem, simultaneamente, porque senão a % de acerto calculada
 * refletiria só a estratégia "sortuda" que apareceu na tela, não o
 * desempenho real de cada uma.
 *
 * Regra de resolução (igual à lógica do painel de Sinal):
 *   - Resultado seguinte bate a cor da entrada  -> 'win_g0'
 *   - Resultado seguinte é Branco               -> 'win_white'
 *   - Resultado seguinte é a cor oposta          -> vai pro gale (G1),
 *     aguarda mais um resultado:
 *       - bate a cor da entrada  -> 'win_g1'
 *       - é Branco               -> 'win_white'
 *       - é a cor oposta de novo -> 'loss'
 *
 * Estado em memória (openSignals): Map<strategyId, { dbId, entryColor,
 * phase: 'aberto' | 'gale' }>. Isso é reconstruído do zero a cada
 * reinício do processo (não persiste entre deploys) — é aceitável
 * porque, na pior das hipóteses, perde-se o desfecho de sinais que
 * estavam abertos bem no momento do restart, o que é um volume
 * desprezível perto do histórico total.
 */

const persistence = require('./persistence');

const openSignals = new Map(); // strategyId -> { dbId, entryColor, phase }

/**
 * Chame isso a cada resultado novo, DEPOIS de já ter chamado
 * persistence.saveResult() pra esse resultado (precisamos do id dele).
 *
 * @param {Array} strategies - saída de analyzeAll(buffer).strategies
 * @param {number|null} newResultId - id (double_results.id) do
 *   resultado que acabou de ser gravado
 * @param {{number:number, color:string}} newResult - o resultado em si
 */
async function processResult(strategies, newResultId, newResult) {
  // 1) Primeiro resolve/avança os sinais que já estavam abertos,
  // usando o resultado que acabou de sair como "a próxima casa".
  for (const [strategyId, signal] of openSignals.entries()) {
    if (newResult.color === signal.entryColor) {
      const outcome = signal.phase === 'gale' ? 'win_g1' : 'win_g0';
      await persistence.resolveSignal(signal.dbId, outcome, newResultId);
      openSignals.delete(strategyId);
    } else if (newResult.color === 'white') {
      await persistence.resolveSignal(signal.dbId, 'win_white', newResultId);
      openSignals.delete(strategyId);
    } else if (signal.phase === 'aberto') {
      // Errou a primeira casa: vai pro gale (G1), ainda não resolve.
      signal.phase = 'gale';
      await persistence.markSignalGale(signal.dbId, newResultId);
    } else {
      // Já estava no gale e errou de novo: Loss.
      await persistence.resolveSignal(signal.dbId, 'loss', newResultId);
      openSignals.delete(strategyId);
    }
  }

  // 2) Depois, abre sinal novo pra cada estratégia que disparou agora
  // e que não tem nenhum sinal em aberto no momento (evita abrir dois
  // sinais simultâneos da mesma estratégia).
  for (const s of strategies) {
    if (s.status !== 'disparou' || !s.entryColor) continue;
    if (openSignals.has(s.id)) continue;

    const dbId = await persistence.openSignal({
      strategyId: s.id,
      entryColor: s.entryColor,
      triggeredResultId: newResultId,
    });
    if (dbId) {
      openSignals.set(s.id, { dbId, entryColor: s.entryColor, phase: 'aberto' });
    }
  }
}

module.exports = { processResult };
