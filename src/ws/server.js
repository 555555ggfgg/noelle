const WebSocket = require('ws');
const state = require('../state');
const config = require('../config');
const { chatWithOwen } = require('../core/chat');
const { evolveMemory, deepReflection } = require('../core/evolve');
const { startConsciousness, stopConsciousness } = require('../core/consciousness');
const { saveConversation } = require('./conversations');

function createWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });
  let pingTimer;

  wss.on("connection", (ws) => {
    console.log(">>> WebSocket 客户端已连接");
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    startConsciousness(ws);

    ws.on("message", async (raw) => {
      const txt = (typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')).trim();
      if (!txt) return;
      state.touchInteraction();
      if (state.isProcessing) return;
      state.isProcessing = true;

      state.addMemory("user", txt);
      const reply = await chatWithOwen(txt);

      if (reply) {
        state.updateStatus(reply);
        state.addMemory("ai", reply.clean);
        saveConversation(state.currentConversationId);

        try {
          const msg = {
            text: reply.clean,
            action: reply.action,
            emotion: reply.emotion,
            HP: state.HP,
            MP: state.MP,
            Desire: state.Desire,
            Like: state.Like,
            role: state.ROLE_INFO
          };
          if (reply.thinking) msg.thinking = reply.thinking.substring(0, 2000);
          ws.send(JSON.stringify(msg));
        } catch (e) { }

        if (state.memory.length % config.get('EVOLUTION_INTERVAL') === 0) {
          setTimeout(async () => {
            await evolveMemory();
            if (state.memory.length % config.get('REFLECTION_INTERVAL') === 0) {
              await deepReflection();
            }
          }, 2000);
        } else if (state.memory.length % config.get('REFLECTION_INTERVAL') === 0) {
          setTimeout(() => deepReflection(), 2000);
        }
      }

      state.isProcessing = false;
    });

    ws.on("close", () => {
      console.log(">>> WebSocket 客户端断开");
      saveConversation(state.currentConversationId);
      state.saveProfile();
      stopConsciousness();
    });
  });

  const pingInterval = config.get('WS_PING_INTERVAL') || 30000;
  pingTimer = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, pingInterval);

  wss.on('close', () => { clearInterval(pingTimer); });

  return wss;
}

module.exports = { createWebSocketServer };
