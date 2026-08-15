/**
 * lastlinkWebhook.js
 * ---------------------------------------------------------
 * Responsável por UMA coisa só: receber os avisos (webhooks) que a
 * LastLink manda quando algo muda numa compra/assinatura, e traduzir
 * isso em "esse e-mail tem acesso ou não" na tabela access_grants.
 *
 * CALIBRADO (15/ago/2026) contra um payload real de teste, via botão
 * "Testar Webhook" da LastLink e contra a documentação oficial
 * (support.lastlink.com/pt-BR/articles/12587805). Duas correções
 * importantes feitas nesta calibração:
 *
 *   1. O segredo NÃO vem no header "x-lastlink-secret" (suposição
 *      inicial, nunca confirmada) -- a LastLink manda no header
 *      "x-lastlink-token". Confirmado direto nos logs de um teste
 *      real.
 *   2. Os nomes de evento usam "Access" com A maiúsculo:
 *      Product_Access_Started / Product_Access_Ended (não
 *      Product_access_started como estava antes -- JS é
 *      case-sensitive, isso nunca teria batido).
 *
 * Eventos que nos interessam:
 *   - Product_Access_Started -> libera (active = true)
 *   - Product_Access_Ended   -> corta (active = false) — pagamento
 *     atrasado, assinatura cancelada, ou fim de período de convite
 *   - Refund_Requested       -> corta (active = false)
 *   - qualquer outro evento  -> ignorado (não muda nosso estado)
 *
 * Onde cada evento guarda o e-mail (confirmado contra a doc oficial):
 *   - Product_Access_Started / Product_Access_Ended -> Data.Member.Email
 *   - Refund_Requested (e a maioria dos outros eventos comerciais)
 *     -> Data.Buyer.Email
 *
 * Segurança: LASTLINK_WEBHOOK_SECRET precisa ser definida como env var
 * no Railway, com o MESMO valor do campo "Token" mostrado no painel da
 * LastLink ao criar o webhook. Sem isso configurado, TODAS as
 * chamadas são rejeitadas — propositalmente: preferimos "webhook não
 * funciona ainda" a "qualquer um consegue se autoliberar acesso
 * mandando um POST fake".
 */

const persistence = require('./persistence');

const ACCESS_STARTED_EVENTS = new Set(['Product_Access_Started']);
const ACCESS_ENDED_EVENTS = new Set(['Product_Access_Ended', 'Refund_Requested']);

/**
 * Extrai o e-mail do comprador/membro do payload. A LastLink usa
 * caminhos diferentes dependendo do evento:
 *   - Data.Member.Email  -> eventos de acesso (Product_Access_*)
 *   - Data.Buyer.Email   -> eventos comerciais (compra, reembolso, etc.)
 * Tentamos os dois, mais alguns fallbacks, nessa ordem.
 */
function extractEmail(body) {
  const candidates = [
    body?.Data?.Member?.Email,
    body?.Data?.Buyer?.Email,
    body?.Data?.Customer?.Email,
    body?.Buyer?.Email,
    body?.Customer?.Email,
    body?.email,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.includes('@'));
  return found ? found.toLowerCase().trim() : null;
}

/**
 * Extrai o id da assinatura. Varia de formato conforme o evento:
 *   - Data.SubscriptionId        -> Product_Access_Ended
 *   - Data.Subscription.Id       -> Product_Access_Started / Subscription_Product_Access
 *   - Data.Subscriptions[0].Id   -> eventos comerciais (array)
 */
function extractSubscriptionId(body) {
  if (body?.Data?.SubscriptionId) return body.Data.SubscriptionId;
  if (body?.Data?.Subscription?.Id) return body.Data.Subscription.Id;
  if (Array.isArray(body?.Data?.Subscriptions) && body.Data.Subscriptions[0]?.Id) {
    return body.Data.Subscriptions[0].Id;
  }
  return null;
}

/**
 * Handler HTTP puro (sem depender de nenhum framework) — recebe
 * (req, res) já com o corpo bruto lido, no mesmo padrão manual usado
 * em _handleIngest() no realtime-gateway.js.
 */
async function handleWebhookRequest(req, res, rawBody) {
  const expectedSecret = process.env.LASTLINK_WEBHOOK_SECRET || '';
  const providedSecret = req.headers['x-lastlink-token'] || '';

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
