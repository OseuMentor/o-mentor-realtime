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

  // Resultado calculado pelo statsBatchJob.js: % de acerto ponderado e
  // peso adaptativo por estratégia, recalculado a cada 5 minutos.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_stats (
      strategy_id TEXT PRIMARY KEY,
      win_rate NUMERIC,
      weight NUMERIC,
      sample_size INT NOT NULL DEFAULT 0,
      dormant BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Controle de acesso ao app: quem pode entrar. Duas origens possíveis
  // (coluna "source"): 'lastlink' (assinante pago, mantido pelo webhook
  // da LastLink) e 'tester' (acesso gratuito dado na mão, com prazo de
  // validade em expires_at). expires_at fica NULL pra assinantes
  // LastLink, já que o corte de acesso deles é avisado pelo próprio
  // webhook (Product_access_ended / Refund_Requested), não por prazo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_grants (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL DEFAULT 'lastlink',
      lastlink_subscription_id TEXT,
      last_event TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log('[persistence] tabelas double_results, strategy_signals, strategy_stats e access_grants prontas.');
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
 * Busca os últimos N resultados já gravados, do mais antigo pro mais
 * recente (mesma ordem que o buffer em memória do realtime-gateway
 * espera). Usado no start() do gateway pra repopular o buffer assim
 * que o servidor sobe, em vez de começar zerado -- sem isso, todo
 * redeploy fazia as Tendências (janelas de 100/50/16 casas) ficarem
 * incorretas por um tempo, até acumularem dado novo o suficiente de
 * novo.
 *
 * Retorna no mesmo formato que o double-worker/tipminer-bridge
 * entrega: { number, color, timestamp, raw }.
 */
async function getRecentResults(limit = 100) {
  if (!ENABLED) return [];
  try {
    const res = await pool.query(
      `SELECT number, color, occurred_at, raw
       FROM double_results
       ORDER BY occurred_at DESC
       LIMIT $1`,
      [limit]
    );
    // A query vem do mais recente pro mais antigo (DESC) -- inverte
    // aqui pra ficar do mais antigo pro mais recente, que é a ordem
    // que o buffer em memória e o pattern-engine esperam.
    return res.rows.reverse().map((row) => ({
      number: row.number,
      color: row.color,
      timestamp: row.occurred_at,
      raw: row.raw,
    }));
  } catch (err) {
    console.error(`[persistence] falha ao buscar resultados recentes: ${err.message}`);
    return [];
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
 * Lista os strategy_id distintos que já têm pelo menos um sinal
 * resolvido (outcome não nulo) — usado pelo statsBatchJob pra saber
 * quais estratégias recalcular.
 */
async function getDistinctStrategyIds() {
  if (!ENABLED) return [];
  try {
    const res = await pool.query(
      `SELECT DISTINCT strategy_id FROM strategy_signals WHERE outcome IS NOT NULL`
    );
    return res.rows.map((r) => r.strategy_id);
  } catch (err) {
    console.error(`[persistence] falha ao listar strategy_ids: ${err.message}`);
    return [];
  }
}

/**
 * Retorna os últimos N sinais resolvidos de uma estratégia, do mais
 * recente pro mais antigo — base pra calcular a média móvel ponderada.
 */
async function getRecentResolvedSignals(strategyId, limit) {
  if (!ENABLED) return [];
  try {
    const res = await pool.query(
      `SELECT outcome FROM strategy_signals
       WHERE strategy_id = $1 AND outcome IS NOT NULL
       ORDER BY resolved_at DESC
       LIMIT $2`,
      [strategyId, limit]
    );
    return res.rows;
  } catch (err) {
    console.error(`[persistence] falha ao ler sinais recentes de ${strategyId}: ${err.message}`);
    return [];
  }
}

/**
 * Grava (ou atualiza) o resultado calculado pra uma estratégia.
 */
async function upsertStrategyStats({ strategyId, winRate, weight, sampleSize, dormant }) {
  if (!ENABLED) return;
  try {
    await pool.query(
      `INSERT INTO strategy_stats (strategy_id, win_rate, weight, sample_size, dormant, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (strategy_id) DO UPDATE SET
         win_rate = EXCLUDED.win_rate,
         weight = EXCLUDED.weight,
         sample_size = EXCLUDED.sample_size,
         dormant = EXCLUDED.dormant,
         updated_at = now()`,
      [strategyId, winRate, weight, sampleSize, dormant]
    );
  } catch (err) {
    console.error(`[persistence] falha ao salvar stats de ${strategyId}: ${err.message}`);
  }
}

/**
 * Lê todas as estatísticas já calculadas, ordenadas da mais pro menos
 * assertiva — usado pelo endpoint /stats que o frontend consulta.
 */
async function getAllStrategyStats() {
  if (!ENABLED) return [];
  try {
    const res = await pool.query(
      `SELECT strategy_id, win_rate, weight, sample_size, dormant, updated_at
       FROM strategy_stats
       ORDER BY weight DESC NULLS LAST`
    );
    return res.rows;
  } catch (err) {
    console.error(`[persistence] falha ao ler strategy_stats: ${err.message}`);
    return [];
  }
}

/**
 * Retorna a contagem de sinais resolvidos por dia (fuso horário do
 * Brasil), separados por tipo de desfecho — Win na hora (win_g0), Win
 * no gale (win_g1), Branco (win_white) e Loss. Usado pela tela de
 * Histórico do frontend.
 */
async function getDailySignalHistory(limit = 60) {
  if (!ENABLED) return [];
  try {
    const res = await pool.query(
      `SELECT
         to_char(resolved_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS date,
         COUNT(*) FILTER (WHERE outcome = 'win_g0')::int AS win,
         COUNT(*) FILTER (WHERE outcome = 'win_g1')::int AS g1,
         COUNT(*) FILTER (WHERE outcome = 'win_white')::int AS branco,
         COUNT(*) FILTER (WHERE outcome = 'loss')::int AS loss,
         COUNT(*)::int AS total
       FROM strategy_signals
       WHERE outcome IS NOT NULL
       GROUP BY date
       ORDER BY date DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error(`[persistence] falha ao ler historico diario: ${err.message}`);
    return [];
  }
}

/**
 * Grava/atualiza o acesso de um e-mail a partir de um evento vindo do
 * webhook da LastLink. "active" já vem decidido por quem chamou
 * (lastlinkWebhook.js interpreta o campo Event antes de chegar aqui).
 * ON CONFLICT garante que reenvios duplicados de webhook (a LastLink
 * pode reentregar o mesmo evento) não quebrem nem dupliquem nada.
 */
async function upsertAccessFromWebhook({ email, active, subscriptionId, eventName }) {
  if (!ENABLED) return;
  try {
    await pool.query(
      `INSERT INTO access_grants (email, active, source, lastlink_subscription_id, last_event, expires_at, updated_at)
       VALUES ($1, $2, 'lastlink', $3, $4, NULL, now())
       ON CONFLICT (email) DO UPDATE SET
         active = EXCLUDED.active,
         source = 'lastlink',
         lastlink_subscription_id = COALESCE(EXCLUDED.lastlink_subscription_id, access_grants.lastlink_subscription_id),
         last_event = EXCLUDED.last_event,
         expires_at = NULL,
         updated_at = now()`,
      [email.toLowerCase().trim(), active, subscriptionId || null, eventName || null]
    );
  } catch (err) {
    console.error(`[persistence] falha ao gravar acesso via webhook (${email}): ${err.message}`);
  }
}

/**
 * Auto-cadastro do teste grátis (usado pelo endpoint público
 * /trial-signup, chamado direto pela teste-gratis.html). Diferente de
 * grantTesterAccess (que você usa na mão pra dar acesso a alguém
 * específico e SEMPRE sobrescreve), essa função só cria a linha se o
 * e-mail NUNCA existiu antes na tabela — "ON CONFLICT DO NOTHING".
 *
 * Isso garante duas coisas de uma vez, sem precisar de lógica extra:
 *   1. Um e-mail só consegue o teste grátis uma vez na vida (mesmo
 *      depois de expirado, tentar de novo com o mesmo e-mail não cria
 *      uma linha nova).
 *   2. Nunca sobrescreve por acidente um e-mail que já é assinante
 *      pago (LastLink) ou tester manual — se a linha já existe por
 *      qualquer motivo, essa função simplesmente não mexe nela.
 *
 * Retorna true se criou o acesso agora, false se o e-mail já existia
 * (e portanto não é elegível).
 */
async function grantTrialAccess(email, days = 2) {
  if (!ENABLED) return false;
  try {
    const res = await pool.query(
      `INSERT INTO access_grants (email, active, source, expires_at)
       VALUES ($1, true, 'trial', now() + ($2 || ' days')::interval)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [String(email).toLowerCase().trim(), String(days)]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error(`[persistence] falha ao dar acesso de trial (${email}): ${err.message}`);
    return false;
  }
}

/**
 * Dá acesso manual e gratuito a um tester, com prazo de validade.
 * Chamado direto no banco (query manual) hoje, não por uma rota HTTP —
 * mas fica aqui como função reaproveitável caso um dia vire um painel.
 */
async function grantTesterAccess(email, days = 30) {
  if (!ENABLED) return;
  try {
    await pool.query(
      `INSERT INTO access_grants (email, active, source, expires_at, updated_at)
       VALUES ($1, true, 'tester', now() + ($2 || ' days')::interval, now())
       ON CONFLICT (email) DO UPDATE SET
         active = true,
         source = 'tester',
         expires_at = now() + ($2 || ' days')::interval,
         updated_at = now()`,
      [email.toLowerCase().trim(), String(days)]
    );
  } catch (err) {
    console.error(`[persistence] falha ao dar acesso de tester (${email}): ${err.message}`);
  }
}

/**
 * Checa se um e-mail tem acesso válido agora: precisa estar "active"
 * E (sem prazo definido OU o prazo ainda não passou). Usado pelo
 * endpoint público /check-access.
 */
async function checkAccess(email) {
  if (!ENABLED) return false;
  try {
    const res = await pool.query(
      `SELECT active FROM access_grants
       WHERE email = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())`,
      [String(email).toLowerCase().trim()]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error(`[persistence] falha ao checar acesso (${email}): ${err.message}`);
    return false;
  }
}

/**
 * Igual a checkAccess, mas também devolve a ORIGEM do acesso ('trial',
 * 'tester' ou 'lastlink'). Existe separada pra não mudar o formato de
 * retorno de checkAccess (evita quebrar quem já depende só do
 * booleano). O frontend usa isso pra decidir se trava a grade de
 * estratégias na ferramentas.html — teste grátis nunca inclui as 14
 * estratégias detalhadas, só o Sinal ao vivo da Tela Início.
 */
async function getAccessInfo(email) {
  if (!ENABLED) return { active: false, source: null };
  try {
    const res = await pool.query(
      `SELECT active, source FROM access_grants
       WHERE email = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())`,
      [String(email).toLowerCase().trim()]
    );
    if (res.rows.length === 0) return { active: false, source: null };
    return { active: true, source: res.rows[0].source };
  } catch (err) {
    console.error(`[persistence] falha ao checar acesso detalhado (${email}): ${err.message}`);
    return { active: false, source: null };
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
  getRecentResults,
  openSignal,
  markSignalGale,
  resolveSignal,
  getDistinctStrategyIds,
  getRecentResolvedSignals,
  upsertStrategyStats,
  getAllStrategyStats,
  getDailySignalHistory,
  upsertAccessFromWebhook,
  grantTesterAccess,
  grantTrialAccess,
  checkAccess,
  getAccessInfo,
  close,
  ENABLED,
};
