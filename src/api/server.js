const path = require('path');
const express = require('express');
const cors = require('cors');
const state = require('../state');
const config = require('../config');
const { chatWithOwen, getTokenUsage } = require('../core/chat');
const { evolveMemory, deepReflection } = require('../core/evolve');
const { saveConversation } = require('../ws/conversations');

function createAPIServer(port, bindIp) {
  const app = express();

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(express.json({ limit: '10mb' }));

  // Serve web frontend
  const webPath = path.resolve(__dirname, '../../web');
  app.use(express.static(webPath));

  app.get('/v1/models', (req, res) => {
    res.json({
      object: "list",
      data: [{
        id: config.get('API_MODEL'),
        object: "model",
        created: Date.now(),
        owned_by: "noelle-system"
      }]
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const data = req.body;
      const userMsg = data.messages?.filter(m => m.role === "user").pop()?.content || "";
      const isStream = !!data.stream;

      state.isProcessing = true;
      state.touchInteraction();
      state.addMemory("user", typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg));

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const cid = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: config.get('API_MODEL'), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]})}\n\n`);
      }

      const reply = await chatWithOwen(userMsg, [], {
        onContent: (text) => {
          if (isStream) {
            try {
              const cid = `chatcmpl-${Date.now()}`;
              const created = Math.floor(Date.now() / 1000);
              res.write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: config.get('API_MODEL'), choices: [{ index: 0, delta: { content: text }, finish_reason: null }]})}\n\n`);
            } catch (e) {}
          }
        }
      });

      if (!reply) {
        res.status(500).json({ error: { message: "生成失败" } });
        state.isProcessing = false;
        return;
      }

      state.updateStatus(reply);
      state.addMemory("ai", reply.clean);
      saveConversation(state.currentConversationId);

      const tokenUsage = {
        prompt_tokens: reply.promptTokens,
        completion_tokens: reply.completionTokens,
        total_tokens: reply.promptTokens + reply.completionTokens
      };

      if (isStream) {
        const cid = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify({
          id: cid, object: "chat.completion.chunk", created, model: config.get('API_MODEL'),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: tokenUsage
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        try { res.end(); } catch (e) {}
      } else {
        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: config.get('API_MODEL'),
          system_fingerprint: "noelle-v3",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: reply.clean,
              refusal: null,
              thinking: reply.thinking,
              emotion: reply.emotion,
              action: reply.action
            },
            logprobs: null,
            finish_reason: "stop"
          }],
          usage: tokenUsage,
          noelle: {
            hp: state.HP,
            mp: state.MP,
            desire: state.Desire,
            like: state.Like,
            role_info: state.ROLE_INFO
          }
        });
      }

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

    } catch (e) {
      console.error("API请求异常:", e);
      if (!res.headersSent) {
        res.status(400).json({ error: "服务器内部错误" });
      } else if (isStream) {
        try { res.end(); } catch (e2) {}
      }
    } finally {
      state.isProcessing = false;
    }
  });

  app.get('/health', (req, res) => {
    const usage = getTokenUsage();
    res.json({
      status: "ok",
      model: config.get('API_MODEL'),
      backend: config.get('BACKEND_TYPE'),
      state: {
        hp: state.HP, mp: state.MP,
        desire: state.Desire, like: state.Like,
        memory: state.memory.length
      },
      tokens: usage
    });
  });

  const server = app.listen(port, bindIp, () => {
    console.log(`🌐 Web 界面: http://${bindIp}:${port}`);
    console.log(`🌐 API:     http://${bindIp}:${port}/v1`);
  });

  return server;
}

module.exports = { createAPIServer };
