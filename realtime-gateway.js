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

const WINDOWS = { tendencia: 100, mini: 50, micro: 16 };
const BUFFER_SIZE = 100;
const PORT = process.env.PORT || 8081;
const INGEST_SECRET = process.env.INGEST_SECRET || '';

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
    if (req.method === 'POST' && req.url === '/internal/ingest') {
      return this._handleIngest(req, res);
    }
    if (req.method === 'GET' && req.url === '/stats') {
      return this._handleStats(req, res);
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(404);
    res.end();
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
