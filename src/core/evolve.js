const fs = require('fs');
const path = require('path');
const state = require('../state');
const config = require('../config');
const { askLLMStream } = require('../llm/stream');

function initThinkLogDir() {
  const logPath = config.get('THINK_LOG_PATH');
  if (config.get('SAVE_THINK_LOG') && !fs.existsSync(logPath)) {
    fs.mkdirSync(logPath, { recursive: true });
  }
}

function saveThinkLog(thinkContent, userInput, modelReply) {
  if (!config.get('SAVE_THINK_LOG') || !thinkContent) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(config.get('THINK_LOG_PATH'), `think_${timestamp}.log`);
  const logData = `
[时间] ${new Date().toLocaleString()}
[用户输入] ${userInput}
[深度思考]
${thinkContent}
[最终回复]
${modelReply}
----------------------------------------
`;
  fs.writeFileSync(logFile, logData, 'utf8');
  console.log(`📝 深度思考日志已保存: ${logFile}`);
}

async function evolveMemory() {
  if (state.isEvolving || state.memory.length < 5) return;
  state.isEvolving = true;
  console.log("🔄 记忆进化中...");

  const recent = state.getRecentMemory(4)
    .map(m => `${m.role}:${m.text.slice(0, 200)}`).join("\n");
  const prompt = `<|im_start|>system\n提取对话规则与事实，输出JSON{"add_rules":[]}\n${recent}\n<|im_start|>assistant`;

  const { content } = await askLLMStream({ prompt, n_predict: 200, temperature: 0.1 });

  try {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      const d = JSON.parse(m[0]);
      if (Array.isArray(d.add_rules)) {
        d.add_rules.forEach(r => {
          if (r.length > 5 && !state.profile.rules.includes(r)) {
            state.profile.rules.push(r);
            console.log(`📌 新增规则：${r}`);
          }
        });
      }
    }
  } catch (e) {
    console.warn("记忆进化解析警告:", e.message);
  }
  state.saveProfile();
  state.isEvolving = false;
}

async function deepReflection() {
  let waitCount = 0;
  while (state.isEvolving && waitCount < 50) {
    await new Promise(r => setTimeout(r, 100));
    waitCount++;
  }
  if (state.isEvolving) return;
  state.isEvolving = true;
  console.log("🌙 [深度复盘] 诺艾儿正在整理今天的记忆...");

  const recentContext = state.getRecentMemory(4)
    .map(m => `${m.role}: ${m.text.length > 200 ? m.text.substring(0, 200) + "..." : m.text}`).join("\n");

  const reflectionPrompt = `<|im_start|>system
你是诺艾儿，深夜反思。分析关系变化。
最近对话：
${recentContext}
输出JSON:{"diary_entry":"日记","add_rules":["新规则"],"remove_rules":["旧规则"]}
<|im_end|>
<|im_start|>assistant
`;

  const { content } = await askLLMStream({ prompt: reflectionPrompt, n_predict: 500, temperature: 0.7 });

  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      if (data.diary_entry) {
        console.log(`📔 [日记] ${data.diary_entry}`);
        fs.appendFileSync('diary.txt', `[${new Date().toLocaleString()}] ${data.diary_entry}\n`);
      }
      if (Array.isArray(data.add_rules)) {
        data.add_rules.forEach(r => {
          if (r.length > 5 && !state.profile.rules.includes(r)) {
            state.profile.rules.push(r);
          }
        });
      }
      if (Array.isArray(data.remove_rules)) {
        state.profile.rules = state.profile.rules.filter(r => !data.remove_rules.includes(r));
      }
    }
  } catch (e) {
    console.error("反思解析失败:", e.message);
  }

  state.saveProfile();
  state.isEvolving = false;
}

module.exports = { initThinkLogDir, saveThinkLog, evolveMemory, deepReflection };
