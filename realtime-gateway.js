/**
 * realtime-gateway.js
 * ---------------------------------------------------------
 * v2: além do WebSocket para o frontend, agora expõe um endpoint
 * HTTP interno (/internal/ingest) para receber resultados vindos
 * do tipminer-bridge (serviço em Python), já que a conexão SSE
 * direta do double-worker.js está sendo bloqueada quando parte de
 * dentro do Railway (fingerprint anti-bot do TipMiner).
 *
 * O double-worker.js fica preservado no repositório como fallback
 * documentado, mas não é mais iniciado por padrão.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { analyzeAll } = require('./pattern-engine');
const persistence = require('./persistence');

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
    this.httpServer.listen(this.port, () => {
      console.log(`[gateway] HTTP + WebSocket ouvindo na porta ${this.port}`);
    });
  }

  // ---------- HTTP interno (ingest do bridge Python) ----------

  _handleHttp(req, res) {
    if (req.method === 'POST' && req.url === '/internal/ingest') {
      return this._handleIngest(req, res);
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(404);
    res.end();
  }

  _handleIngest(req, res) {
    const secret = req.headers['x-ingest-secret'];
    if (!INGEST_SECRET || secret !== INGEST_SECRET) {
      res.writeHead(401);
      return res.end('unauthorized');
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
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
        this._handleNewResult(result);
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

  // ---------- Novo resultado (agora vindo do bridge) ----------

  _handleNewResult(result) {
    this.buffer.push(result);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    persistence.saveResult(result);

    const analysis = analyzeAll(this.buffer);

    const payload = {
      type: 'new_result',
      result,
      trends: this._calcTrends(),
      strategies: analysis.strategies,
      confluence: analysis.confluence,
    };
    this._broadcast(payload);
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
    if (cor === 'red') return '🔴 Vermelho';
    if (cor === 'black') return '⚫ Preto';
    if (cor === 'white') return '⚪ Branco';
    return cor;
  };

  const originalHandle = gateway._handleNewResult.bind(gateway);
  gateway._handleNewResult = (result) => {
    originalHandle(result);
    const analysis = analyzeAll(gateway.buffer);
    const disparadas = analysis.strategies.filter((s) => s.status === 'disparou');
    if (disparadas.length > 0) {
      console.log(`[pattern-engine] ${disparadas.length} estrategia(s) disparada(s):`, disparadas.map((s) => `${s.name}->${corLabel(s.entryColor)}`).join(', '));
    }
    if (analysis.confluence.count > 0) {
      console.log(`[pattern-engine] confluencia: ${analysis.confluence.count} estrategia(s) apontando pra ${corLabel(analysis.confluence.color)}`);
    }
  };

  gateway.start().catch((err) => {
    console.error(`[gateway] falha ao iniciar: ${err.message}`);
    process.exit(1);
  });
}
