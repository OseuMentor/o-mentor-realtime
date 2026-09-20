/**
 * signalEngine.js
 * ---------------------------------------------------------
 * Dono ÚNICO do ciclo de vida do card "Sinal" da Tela Início.
 * Antes, cada navegador abria e resolvia o próprio sinal (sem gravar
 * nada), e o Histórico contava as entradas internas de TODAS as
 * estratégias (strategy_signals) -- por isso os números nunca
 * batiam com o que o usuário via na tela.
 *
 * Agora o servidor decide o sinal uma vez só, todos os usuários veem
 * exatamente o mesmo card, e o Histórico / Resumo de Hoje contam
 * APENAS esses sinais (tabela app_signals). O strategy_signals
 * continua existindo só pro ranking de Estatísticas.
 *
 * Fases (state.phase):
 *   idle      -> nenhum sinal; aguardando confluência
 *   entrada   -> sinal aberto, aguardando a próxima casa
 *   gale      -> a 1ª casa errou (cor oposta), aguardando a casa seguinte
 *   resultado -> mostrando Win / G1 / Branco / Loss por alguns segundos
 *   cooldown  -> "reavaliando", conta N resultados antes de liberar novo sinal
 *
 * Regra de contagem (uma linha por sinal, um único desfecho):
 *   - Bateu a cor na 1ª casa            -> 'win'    (só Win)
 *   - Errou a 1ª, bateu a cor no gale   -> 'g1'     (só G1, NÃO soma em Win)
 *   - Caiu Branco (na 1ª casa ou no G1) -> 'branco'
 *   - Errou a 1ª casa E o gale          -> 'loss'
 */

const persistence = require('./persistence');

const COOLDOWN_HOUSES = 4;          // resultados esperados antes de liberar um sinal novo
const RESULT_DISPLAY_MS = 4000;     // quanto tempo a mensagem Win/G1/Branco/Loss fica na tela
const STALE_OPEN_MS = 10 * 60 * 1000; // sinal aberto há mais que isso, ao reiniciar, é descartado

function idleState() {
  return {
    phase: 'idle',
    color: null,
    confluenceCount: 0,
    entryTime: null,
    outcome: null,
    remaining: 0,
  };
}

class SignalEngine {
  /**
   * @param {{ onChange?: (publicState:any) => void }} opts
   *   onChange é chamado quando o estado muda SEM um resultado novo
   *   (hoje: só quando a mensagem de resultado expira e entra o cooldown).
   */
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.state = idleState();
    this.dbId = null;
    this.resultTimer = null;
  }

  /**
   * Chamar uma vez no start(), depois de persistence.initDb(). Se o
   * servidor reiniciou com um sinal em andamento, retoma de onde parou
   * (desde que seja recente) em vez de perder a entrada.
   */
  async init() {
    await persistence.discardStaleAppSignals(STALE_OPEN_MS);
    const open = await persistence.getOpenAppSignal();
    if (!open) return;
    this.dbId = open.id;
    this.state = {
      phase: open.phase === 'gale' ? 'gale' : 'entrada',
      color: open.entry_color,
      confluenceCount: open.confluence_count,
      entryTime: open.opened_at ? new Date(open.opened_at).toISOString() : null,
      outcome: null,
      remaining: 0,
    };
    console.log(`[signalEngine] retomou sinal aberto (${this.state.phase}, ${this.state.color}).`);
  }

  getPublicState() {
    return { ...this.state };
  }

  stop() {
    clearTimeout(this.resultTimer);
  }

  /**
   * Chamar a cada resultado NOVO (já sem duplicata), depois de calcular
   * a confluência final. Primeiro resolve o sinal em andamento (o
   * resultado que acabou de sair é "a próxima casa"), e só então
   * considera abrir um sinal novo com a confluência atual.
   */
  async processResult(result, confluence) {
    const s = this.state;

    if (s.phase === 'resultado') {
      // Mensagem de resultado ainda na tela: encerra ela agora e vai
      // pro cooldown. Esse resultado não conta como casa de cooldown
      // nem abre sinal (mesmo comportamento que o card sempre teve).
      this._toCooldown();
      return;
    }

    if (s.phase === 'cooldown') {
      s.remaining -= 1;
      if (s.remaining > 0) return;
      this.state = idleState();
      // segue: pode abrir sinal novo neste mesmo resultado
    } else if (s.phase === 'entrada' || s.phase === 'gale') {
      await this._evaluate(result);
      return; // enquanto há sinal (ou resultado na tela), não abre outro
    }

    await this._maybeStart(confluence, result);
  }

  async _evaluate(result) {
    const s = this.state;

    if (result.color === s.color) {
      return this._resolve(s.phase === 'gale' ? 'g1' : 'win');
    }
    if (result.color === 'white') {
      return this._resolve('branco');
    }
    if (s.phase === 'entrada') {
      // Errou a 1ª casa: vai pro gale, ainda NÃO conta nada.
      s.phase = 'gale';
      await persistence.markAppSignalGale(this.dbId);
      return;
    }
    // Errou a 1ª casa e o gale: só agora é Loss.
    return this._resolve('loss');
  }

  async _resolve(outcome) {
    await persistence.resolveAppSignal(this.dbId, outcome);
    this.dbId = null;
    this.state.phase = 'resultado';
    this.state.outcome = outcome;

    clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      if (this.state.phase !== 'resultado') return;
      this._toCooldown();
      this.onChange(this.getPublicState());
    }, RESULT_DISPLAY_MS);
  }

  _toCooldown() {
    clearTimeout(this.resultTimer);
    this.state = {
      ...idleState(),
      phase: 'cooldown',
      remaining: COOLDOWN_HOUSES,
    };
  }

  async _maybeStart(confluence, result) {
    if (!confluence || !confluence.color || !confluence.count) return;
    if (confluence.color !== 'red' && confluence.color !== 'black') return;

    const openedAt = result.timestamp ? new Date(result.timestamp) : new Date();
    this.dbId = await persistence.openAppSignal({
      entryColor: confluence.color,
      confluenceCount: confluence.count,
      sources: {
        strategies: confluence.strategies || [],
        trendSources: confluence.trendSources || [],
        repeticaoBoost: !!confluence.repeticaoBoost,
        forcaNumerosBoost: !!confluence.forcaNumerosBoost,
        forcaNumerosOnly: !!confluence.forcaNumerosOnly,
      },
      openedAt: Number.isNaN(openedAt.getTime()) ? new Date() : openedAt,
    });

    this.state = {
      phase: 'entrada',
      color: confluence.color,
      confluenceCount: confluence.count,
      entryTime: (Number.isNaN(openedAt.getTime()) ? new Date() : openedAt).toISOString(),
      outcome: null,
      remaining: 0,
    };
  }
}

module.exports = { SignalEngine, COOLDOWN_HOUSES };
