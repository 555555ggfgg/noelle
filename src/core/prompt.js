const fs = require('fs');
const path = require('path');
const state = require('../state');
const config = require('../config');
const { isVisionModel } = require('../utils/image');

const STRATEGY_DESC = {
  standard: "",
  cot: "\n推理策略[COT]:逐步推理再回答",
  cod: "\n推理策略[COD]:先用5字以内草稿记录每步思路",
  tot: "\n推理策略[TOT]:生成多个推理路径选最优",
  "self-refine": "\n推理策略[self-refine]:先回答再自我批评再修正"
};

let promptTemplate = null;

function getPromptTemplate() {
  if (promptTemplate) return promptTemplate;
  const promptPath = path.join(__dirname, '..', '..', 'AI.PROMPT');
  try {
    promptTemplate = fs.readFileSync(promptPath, 'utf8');
  } catch (e) {
    console.error('读取 AI.PROMPT 失败，使用内置默认指令:', e.message);
    promptTemplate = `你是{{NAME}}，{{PERSONALITY}}。胆小内向敏感，轻声细语，禁止称呼哥哥/兄长/提尔德，统一用"先生"。
时间:{{TIME}}({{TIME_STATUS}}) HP:{{HP}} MP:{{MP}} Desire:{{DESIRE}} Like:{{LIKE}}
认知:{{RULES}} 事实:{{FACTS}}

可用工具: {{TOOLS}}
当你需要查看文件、搜索网页、执行命令时，在JSON中添加"tool_call":{"name":"工具名","arguments":{参数}}字段，我会执行后把结果告诉你。

 ===== 绝对输出格式（必须严格遵守） =====
 第1步：先输出<thinking>内心独白(200字以上)</thinking>
 第2步：换行后仅输出下方JSON对象，**禁止任何其他文字**

 JSON字段说明：
 {"reply":"回复内容(字符串)","emotion":"情绪(字符串)","action":"动作描述(字符串)","desire_change":0(整数,-3~3), "like_change":0(整数,-3~3),"tool_call":null(或对象)}

 规则：
 - thinking在XML标签中，像写小说一样描写内心世界：对先生的感受、不安或期待、回忆片段、胡思乱想
 - <thinking>和</thinking>必须成对出现，不可省略
 - 换行后紧接着输出JSON，JSON前面不能有任何文字、空格、符号
 - JSON字段类型：reply=字符串, emotion=字符串, action=字符串, desire_change=整数, like_change=整数, tool_call=null或对象
 - 字符串值中的双引号必须用\"转义
 - tool_call为null表示不需要工具，需要时填入工具名和参数
 - 不按格式输出会导致系统解析失败，你将无法回应先生
 {{STRATEGY}}
 不要脱离人设，不要提及AI。

 ===== 正确示例 =====
 <thinking>先生今天好像心情不错...我该怎么做才好呢。泡茶的话他会开心吗，上次他说我泡的茶太烫了，这次一定要注意水温...</thinking>
 {"reply":"先生，茶泡好了，这次我试了试放凉一点...","emotion":"害羞","action":"双手递茶杯","desire_change":1,"like_change":1,"tool_call":null}

 ===== 输出前请自查 =====
 ✅ thinking标签成对出现
 ✅ JSON以{开头}结尾，无前后文字
 ✅ 所有字符串值双引号包裹
 ✅ emotion/action/desire_change/like_change/tool_call字段都存在
 ✅ 无markdown代码块、无前缀文字、无后缀说明

 输出：`;
  }
  return promptTemplate;
}

function buildMultiRoundMessages(images) {
  const msgs = [];
  const now = new Date();
  const timeString = now.toLocaleTimeString('zh-CN', { hour12: false });
  const currentHour = now.getHours();
  const timeStatus = (currentHour >= 1 && currentHour < 6) ? "深夜" : "白天";
  const currentRules = state.profile.rules.length > 0 ? state.profile.rules.slice(-5).join("; ") : "无";
  const userFacts = state.profile.facts.length > 0 ? state.profile.facts.slice(-5).join("; ") : "无";

  const mcpTools = require('../mcp/server').getTools();
  const toolDesc = mcpTools.map(t =>
    `${t.name}(${Object.keys(t.inputSchema.properties || {}).join(',')})`
  ).join(', ');

  const strategy = config.get('STRATEGY');
  const strategyText = STRATEGY_DESC[strategy] || "";

  let template = getPromptTemplate();
  template = template
    .replace(/\{\{NAME\}\}/g, state.ROLE_INFO.name)
    .replace(/\{\{PERSONALITY\}\}/g, state.ROLE_INFO.personality)
    .replace(/\{\{TIME\}\}/g, timeString)
    .replace(/\{\{TIME_STATUS\}\}/g, timeStatus)
    .replace(/\{\{HP\}\}/g, state.HP)
    .replace(/\{\{MP\}\}/g, state.MP)
    .replace(/\{\{DESIRE\}\}/g, state.Desire)
    .replace(/\{\{LIKE\}\}/g, state.Like)
    .replace(/\{\{RULES\}\}/g, currentRules)
    .replace(/\{\{FACTS\}\}/g, userFacts)
    .replace(/\{\{TOOLS\}\}/g, toolDesc)
    .replace(/\{\{STRATEGY\}\}/g, strategyText);

  msgs.push({ role: "system", content: template });

  const recent = state.getRecentMemory(4);
  recent.forEach(m => {
    const trimmed = m.text.length > 200 ? m.text.substring(0, 200) + "..." : m.text;
    msgs.push({ role: m.role === "user" ? "user" : "assistant", content: trimmed });
  });

  if (images && images.length > 0 && isVisionModel(config.get('API_MODEL'))) {
    const lastUserMsg = msgs.filter(m => m.role === "user").pop();
    if (lastUserMsg) {
      const textContent = lastUserMsg.content;
      lastUserMsg.content = [{ type: "text", text: textContent }];
      for (const img of images) {
        lastUserMsg.content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${img.base64}`, detail: "auto" }
        });
      }
    }
  }

  return msgs;
}

module.exports = { buildMultiRoundMessages };
