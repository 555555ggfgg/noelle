const state = require('../state');
const config = require('../config');
const { askLLMStream } = require('../llm/stream');

let consciousnessTimer = null;

async function processOneThought(ws) {
  if (state.isProcessing) return;
  state.isProcessing = true;

  const now = new Date();
  const timeString = now.toLocaleTimeString('zh-CN', { hour12: false });
  const currentHour = now.getHours();
  const silenceDuration = Math.floor((Date.now() - state.lastInteractionTime) / 1000);
  const timeStatus = (currentHour >= 1 && currentHour < 6) ? "深夜" : "白天";

  console.log(`\n🤔 [沉思] 沉默:${silenceDuration}秒`);

  const thoughtPrompt = `<|im_start|>system
诺艾儿，胆小内向。时间:${timeString}(${timeStatus}) 沉默:${silenceDuration}s 上个想法:"${state.lastThoughtContent}"
延续思维不重复。输出JSON:{"thought":"新独白","should_speak":true/false,"message":"...","new_rule":"..."}
<|im_end|>
<|im_start|>assistant
`;

  const { content: result } = await askLLMStream({ prompt: thoughtPrompt, n_predict: 200, temperature: 0.9 });

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      const thoughtData = JSON.parse(match[0]);

      if (thoughtData.thought && state.lastThoughtContent &&
        thoughtData.thought.includes(state.lastThoughtContent.substring(0, 5))) {
        state.isProcessing = false;
        return;
      }

      state.lastThoughtContent = thoughtData.thought || state.lastThoughtContent;
      console.log(`💭 [心声] "${state.lastThoughtContent}"`);

      if (thoughtData.should_speak && thoughtData.message && ws) {
        console.log(`💬 [主动开口] "${thoughtData.message}"`);
        state.addMemory("ai", thoughtData.message);
        try {
          ws.send(JSON.stringify({
            "text": thoughtData.message,
            "action": "",
            "情绪": "normal",
            "HP": state.HP,
            "MP": state.MP,
            "Desire": state.Desire,
            "Like": state.Like,
            "role": state.ROLE_INFO
          }));
        } catch (e) {
          console.warn("思考推送失败:", e.message);
        }
      }
    }
  } catch (e) {
    console.error("思考出错:", e.message);
  }

  state.isProcessing = false;
}

function startConsciousness(ws) {
  if (consciousnessTimer) {
    clearInterval(consciousnessTimer);
  }
  console.log("[潜意识] 启动（高敏感模式）");
  consciousnessTimer = setInterval(async () => {
    if (state.isProcessing || state.isEvolving) return;
    const silenceDuration = Math.floor((Date.now() - state.lastInteractionTime) / 1000);
    if (silenceDuration > config.get('AFK_THRESHOLD') && Math.random() < 0.1) {
      await processOneThought(ws);
    }
  }, config.get('THOUGHT_COOLDOWN'));
}

function stopConsciousness() {
  if (consciousnessTimer) {
    clearInterval(consciousnessTimer);
    consciousnessTimer = null;
  }
}

module.exports = { startConsciousness, stopConsciousness };
