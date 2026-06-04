const state = require('../state');
const config = require('../config');
const { buildMultiRoundMessages } = require('./prompt');
const { askLLMStream, getStreamUsage } = require('../llm/stream');
const { executeTool } = require('../mcp/server');
const { saveThinkLog } = require('./evolve');
const display = require('../ui/display');

function repairJSON(text) {
  let fixed = text;

  // Stage 1: Extract from markdown code blocks
  const codeBlockMatch = fixed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) fixed = codeBlockMatch[1];

  // Stage 2: Strip leading/trailing non-JSON text
  fixed = fixed.replace(/^[\s\S]*?(\{[ \t\n\r]*)$/m, '$1');
  fixed = fixed.replace(/^[\s\S]*?(\{)/, '$1');
  const lastBrace = fixed.lastIndexOf('}');
  if (lastBrace >= 0) fixed = fixed.substring(0, lastBrace + 1);

  // Stage 3: Remove comments (both // and /* */)
  fixed = fixed.replace(/\/\/[^\n]*/g, '');
  fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

  // Stage 4: Normalize whitespace in structural positions
  fixed = fixed.replace(/[ \t]+\n/g, '\n');
  fixed = fixed.replace(/\n{2,}/g, '\n');

  // Stage 5: Fix unquoted property names (including Chinese/quoted multi-byte)
  fixed = fixed.replace(/([{,]\s*)(['"]?)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$3":');

  // Stage 6: Replace single quotes around values with double quotes
  fixed = fixed.replace(/:\s*'([^']*?)'\s*([,}])/g, ':"$1"$2');

  // Stage 7: Fix trailing/duplicate commas
  fixed = fixed.replace(/,\s*}/g, '}');
  fixed = fixed.replace(/,\s*]/g, ']');
  fixed = fixed.replace(/,{2,}/g, ',');
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // Stage 8: Replace undefined/null/NaN literal with empty string
  fixed = fixed.replace(/:\s*undefined\s*([,}])/g, ':""$1');
  fixed = fixed.replace(/:\s*NaN\s*([,}])/g, ':0$1');

  // Stage 9: Remove ellipsis/...
  fixed = fixed.replace(/\.\.\./g, '');

  // Stage 10: Normalize whitespace
  fixed = fixed.replace(/\t+/g, ' ');
  fixed = fixed.replace(/\r\n/g, '\n');
  fixed = fixed.replace(/\n\s*/g, ' ');

  // Stage 11: Balance braces - add missing closing brace if needed
  let depth = 0;
  let hasContent = false;
  for (const ch of fixed) {
    if (ch === '{') { depth++; hasContent = true; }
    else if (ch === '}') depth--;
  }
  if (hasContent && depth > 0) {
    fixed += '}'.repeat(depth);
  }

  // Stage 12: Fix common string escaping issues
  fixed = fixed.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  fixed = fixed.replace(/[\x00-\x1f](?![^]*")/g, '');

  // Stage 13: Fix missing colons between keys and values (model writes {"key value"} instead of {"key":"value"})
  const knownKeys = ['reply', 'emotion', 'action', 'desire_change', 'like_change', 'tool_call', 'thinking', 'thought', 'text', 'content', 'name', 'arguments', 'url', 'path', 'tool', 'type', 'message', 'role'];
  const keyPattern = knownKeys.sort((a, b) => b.length - a.length).join('|');
  fixed = fixed.replace(
    new RegExp(`([{,])"(${keyPattern})([^":,\\]}]{2,})"`, 'g'),
    '$1"$2":"$3"'
  );

  // Stage 13b: Strip orphaned known-key strings (model writes {...,"emotion",...} with no value)
  fixed = fixed.replace(
    new RegExp(`([{,])"(${keyPattern})"(?=[,}])`, 'g'),
    '$1'
  );

  // Stage 14: Last resort - try to extract first complete JSON object
  const firstBrace = fixed.indexOf('{');
  if (firstBrace >= 0) {
    let brCount = 0;
    let endIdx = -1;
    for (let i = firstBrace; i < fixed.length; i++) {
      if (fixed[i] === '{') brCount++;
      else if (fixed[i] === '}') {
        brCount--;
        if (brCount === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx > 0) fixed = fixed.substring(firstBrace, endIdx);
  }

  return fixed;
}

function extractPlainText(raw) {
  if (!raw) return "";
  return raw
    .replace(/<thinking[\s\S]*?<\/thinking>/g, '')
    .replace(/<thinking[\s\S]*?(?=\{)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\{[\s\S]*\}/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateFallbackReply(rawReply) {
  const fallback = extractPlainText(rawReply);
  return {
    reply: fallback || "嗯...我在呢。",
    emotion: "害羞",
    action: "低下头，手指轻轻绕着头发",
    desire_change: 0,
    like_change: 0,
    tool_call: null
  };
}

let lastTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

async function chatWithOwen(userText, images = [], streamingCallbacks = null) {
  const messages = buildMultiRoundMessages(images);
  const prompt = messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');

  display.startGeneratingTimer();
  display.startThinkingStream();

  let chunkBuffer = "";
  const { content: rawReply, think: deepThink } = await askLLMStream({
    onStructuredChunk: (chunk) => {
      if (chunk.type === "think") display.feedThinkingChunk(chunk.text);
      if (chunk.type === "content") {
        chunkBuffer += chunk.text;
        streamingCallbacks?.onContent?.(chunk.text);
      }
    },
    prompt: prompt,
    n_predict: 512,
    temperature: 0.95,
    repeat_penalty: 1.18,
    images: images
  });

  display.endThinkingStream();
  display.stopGeneratingTimer();

  if (!rawReply) return null;

  let rawData;

  try {
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        rawData = JSON.parse(jsonMatch[0]);
      } catch (e) {
        const repaired = repairJSON(jsonMatch[0]);
        try {
          rawData = JSON.parse(repaired);
          console.log("🔧 JSON已自动修复");
        } catch (e2) {
          rawData = null;
        }
      }
    }

    if (!rawData) {
      rawData = generateFallbackReply(rawReply);
    }

    let cleanText = rawData.reply || "";
    cleanText = cleanText.replace(/哥哥|兄长|提尔德/g, "先生");
    if (!cleanText || cleanText === "undefined") cleanText = "对不起，我没听清...";

    const thoughtFromReply = rawData.thinking || rawData.thought || "";
    const mergedThinking = [deepThink, thoughtFromReply].filter(Boolean).join("\n");

    saveThinkLog(mergedThinking, userText, rawReply);

    console.log(`😶 情绪: ${rawData.emotion ?? "normal"} | 🤌 动作: ${rawData.action || "安静站在一旁"}`);

    const streamUsage = getStreamUsage();
    let promptEst, completionEst;
    if (streamUsage) {
      promptEst = streamUsage.prompt_tokens || 0;
      completionEst = streamUsage.completion_tokens || 0;
      lastTokenUsage = {
        prompt_tokens: promptEst,
        completion_tokens: completionEst,
        total_tokens: (promptEst + completionEst) || 0
      };
      console.log(`📊 Token: 输入${promptEst} | 输出${completionEst} | 共${lastTokenUsage.total_tokens}`);
    } else {
      promptEst = Math.ceil(prompt.length / 2.5);
      completionEst = Math.ceil(rawReply.length / 2.5);
      lastTokenUsage = {
        prompt_tokens: promptEst,
        completion_tokens: completionEst,
        total_tokens: promptEst + completionEst
      };
      console.log(`📊 Token: 输入${promptEst} | 输出${completionEst} | 共${promptEst + completionEst}`);
    }

    process.stdout.write(`${state.ROLE_INFO.name}: `);
    await display.typeWriter(cleanText);

    if (rawData.tool_call && rawData.tool_call.name) {
      const tc = rawData.tool_call;
      console.log(`\n🔧 ${state.ROLE_INFO.name}请求使用工具: ${tc.name}`);
      const toolResult = await executeTool(tc.name, tc.arguments || {});
      const resultText = toolResult.isError
        ? `工具执行失败: ${toolResult.content[0].text}`
        : toolResult.content[0].text;
      console.log(`📋 工具结果: ${resultText.substring(0, 500)}`);

      state.addMemory("ai", `${cleanText} [使用了${tc.name}]`);
      const followUpPrompt = `你使用了工具${tc.name}，结果是:\n${resultText.substring(0, 3000)}\n\n请根据工具结果继续回复。`;
      state.addMemory("user", followUpPrompt);
      return await chatWithOwen(followUpPrompt);
    }

    return {
      raw: rawReply,
      rawData: rawData,
      clean: cleanText,
      thinking: mergedThinking,
      emotion: rawData.emotion ?? "normal",
      action: rawData.action ?? "",
      likeChange: rawData.like_change || 0,
      desireChange: rawData.desire_change || 0,
      promptTokens: promptEst,
      completionTokens: completionEst
    };
  } catch (e) {
    console.error("JSON解析失败:", e.message);
    return null;
  }
}

function getTokenUsage() {
  return lastTokenUsage;
}

module.exports = { chatWithOwen, getTokenUsage };
