/**
 * persistence.js
 * ---------------------------------------------------------
 * Responsável por UMA coisa só: gravar cada resultado fechado do
 * Double num banco PostgreSQL, pra sobreviver a reinícios do
 * servidor e acumular histórico suficiente pro ranking de
 * estratégias (Fase 3, que precisa de dados de vários dias, não só
 * do buffer de 100 resultados que o realtime-gateway mantém em
 * memória).
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
 * Cria a tabela de resultados se ainda não existir. Chame isso uma
 * vez, no início do processo (antes de start() do gateway).
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

  // Índice pra consultas por período (o job de ranking em lote vai
  // filtrar por data o tempo todo).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_double_results_occurred_at
    ON double_results (occurred_at);
  `);

  console.log('[persistence] tabela double_results pronta.');
}

/**
 * Grava um resultado. Espera o mesmo formato que o double-worker
 * entrega: { number, color, timestamp, raw }.
 *
 * Não lança erro pra quem chamou — só loga. Gravação é best-effort;
 * o fluxo em tempo real não pode depender disso pra continuar
 * funcionando.
 */
async function saveResult(result) {
  if (!ENABLED) return;

  const externalUuid = result.raw && result.raw.uuid ? result.raw.uuid : null;

  try {
    await pool.query(
      `INSERT INTO double_results (external_uuid, number, color, occurred_at, raw)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_uuid) DO NOTHING`,
      [externalUuid, result.number, result.color, result.timestamp, result.raw || null]
    );
  } catch (err) {
    console.error(`[persistence] falha ao gravar resultado: ${err.message}`);
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

module.exports = { initDb, saveResult, close, ENABLED };
