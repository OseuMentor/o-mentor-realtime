/**
 * realtime-gateway.js
 * ---------------------------------------------------------
 * v3: além do WebSocket para o frontend e do endpoint HTTP interno
 * (/internal/ingest) que recebe resultados vindos do tipminer-bridge,
 * agora também aciona o strategyTracker.js a cada resultado novo —
 * ele é quem grava, PARA CADA ESTRATÉGIA que disparar, se a entrada
 * foi Win/Gale/Loss/Branco. Essa é a base de dados usada pelo
 * statsBatchJob.js (Fase 2) pra calcular % de acerto real e o peso
 * adaptativo de cada estratégia.
 *
 * O double-worker.js fica preservado no repositório como fallback
 * documentado, mas não é mais iniciado por padrão.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { analyzeAll } = require('./pattern-engine');
const persistence = require('./persistence');
const strategyTracker = require('./strategyTracker');
const statsBatchJob = require('./statsBatchJob');
const { STRATEGY_META } = require('./strategyMeta');
const lastlinkWebhook = require('./lastlinkWebhook');

const WINDOWS = { tendencia: 100, mini: 50, micro: 16 };
const BUFFER_SIZE = 100;
const PORT = process.env.PORT || 8081;
const INGEST_SECRET = process.env.INGEST_SECRET || '';

// ---------------------------------------------------------------
// Rate limiting simples (janela fixa, em memória) — protege os
// endpoints públicos (/trial-signup, /check-access) contra spam/abuso
// automatizado, sem precisar de nenhuma dependência nova nem de banco
// externo. Como o serviço roda numa única instância no Railway (não
// há múltiplas réplicas dividindo o tráfego), guardar isso em memória
// é suficiente — se um dia vocês escalarem pra múltiplas réplicas,
// isso precisaria virar algo compartilhado (ex: uma tabela no
// Postgres), mas não há necessidade disso agora.
// ---------------------------------------------------------------
const rateLimitBuckets = new Map(); // "endpoint:ip" -> { count, windowStart }

// Limpa entradas antigas de tempos em tempos, pra não vazar memória
// com IPs que só apareceram uma vez.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.windowStart > 30 * 60 * 1000) rateLimitBuckets.delete(key);
  }
}, 10 * 60 * 1000);

function getClientIp(req) {
  // Railway roda atrás de proxy — o IP real do visitante vem no
  // cabeçalho x-forwarded-for (pode ter vários IPs separados por
  // vírgula se passar por mais de um proxy; o primeiro é o cliente).
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconhecido';
}

/**
 * Retorna true se a requisição PODE seguir, false se estourou o
 * limite. "limit" chamadas por "windowMs" milissegundos, por IP, por
 * endpoint (endpoints diferentes têm limites independentes).
 */
function isRateLimited(req, endpoint, limit, windowMs) {
  const ip = getClientIp(req);
  const key = `${endpoint}:${ip}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count++;
  return bucket.count > limit;
}

class RealtimeGateway {
  constructor({ port = PORT } = {}) {
    this.buffer = [];
    this.lastStatus = { connected: false, reason: 'aguardando primeiro resultado' };

    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (client) => this._onClientConnect(client));

    this.port = port;
  }

  async start() {
    await persistence.initDb();
    statsBatchJob.start();
    this.httpServer.listen(this.port, () => {
      console.log(`[gateway] HTTP + WebSocket ouvindo na porta ${this.port}`);
    });
  }

  // ---------- HTTP interno (ingest do bridge Python) ----------

  _handleHttp(req, res) {
    const urlPath = req.url.split('?')[0];

    if (req.method === 'POST' && urlPath === '/internal/ingest') {
      return this._handleIngest(req, res);
    }
    if (req.method === 'POST' && urlPath === '/webhooks/lastlink') {
      return this._handleLastlinkWebhook(req, res);
    }
    if (req.method === 'GET' && urlPath === '/check-access') {
      return this._handleCheckAccess(req, res);
    }
    if (req.method === 'OPTIONS' && urlPath === '/trial-signup') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method === 'POST' && urlPath === '/trial-signup') {
      return this._handleTrialSignup(req, res);
    }
    if (req.method === 'GET' && urlPath === '/stats') {
      return this._handleStats(req, res);
    }
    if (req.method === 'GET' && urlPath === '/history') {
      return this._handleHistory(req, res);
    }
    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(404);
    res.end();
  }

  // Recebe o webhook da LastLink (assinatura paga liberada/cortada).
  // A validação do segredo e a interpretação do payload ficam isoladas
  // em lastlinkWebhook.js — aqui só lemos o corpo bruto e repassamos.
  _handleLastlinkWebhook(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      lastlinkWebhook.handleWebhookRequest(req, res, body).catch((err) => {
        console.error(`[gateway] falha ao processar webhook da LastLink: ${err.message}`);
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end('internal error');
        }
      });
    });
  }

  // Endpoint público e só-leitura que o frontend consulta ao carregar
  // cada página, pra saber se libera o app ou mostra a tela de acesso.
  // Não expõe nada além de true/false — não é informação sensível o
  // suficiente pra justificar autenticação nesse endpoint específico.
  async _handleCheckAccess(req, res) {
    if (isRateLimited(req, 'check-access', 60, 5 * 60 * 1000)) {
      res.writeHead(429, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ active: false, source: null, reason: 'rate_limited' }));
    }

    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const email = fullUrl.searchParams.get('email');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });

    if (!email) {
      return res.end(JSON.stringify({ active: false, source: null }));
    }

    try {
      const info = await persistence.getAccessInfo(email);
      res.end(JSON.stringify(info));
    } catch (err) {
      console.error(`[gateway] falha ao checar acesso: ${err.message}`);
      res.end(JSON.stringify({ active: false, source: null }));
    }
  }

  // Auto-cadastro do teste grátis de 2 dias, chamado pela
  // teste-gratis.html. Como essa página roda no GitHub Pages e chama
  // um domínio diferente (Railway) com corpo JSON, o navegador manda
  // um preflight OPTIONS antes do POST de verdade — precisa responder
  // os dois.
  _handleTrialSignup(req, res) {
    if (isRateLimited(req, 'trial-signup', 5, 30 * 60 * 1000)) {
      res.writeHead(429, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'rate_limited' }));
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let email;
      try {
        const parsed = JSON.parse(body);
        email = parsed.email;
      } catch (e) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, reason: 'invalid_request' }));
      }

      const isValidEmail = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!isValidEmail) {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, reason: 'invalid_email' }));
      }

      try {
        const created = await persistence.grantTrialAccess(email, 2);
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: created, reason: created ? null : 'already_used' }));
      } catch (err) {
        console.error(`[gateway] falha no trial-signup: ${err.message}`);
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'server_error' }));
      }
    });
  }

  // Dado público e só-leitura (nenhuma informação sensível), por isso
  // libera CORS geral — é o endpoint que a tela de Estatísticas do
  // frontend consulta, de um domínio diferente do gateway.
  async _handleStats(req, res) {
    try {
      const rows = await persistence.getAllStrategyStats();
      const enriched = rows.map((r) => {
        const meta = STRATEGY_META[r.strategy_id] || {};
        return {
          strategyId: r.strategy_id,
          name: meta.name || r.strategy_id,
          category: meta.category || null,
          winRate: r.win_rate === null ? null : Number(r.win_rate),
          weight: r.weight === null ? null : Number(r.weight),
          sampleSize: r.sample_size,
          dormant: r.dormant,
          updatedAt: r.updated_at,
        };
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(enriched));
    } catch (err) {
      console.error(`[gateway] falha ao servir /stats: ${err.message}`);
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end('stats query failed');
    }
  }

  // Contagem de sinais resolvidos por dia (fuso Brasília, já tratado na
  // query do persistence.js), separados por tipo de resultado — Win na
  // hora (G0), Win no gale (G1), Branco (proteção) e Loss. Dado público
  // e só leitura, mesma lógica de CORS do /stats.
  async _handleHistory(req, res) {
    try {
      const rows = await persistence.getDailySignalHistory();
      const days = rows.map((r) => {
        const win = Number(r.win);
        const g1 = Number(r.g1);
        const branco = Number(r.branco);
        const loss = Number(r.loss);
        const total = Number(r.total);
        return {
          date: r.date,
          win,
          g1,
          branco,
          loss,
          total,
          winRate: total > 0 ? Math.round(((win + g1 + branco) / total) * 1000) / 10 : null,
        };
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(days));
    } catch (err) {
      console.error(`[gateway] falha ao servir /history: ${err.message}`);
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end('history query failed');
    }
  }

  _handleIngest(req, res) {
    const secret = req.headers['x-ingest-secret'];
    if (!INGEST_SECRET || secret !== INGEST_SECRET) {
      res.writeHead(401);
      return res.end('unauthorized');
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (payload.number === undefined || payload.number === null) {
          res.writeHead(400);
          return res.end('missing number');
        }
        const result = {
          number: payload.number,
          color: payload.color,
          timestamp: payload.timestamp || new Date().toISOString(),
          raw: payload,
        };
        await this._handleNewResult(result);
        this._handleStatusChange({ connected: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('invalid json');
      }
    });
  }

  // ---------- Ciclo de vida de cliente ----------

  _onClientConnect(client) {
    const analysis = analyzeAll(this.buffer);
    this._send(client, {
      type: 'snapshot',
      status: this.lastStatus,
      history: this.buffer,
      trends: this._calcTrends(),
      strategies: analysis.strategies,
      confluence: analysis.confluence,
    });
  }

  // ---------- Novo resultado ----------

  async _handleNewResult(result) {
    this.buffer.push(result);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    // Precisamos do id gravado no banco ANTES de rodar o tracker, pra
    // ele conseguir referenciar esse resultado em strategy_signals.
    // saveResult nunca lança erro (é fire-and-forget por design), então
    // isso não trava o fluxo em tempo real mesmo se o banco cair — só
    // retorna null e o tracker ignora silenciosamente aquele ciclo.
    const newResultId = await persistence.saveResult(result);

    const analysis = analyzeAll(this.buffer);

    try {
      await strategyTracker.processResult(analysis.strategies, newResultId, result);
    } catch (err) {
      console.error(`[gateway] falha no strategyTracker: ${err.message}`);
    }

    const payload = {
      type: 'new_result',
      result,
      trends: this._calcTrends(),
      strategies: analysis.strategies,
      confluence: analysis.confluence,
    };
    this._broadcast(payload);

    return analysis;
  }

  _handleStatusChange(status) {
    this.lastStatus = status;
    this._broadcast({ type: 'status', status });
  }

  // ---------- Cálculo de tendências ----------

  _calcTrends() {
    const out = {};
    for (const [key, windowSize] of Object.entries(WINDOWS)) {
      out[key] = this._calcWindow(windowSize);
    }
    return out;
  }

  _calcWindow(windowSize) {
    const slice = this.buffer.slice(-windowSize).filter((r) => r.color !== 'white');
    const total = slice.length || 1;
    const redCount = slice.filter((r) => r.color === 'red').length;
    const redPct = Math.round((redCount / total) * 100);
    return { redPct, blackPct: 100 - redPct, sampleSize: total };
  }

  // ---------- Broadcast ----------

  _send(client, payload) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    this.wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  }
}

module.exports = { RealtimeGateway };

if (require.main === module) {
  const gateway = new RealtimeGateway({});

  const corLabel = (cor) => {
    if (cor === 'red') return '🔴';
    if (cor === 'black') return '⚫';
    if (cor === 'white') return '⚪';
    return cor;
  };

  const originalHandle = gateway._handleNewResult.bind(gateway);
  gateway._handleNewResult = async (result) => {
    const analysis = await originalHandle(result);
    const disparadas = analysis.strategies.filter((s) => s.status === 'disparou');
    if (disparadas.length > 0) {
      console.log(`[pattern-engine] ${disparadas.length} estrategia(s) disparada(s):`, disparadas.map((s) => `${s.name}->${corLabel(s.entryColor)}`).join(', '));
    }
    if (analysis.confluence.count > 0) {
      console.log(`[pattern-engine] confluencia: ${analysis.confluence.count} estrategia(s) apontando pra ${corLabel(analysis.confluence.color)}`);
    }
    return analysis;
  };

  gateway.start().catch((err) => {
    console.error(`[gateway] falha ao iniciar: ${err.message}`);
    process.exit(1);
  });
}
