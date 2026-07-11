const WebSocket = require('ws');
const ws = new WebSocket('wss://echo.websocket.org');

ws.on('open', () => {
  console.log('[teste] conectou no echo.websocket.org ✅');
  ws.send('oi');
});

ws.on('message', (data) => {
  console.log('[teste] recebeu:', data.toString());
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[teste] erro:', err.message);
});
