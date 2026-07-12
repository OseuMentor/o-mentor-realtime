/**
 * double-worker.js  (v3 — TipMiner via SSE)
 * ---------------------------------------------------------
 * Worker isolado responsável por UMA coisa só: manter uma conexão
 * de dados em tempo real do Double e entregar cada resultado FECHADO
 * já normalizado no formato que o resto do "O Mentor" espera.
 *
 * ------------------------------------------------------------
 * HISTÓRICO — por que essa é a v3:
 * v1: lib @viniciusgdr/Blaze — desatualizada (domínio, eventos,
 *     parâmetro obrigatório faltando). Corrigimos tudo isso.
 * v2: protocolo Socket.IO direto na Blaze (wss://api-gaming.blaze.
 *     bet.br), mapeado à mão via DevTools. Funcionou até o handshake,
 *     mas a Cloudflare da Blaze rejeita a conexão por fingerprint
 *     (não é falta de header — é detecção de que não é um Chrome
 *     de verdade). Contornar isso exigiria rodar um navegador headless
 *     de verdade (Puppeteer/Playwright), o que é pesado, frágil e
 *     escala o nível de risco do projeto.
 * v3 (esta): em vez de insistir na Blaze, usamos o TipMiner como
 *     fonte — especificamente o endpoint público de Server-Sent
 *     Events (SSE) que alimenta as notificações ao vivo do site
 *     deles. Mapeado à mão via DevTools (12/jul/2026):
 *
 *       GET https://api.core.public.tipminer.com/v1/double/rounds/
 *           6ee2f33f-7dbf-40ae-b01c-b05368c806ba/live
 *       Accept: text/event-stream
 *
 *     Esse endpoint NÃO pediu token de autenticação nos testes (ao
 *     contrário de /history e /types-per-hour, que exigem Bearer).
 *     Formato dos eventos SSE:
 *       - evento nomeado "heartbeat": só sinal de vida, ex.
 *         {"latest_external_id":"...","latest_uuid":"..."}
 *       - evento default "message": resultado da rodada, ex.
 *         {"uuid":"...", "type":"DOUBLE"|"DEFAULT", "result":8,
 *          "instant":"2026-07-12T12:39:21.573Z"}
 *     O campo "result" é o número que caiu (0-14). Cor é recalculada
 *     por nós (0=branco, 1-7=vermelho, 8-14=preto), igual sempre.
 *     "type" não parece correlacionar com cor — ignorado por ora.
 *
 * IMPORTANTE — risco já sinalizado no projeto, ainda mais relevante
 * aqui: este é um endpoint não documentado de um agregador terceiro
 * (TipMiner), não da própria Blaze. Pode mudar de formato ou passar
 * a exigir autenticação a qualquer momento, sem aviso. O worker
 * sempre avisa quando perde conexão, pra liberar o modo manual.
 *
 * O ID da sala (6ee2f33f-7dbf-40ae-b01c-b05368c806ba) parece ser fixo
 * para "Double da Blaze" dentro do TipMiner — se um dia parar de
 * funcionar, vale reconferir se esse UUID mudou (o TipMiner cataloga
 * vários cassinos/jogos, cada um com seu próprio UUID de sala).
 *
 * Dependência:
 *   npm i eventsource
 */

const { EventSource } = require('eventsource');

// ---------- Config ----------
const ROUND_ID = '6ee2f33f-7dbf-40ae-b01c-b05368c806ba'; // sala "Double" no TipMiner
const LIVE_URL = `https://api.core.public.tipminer.com/v1/double/rounds/${ROUND_ID}/live`;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;
const STALE_AFTER_MS = 90000; // ~90s sem nenhum evento (nem heartbeat) = conexão suspeita

class DoubleWorker {
  /**
   * @param {Object} opts
   * @param {(result: {number:number, color:'red'|'black'|'white', timestamp:string, raw:any}) => void} opts.onResult
   * @param {(status: {connected:boolean, reason?:string}) => void} opts.onStatusChange
   */
  constructor({ onResult, onStatusChange }) {
    this.onResult = onResult || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.source = null;
    this.reconnectAttempt = 0;
    this.connected = false;
    this.staleTimer = null;
    this.lastSeenUuid = null; // evita processar o mesmo resultado duas vezes
  }

  start() {
    this._connect();
  }

  stop() {
    clearTimeout(this.staleTimer);
    if (this.source) this.source.close();
  }

  _connect() {
    try {
      this.source = new EventSource(LIVE_URL, {
        headers: {
          Accept: 'text/event-stream',
          Origin: 'https://www.tipminer.com',
          Referer: 'https://www.tipminer.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        },
      });

      this.source.onopen = () => {
        this.reconnectAttempt = 0;
        this._setConnected(true);
        this._armStaleTimer();
      };

      // Evento default do SSE (sem "event:" nomeado) — é o resultado da rodada.
      this.source.onmessage = (evt) => this._handleMessage(evt);

      // Evento nomeado "heartbeat" — só sinal de vida, mantém o stale timer
      // armado mas não gera resultado nenhum.
      this.source.addEventListener('heartbeat', () => {
        this._setConnected(true);
        this._armStaleTimer();
      });

      this.source.onerror = (err) => {
        // A lib eventsource tenta reconectar sozinha por padrão, mas
        // preferimos controlar isso na mão pra manter o mesmo padrão
        // de backoff usado no resto do projeto — fechamos e agendamos
        // nosso próprio retry.
        const reason = err && err.message ? err.message : 'erro na conexão SSE';
        console.error(`[worker] erro SSE: ${reason}`);
        this._setConnected(false, reason);
        if (this.source) this.source.close();
        this._scheduleReconnect();
      };
    } catch (err) {
      console.error(`[worker] falha ao conectar: ${err.message}`);
      this._setConnected(false, `falha ao conectar: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS
    );
    this.reconnectAttempt++;
    setTimeout(() => this._connect(), delay);
  }

  _armStaleTimer() {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this._setConnected(false, 'sem nenhum evento (nem heartbeat) há muito tempo (possível instabilidade)');
      if (this.source) this.source.close();
      this._scheduleReconnect();
    }, STALE_AFTER_MS);
  }

  _setConnected(connected, reason) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.onStatusChange({ connected, reason });
    }
  }

  _handleMessage(evt) {
    let payload;
    try {
      payload = JSON.parse(evt.data);
    } catch (e) {
      return; // mensagem que não é JSON válido, ignora
    }

    // Mensagens de heartbeat às vezes chegam sem "event:" explícito
    // dependendo de como o servidor manda — filtramos aqui também,
    // por segurança, checando se tem "result" de verdade.
    if (payload.result === undefined || payload.result === null) return;

    // Evita duplicar o mesmo resultado.
    if (payload.uuid && payload.uuid === this.lastSeenUuid) return;
    this.lastSeenUuid = payload.uuid;

    this._setConnected(true);
    this._armStaleTimer();

    const normalized = this._normalize(payload);
    if (normalized) this.onResult(normalized);
  }

  /**
   * Isola a fragilidade de formato do payload aqui — se o TipMiner
   * mudar de novo, é só esse método que precisa ser ajustado.
   */
  _normalize(payload) {
    const roll = payload.result;
    if (roll === undefined || roll === null) return null;

    let color;
    if (roll === 0) color = 'white';
    else if (roll >= 1 && roll <= 7) color = 'red';
    else color = 'black';

    return {
      number: roll,
      color,
      timestamp: payload.instant || new Date().toISOString(),
      raw: payload,
    };
  }
}

module.exports = { DoubleWorker };

// ---------- Exemplo de uso ----------
// Rode este arquivo direto (node double-worker.js) pra testar isolado,
// antes de plugar no seu backend/banco de dados real.
if (require.main === module) {
  const worker = new DoubleWorker({
    onResult: (r) => {
      console.log(`[resultado] cor=${r.color} numero=${r.number} em ${r.timestamp}`);
      // TODO: aqui é onde você chama sua função de salvar no banco,
      // ex: await db.results.insert(r)
    },
    onStatusChange: (s) => {
      if (s.connected) {
        console.log('[status] conectado ✅');
      } else {
        console.warn(`[status] desconectado ⚠️  motivo: ${s.reason}`);
      }
    },
  });

  worker.start();
}
