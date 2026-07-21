/**
 * persistence.js
 * ---------------------------------------------------------
 * Responsável por gravar dados que precisam sobreviver a reinícios
 * do servidor:
 *   1. double_results — cada resultado fechado do Double.
 *   2. strategy_signals — cada vez que uma estratégia do pattern-engine
 *      dispara ("disparou"), e o resultado real dessa entrada (Win G0,
 *      Win G1, Win Branco, ou Loss). É a base de dados que alimenta o
 *      aprendizado adaptativo (Fase 2: statsBatchJob.js calcula % de
 *      acerto e peso em cima dessa tabela).
 *
 * Por que separado do realtime-gateway.js?
 * - Mantém a decisão já tomada no projeto: tempo-real e persistência
 *   são responsabilidades diferentes, mesmo que hoje o gateway seja
 *   quem aciona a gravação (ver nota no header do realtime-gateway.js).
 * - Se o banco cair ou ficar lento, isso não pode travar nem atrasar
 *   o broadcast em tempo real pros clientes conectados — por isso
 *   toda escrita aqui é "fire and forget" com tratamento de erro
 *   próprio, nunca reprojetada pra cima como uma exceção que quebra
 *   o fluxo principal.
 *
 * Dependência:
 *   npm i pg
 *
 * Configuração:
 *   Variável de ambiente DATABASE_URL (Railway e Render injetam essa
 *   variável automaticamente quando você adiciona um addon de
 *   Postgres ao projeto — não precisa configurar nada na mão lá).
 *   Formato: postgres://usuario:senha@host:porta/nome_do_banco
 *
 * Se DATABASE_URL não estiver definida, o módulo desliga sozinho e
 * loga um aviso — útil pra rodar o resto da stack localmente sem
 * precisar de banco (ex: só testando o worker/gateway/pattern-engine
 * juntos, como já fizemos no Replit).
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const ENABLED = Boolean(DATABASE_URL);

let pool = null;
if (ENABLED) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway e Render exigem SSL pra conexões externas; em alguns
    // planos o certificado é auto-assinado, por isso rejectUnauthorized
    // false aqui (comum pra esses provedores — não é uma prática ruim
    // nesse contexto específico, é o padrão recomendado por eles).
    ssl: { rejectUnauthorized: false },
  });
} else {
  console.warn('[persistence] DATABASE_URL não definida — rodando sem persistência (resultados só ficam em memória).');
}

/**
 * Cria as tabelas se ainda não existirem. Chame isso uma vez, no
 * início do processo (antes de start() do gateway).
 */
async function initDb() {
  if (!ENABLED) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS double_results (
      id BIGSERIAL PRIMARY KEY,
      external_uuid TEXT UNIQUE,
      number SMALLINT NOT NULL,
      color TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_double_results_occurred_at
    ON double_results (occurred_at);
  `);

  // Cada linha é UMA entrada sugerida por UMA estratégia. "outcome"
  // fica NULL enquanto ainda não foi resolvida (aguardando a próxima
  // casa, ou já foi pro gale e aguarda a casa seguinte).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_signals (
      id BIGSERIAL PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      entry_color TEXT NOT NULL,
      triggered_result_id BIGINT REFERENCES double_results(id),
      gale_result_id BIGINT REFERENCES double_results(id),
      resolution_result_id BIGINT REFERENCES double_results(id),
      outcome TEXT,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_strategy_signals_strategy_id
    ON strategy_signals (strategy_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_strategy_signals_outcome
    ON strategy_signals (outcome);
  `);

  console.log('[persistence] tabelas double_results e strategy_signals prontas.');
}

/**
 * Grava um resultado. Espera o mesmo formato que o double-worker /
 * tipminer-bridge entrega: { number, color, timestamp, raw }.
 *
 * Retorna o "id" da linha gravada (ou já existente, em caso de
 * duplicata via ON CONFLICT) — o strategyTracker.js precisa desse id
 * pra referenciar em strategy_signals. Se a gravação falhar ou o
 * módulo estiver desligado, retorna null (quem chamar deve tratar
 * esse caso, não travar o fluxo em tempo real por causa disso).
 */
async function saveResult(result) {
  if (!ENABLED) return null;

  const externalUuid = result.raw && result.raw.uuid ? result.raw.uuid : null;

  try {
    const res = await pool.query(
      `INSERT INTO double_results (external_uuid, number, color, occurred_at, raw)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_uuid) DO UPDATE SET external_uuid = EXCLUDED.external_uuid
       RETURNING id`,
      [externalUuid, result.number, result.color, result.timestamp, result.raw || null]
    );
    return res.rows[0] ? res.rows[0].id : null;
  } catch (err) {
    console.error(`[persistence] falha ao gravar resultado: ${err.message}`);
    return null;
  }
}

/**
 * Abre um sinal novo (estratégia disparou agora). Retorna o id da
 * linha criada, ou null se falhar/desligado — quem chamar guarda esse
 * id em memória pra poder resolver o sinal depois.
 */
async function openSignal({ strategyId, entryColor, triggeredResultId }) {
  if (!ENABLED) return null;
  try {
    const res = await pool.query(
      `INSERT INTO strategy_signals (strategy_id, entry_color, triggered_result_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [strategyId, entryColor, triggeredResultId]
    );
    return res.rows[0].id;
  } catch (err) {
    console.error(`[persistence] falha ao abrir sinal: ${err.message}`);
    return null;
  }
}

/** Marca um sinal como tendo ido pro gale (ainda não resolvido). */
async function markSignalGale(signalId, galeResultId) {
  if (!ENABLED || !signalId) return;
  try {
    await pool.query(
      `UPDATE strategy_signals SET gale_result_id = $2 WHERE id = $1`,
      [signalId, galeResultId]
    );
  } catch (err) {
    console.error(`[persistence] falha ao marcar gale: ${err.message}`);
  }
}

/**
 * Resolve um sinal (fecha com o resultado final).
 * outcome deve ser um de: 'win_g0' | 'win_g1' | 'win_white' | 'loss'
 */
async function resolveSignal(signalId, outcome, resolutionResultId) {
  if (!ENABLED || !signalId) return;
  try {
    await pool.query(
      `UPDATE strategy_signals
       SET outcome = $2, resolution_result_id = $3, resolved_at = now()
       WHERE id = $1`,
      [signalId, outcome, resolutionResultId]
    );
  } catch (err) {
    console.error(`[persistence] falha ao resolver sinal: ${err.message}`);
  }
}

/**
 * Fecha o pool de conexões. Só relevante em testes ou em shutdown
 * gracioso — não precisa chamar isso no fluxo normal do worker rodando
 * pra sempre.
 */
async function close() {
  if (pool) await pool.end();
}

module.exports = {
  initDb,
  saveResult,
  openSignal,
  markSignalGale,
  resolveSignal,
  close,
  ENABLED,
};
