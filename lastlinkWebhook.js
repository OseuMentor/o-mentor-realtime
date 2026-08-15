/**
 * lastlinkWebhook.js
 * ---------------------------------------------------------
 * Responsável por UMA coisa só: receber os avisos (webhooks) que a
 * LastLink manda quando algo muda numa compra/assinatura, e traduzir
 * isso em "esse e-mail tem acesso ou não" na tabela access_grants.
 *
 * Eventos da LastLink que nos interessam (conferir nomes exatos contra
 * um evento de teste real assim que o produto existir lá — a
 * documentação pública mostra a estrutura geral, mas o nome literal de
 * cada campo só se confirma vendo um payload de verdade, igual
 * aconteceu com o double-worker.js e o protocolo da Blaze/TipMiner):
 *   - Product_access_started  -> libera (active = true)
 *   - Product_access_ended    -> corta (active = false) — pagamento
 *     atrasado, assinatura cancelada, ou fim de período de convite
 *   - Refund_Requested        -> corta (active = false)
 *   - Active_Member_Notification -> ignorado (é só um "ping" de que o
 *     membro segue ativo, não muda nosso estado)
 *
 * IMPORTANTE — risco já sinalizado no projeto (mesmo espírito do
 * double-worker.js e do tipminer-bridge): isso depende do formato de
 * payload documentado pela LastLink hoje. Assim que o produto for
 * criado lá, IMPORTANTE conferir contra um "Testar Webhook" de verdade
 * se os nomes dos campos abaixo (LASTLINK_EMAIL_PATH, etc.) batem —
 * ajustar aqui é o único lugar que precisa mudar se não bater.
 *
 * Segurança: LASTLINK_WEBHOOK_SECRET precisa ser definida como env var
 * no Railway, com o MESMO valor configurado no painel da LastLink ao
 * criar o webhook. Sem isso configurado (ainda não existe hoje),
 * TODAS as chamadas são rejeitadas — propositalmente: preferimos
 * "webhook não funciona ainda" a "qualquer um consegue se autoliberar
 * acesso mandando um POST fake".
 */

const persistence = require('./persistence');

const ACCESS_STARTED_EVENTS = new Set(['Product_access_started']);
const ACCESS_ENDED_EVENTS = new Set(['Product_access_ended', 'Refund_Requested']);

/**
 * Extrai o e-mail do comprador do payload. A LastLink aninha isso de
 * formas diferentes dependendo do evento (visto na documentação
 * pública: às vezes embaixo de "Customer", às vezes em outro nível) —
 * essa função tenta os caminhos mais prováveis. Ajustar/confirmar
 * contra um payload real assim que disponível.
 */
function extractEmail(body) {
  const candidates = [
    body?.Customer?.Email,
    body?.Buyer?.Email,
    body?.Data?.Customer?.Email,
    body?.email,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.includes('@'));
  return found ? found.toLowerCase().trim() : null;
}

function extractSubscriptionId(body) {
  return body?.Subscription?.Id || body?.SubscriptionId || body?.Id || null;
}

/**
 * Handler HTTP puro (sem depender de nenhum framework) — recebe
 * (req, res) já com o corpo bruto lido, no mesmo padrão manual usado
 * em _handleIngest() no realtime-gateway.js.
 */
async function handleWebhookRequest(req, res, rawBody) {
  const expectedSecret = process.env.LASTLINK_WEBHOOK_SECRET || '';
  const providedSecret = req.headers['x-lastlink-secret'] || '';

  // DIAGNOSTICO TEMPORARIO -- remover depois de confirmar contra um
  // payload real qual header/campo a LastLink realmente usa pra
  // mandar o token. A documentacao publica nao deixa isso explicito,
  // entao capturamos aqui pra descobrir com certeza em vez de
  // continuar tentando adivinhar.
  console.log('[lastlinkWebhook] DIAGNOSTICO -- headers recebidos:', JSON.stringify(req.headers));
  console.log('[lastlinkWebhook] DIAGNOSTICO -- corpo recebido (primeiros 500 chars):', String(rawBody).slice(0, 500));

  if (!expectedSecret || providedSecret !== expectedSecret) {
    res.writeHead(401);
    return res.end('unauthorized');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    res.writeHead(400);
    return res.end('invalid json');
  }

  const eventName = body?.Event || body?.type;
  const email = extractEmail(body);

  if (!email) {
    console.warn(`[lastlinkWebhook] evento "${eventName}" sem e-mail identificável, ignorando.`);
    // Responde 200 mesmo assim — não é um erro de transporte, é um
    // evento que não sabemos processar. Devolver erro faria a LastLink
    // ficar reenviando pra sempre.
    res.writeHead(200);
    return res.end('ok (sem email, ignorado)');
  }

  if (ACCESS_STARTED_EVENTS.has(eventName)) {
    await persistence.upsertAccessFromWebhook({
      email,
      active: true,
      subscriptionId: extractSubscriptionId(body),
      eventName,
    });
    console.log(`[lastlinkWebhook] acesso liberado: ${email} (${eventName})`);
  } else if (ACCESS_ENDED_EVENTS.has(eventName)) {
    await persistence.upsertAccessFromWebhook({
      email,
      active: false,
      subscriptionId: extractSubscriptionId(body),
      eventName,
    });
    console.log(`[lastlinkWebhook] acesso cortado: ${email} (${eventName})`);
  } else {
    console.log(`[lastlinkWebhook] evento "${eventName}" recebido, sem ação definida (ignorado).`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

module.exports = { handleWebhookRequest };
