/**
 * realtime-gateway.js
 * ---------------------------------------------------------
 * Ponte entre o double-worker (fonte de dados) e a Tela Início
 * (frontend). Responsabilidades:
 *
 *   1. Manter um buffer em memória com os últimos N resultados
 *      (N = 100, suficiente pra Tendência/Mini/Micro).
 *   2. Recalcular Tendência (100) / Mini (50) / Micro (16) a cada
 *      resultado novo — cálculo leve, pode ser em tempo real.
 *   3. Transmitir (broadcast) cada resultado + trends atualizados
 *      pra todos os clientes conectados via WebSocket.
 *   4. Repassar o status de conexão do worker (conectado/caiu),
 *      pro frontend acionar o aviso de modo manual automaticamente.
 *
 * O que este arquivo NÃO faz (de propósito, por decisão já tomada):
 *   - Não calcula ranking de estratégias nem peso adaptativo — isso
 *     é lote/5min e mora num job separado (ex: statsBatchJob.js),
 *     que grava o resultado em algum lugar (banco/cache) e expõe
 *     via REST. Esse job também não devia usar main.js na próxima 
 *     rota — mantemos separado pra não misturar tempo-real com lote.
 *   - Não persiste no banco — isso é responsabilidade de quem
 *     estiver ouvindo os resultados do double-worker antes de
 *     chegar aqui (ou você adiciona um listener adicional lá).
 */

const { WebSocketServer } = require('ws');
const { DoubleWorker } = require('./double-worker');

const WINDOWS = { tendencia: 100, mini: 50, micro: 16 };
const BUFFER_SIZE = 100; // igual à maior janela (Tendência)

class RealtimeGateway {
  constructor({ port = 8081 } = {}) {
    this.wss = new WebSocketServer({ port });
    this.buffer = []; // guarda só os últimos BUFFER_SIZE resultados
    this.lastStatus = { connected: false, reason: 'iniciando' };

    this.wss.on('connection', (client) => this._onClientConnect(client));

    this.worker = new DoubleWorker({
      onResult: (result) => this._handleNewResult(result),
      onStatusChange: (status) => this._handleStatusChange(status),
    });
  }

  start() {
    this.worker.start();
    console.log(`[gateway] WebSocket ouvindo na porta ${this.wss.options.port}`);
  }

  // ---------- Ciclo de vida de cliente ----------

  _onClientConnect(client) {
    // Ao conectar, o cliente recebe o estado atual de uma vez
    // (snapshot), pra não precisar esperar o próximo resultado
    // pra montar a tela.
    this._send(client, {
      type: 'snapshot',
      status: this.lastStatus,
      history: this.buffer,
      trends: this._calcTrends(),
    });
  }

  // ---------- Eventos do worker ----------

  _handleNewResult(result) {
    this.buffer.push(result);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    const payload = {
      type: 'new_result',
      result,
      trends: this._calcTrends(),
    };
    this._broadcast(payload);
  }

  _handleStatusChange(status) {
    this.lastStatus = status;
    this._broadcast({ type: 'status', status });
    // status.connected === false  →  frontend deve mostrar aviso
    // e liberar o botão de entrada manual, conforme já decidido.
  }

  // ---------- Cálculo de tendências (leve, roda em memória) ----------

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

// ---------- Exemplo de uso ----------
if (require.main === module) {
  const gateway = new RealtimeGateway({ port: 8081 });
  gateway.start();
}
