/**
 * double-worker.js
 * ---------------------------------------------------------
 * Worker isolado responsável por UMA coisa só: manter uma conexão
 * com o double da Blaze e entregar cada resultado já normalizado
 * no formato que o resto do "O Mentor" espera.
 *
 * Por que separado do resto do app?
 * - Se essa conexão cair ou o formato mudar do lado da Blaze,
 *   só esse worker é afetado. O app continua rodando no modo manual.
 * - Fica fácil trocar a fonte de dados no futuro (ex: TipMiner,
 *   ou outra lib) sem tocar no resto do sistema — o contrato de
 *   saída (onResult / onStatusChange) não muda.
 *
 * Dependência (não-oficial, mantida pela comunidade):
 *   npm i @viniciusgdr/Blaze
 *
 * IMPORTANTE — risco já sinalizado no projeto:
 * Isso é engenharia reversa de um endpoint não documentado
 * oficialmente pela Blaze. Pode quebrar sem aviso e pode entrar
 * em conflito com os Termos de Uso deles. Por isso este worker
 * SEMPRE avisa quando perde conexão, pra você poder degradar
 * pro modo manual automaticamente na interface.
 */

const { makeConnection } = require('@viniciusgdr/Blaze');

// ---------- Config ----------
const RECONNECT_BASE_DELAY_MS = 2000;   // primeira tentativa: 2s
const RECONNECT_MAX_DELAY_MS = 60000;   // nunca espera mais que 1min entre tentativas
const STALE_AFTER_MS = 20000;           // se não chega nenhum resultado em 20s, considera "sem sinal"

class DoubleWorker {
  /**
   * @param {Object} opts
   * @param {(result: {number:number, color:'red'|'black'|'white', timestamp:string, raw:any}) => void} opts.onResult
   * @param {(status: {connected:boolean, reason?:string}) => void} opts.onStatusChange
   */
  constructor({ onResult, onStatusChange }) {
    this.onResult = onResult || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.socket = null;
    this.reconnectAttempt = 0;
    this.connected = false;
    this.staleTimer = null;
  }

  start() {
    this._connect();
  }

  stop() {
    clearTimeout(this.staleTimer);
    if (this.socket && this.socket.close) this.socket.close();
  }

  _connect() {
    try {
      this.socket = makeConnection({ type: 'doubles' });

      this.socket.ev.on('double.tick', (msg) => this._handleTick(msg));

      this.socket.ev.on('close', (info) => {
        this._setConnected(false, `conexão encerrada (code ${info?.code})`);
        this._scheduleReconnect();
      });

      // Se a lib expuser algum evento de erro/abertura, aproveitamos também
      if (this.socket.ev.on) {
        this.socket.ev.on('open', () => {
          this.reconnectAttempt = 0;
          this._setConnected(true);
          this._armStaleTimer();
        });
      }
    } catch (err) {
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
      this._setConnected(false, 'sem novos resultados há muito tempo (possível instabilidade)');
    }, STALE_AFTER_MS);
  }

  _setConnected(connected, reason) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.onStatusChange({ connected, reason });
    }
  }

  _handleTick(msg) {
    const normalized = this._normalize(msg);
    if (!normalized) return; // tick que não é um resultado fechado, ignora
    this._setConnected(true);
    this._armStaleTimer();
    this.onResult(normalized);
  }

  /**
   * Aqui é o único ponto que precisa ser ajustado se a lib mudar
   * o formato do payload — isolamos essa fragilidade numa função só.
   */
  _normalize(msg) {
    // A lib emite eventos de progresso da rodada também (ex: "waiting", "rolling").
    // Só nos interessa o momento em que o resultado fecha.
    if (!msg || msg.status !== 'complete') return null;

    const roll = msg.roll ?? msg.result?.roll;
    if (roll === undefined || roll === null) return null;

    let color;
    if (roll === 0) color = 'white';
    else if (roll >= 1 && roll <= 7) color = 'red';
    else color = 'black';

    return {
      number: roll,
      color,
      timestamp: new Date().toISOString(),
      raw: msg,
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
      // e onde recalcula Tendência / Mini / Micro em memória, se fizer
      // sentido manter um cache rolling em vez de ler o banco toda vez.
    },
    onStatusChange: (s) => {
      if (s.connected) {
        console.log('[status] conectado ✅');
        // TODO: sinalizar pro frontend/API que a captura automática está OK
      } else {
        console.warn(`[status] desconectado ⚠️  motivo: ${s.reason}`);
        // TODO: sinalizar pro frontend/API pra exibir aviso e liberar
        // o modo de entrada manual, conforme já definido no projeto.
      }
    },
  });

  worker.start();
}
