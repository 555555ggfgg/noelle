const http = require('http');
const https = require('https');
const config = require('../config');
const { buildMultiRoundMessages } = require('../core/prompt');
const { supportsReasoning } = require('../utils/models');

let streamUsage = null;

function streamAttemptRequest(promptConfig, onStructuredChunk) {
  return new Promise((resolve, reject) => {
    const messages = buildMultiRoundMessages(promptConfig.images);
    let fullContent = "";
    let deepThinkContent = "";
    let resolved = false;
    let contentBuffer = "";
    let inThinkingTag = false;
    let thinkingTagDone = false;

    const finishOnce = (content, think = "") => {
      if (resolved) return;
      resolved = true;
      resolve({ content, think });
    };

    const emitChunk = (type, text) => {
      if (!text) return;
      onStructuredChunk?.({ type, text });
    };

    const parseAndEmit = (rawChunk) => {
      contentBuffer += rawChunk;

      while (contentBuffer.length > 0) {
        if (!thinkingTagDone) {
          if (!inThinkingTag) {
            const tagStart = contentBuffer.search(/<thinking[\s\S]*?>/);
            const tagStartSimple = tagStart === -1 ? contentBuffer.indexOf('<thinking') : -1;
            const startIdx = tagStart >= 0 ? tagStart : tagStartSimple;
            const tagLen = tagStart >= 0 ? contentBuffer.slice(tagStart).indexOf('>') + 1 : '<thinking'.length;

            if (startIdx === -1) {
              if (contentBuffer.length > 100) {
                const overflow = contentBuffer.substring(0, contentBuffer.length - 100);
                contentBuffer = contentBuffer.substring(contentBuffer.length - 100);
                fullContent += overflow;
                emitChunk('content', overflow);
              }
              break;
            }

            if (startIdx > 0) {
              const before = contentBuffer.substring(0, startIdx);
              fullContent += before;
              emitChunk('content', before);
            }

            inThinkingTag = true;
            contentBuffer = contentBuffer.substring(startIdx + tagLen);
          }

          if (inThinkingTag) {
            const tagEnd = contentBuffer.indexOf('</thinking>');
            const tagEndSimple = tagEnd === -1 ? contentBuffer.indexOf('</thinking') : -1;
            const endIdx = tagEnd >= 0 ? tagEnd : tagEndSimple;
            const endLen = tagEnd >= 0 ? '</thinking>'.length : '</thinking'.length;

            if (endIdx === -1) {
              deepThinkContent += contentBuffer;
              emitChunk('think', contentBuffer);
              contentBuffer = "";
              break;
            }

            const thinkText = contentBuffer.substring(0, endIdx);
            deepThinkContent += thinkText;
            emitChunk('think', thinkText);
            inThinkingTag = false;
            thinkingTagDone = true;
            contentBuffer = contentBuffer.substring(endIdx + endLen);
          }
        } else {
          fullContent += contentBuffer;
          emitChunk('content', contentBuffer);
          contentBuffer = "";
          break;
        }
      }
    };

    const backendType = config.get('BACKEND_TYPE');

    if (backendType === "llama.cpp") {
      const llmPrompt = promptConfig.prompt || messages.map(m =>
        `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
      ).join('\n');

      const postData = JSON.stringify({
        prompt: llmPrompt,
        n_predict: promptConfig.n_predict || 512,
        temperature: promptConfig.temperature || 0.9,
        top_p: promptConfig.top_p || 0.9,
        repeat_penalty: promptConfig.repeat_penalty || 1.1,
        stop: promptConfig.stop || ["<|im_end|>"],
        stream: true
      });

      const req = http.request({
        hostname: config.get('LLAMA_HOST'),
        port: config.get('LLAMA_PORT'),
        path: config.get('LLAMA_PATH'),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: config.get('REQUEST_TIMEOUT')
      }, (res) => {
        res.on('data', chunk => {
          try {
            const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.content) parseAndEmit(data.content);
            }
          } catch (e) { }
        });
        res.on('end', () => finishOnce(fullContent, deepThinkContent));
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();

    } else if (backendType === "ollama") {
      const ollamaThinkingModels = ['deepseek-r1', 'qwen3', 'deepseek-v', 'qwen2.5-vl', 'glm-4'];
      const supportsThinking = ollamaThinkingModels.some(m => config.get('API_MODEL').toLowerCase().includes(m));

      const reqBody = {
        model: config.get('API_MODEL'),
        messages: messages,
        stream: true,
        ...(supportsThinking ? { think: true } : {}),
        keep_alive: "30m",
        options: {
          num_ctx: 8192,
          temperature: promptConfig.temperature || 0.95,
          num_predict: promptConfig.n_predict || 512
        }
      };
      const postData = JSON.stringify(reqBody);

      const baseUrl = config.get('API_BASE_URL');
      const ollamaHost = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")
        ? "127.0.0.1" : new URL(baseUrl).hostname;
      const ollamaPort = new URL(baseUrl).port || "11434";

      const req = http.request({
        hostname: ollamaHost,
        port: ollamaPort,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: config.get('REQUEST_TIMEOUT')
      }, (res) => {
        res.on('data', chunk => {
          try {
            const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.message?.thinking) parseAndEmit(data.message.thinking);
              if (data.message?.content) parseAndEmit(data.message.content);
            }
          } catch (e) { }
        });
        res.on('end', () => finishOnce(fullContent, deepThinkContent));
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();

    } else {
      const provider = (config.get('API_PROVIDER') || '').toLowerCase();

      const reqBody = {
        model: config.get('API_MODEL'),
        messages: messages,
        stream: true,
        temperature: promptConfig.temperature || 0.95,
        max_tokens: promptConfig.n_predict || 512,
        stop: promptConfig.stop || ["<|im_end|>"]
      };

      if (promptConfig.repetition_penalty) reqBody.repetition_penalty = promptConfig.repetition_penalty;
      if (promptConfig.top_p) reqBody.top_p = promptConfig.top_p;
      if (promptConfig.top_k) reqBody.top_k = promptConfig.top_k;
      if (promptConfig.seed) reqBody.seed = promptConfig.seed;
      if (promptConfig.frequency_penalty) reqBody.frequency_penalty = promptConfig.frequency_penalty;
      if (promptConfig.presence_penalty) reqBody.presence_penalty = promptConfig.presence_penalty;
      if (promptConfig.min_p) reqBody.min_p = promptConfig.min_p;
      if (promptConfig.top_a) reqBody.top_a = promptConfig.top_a;

      const minP = config.get('MIN_P');
      const topA = config.get('TOP_A');
      const seed = config.get('SEED');
      const freqPen = config.get('FREQUENCY_PENALTY');
      const presPen = config.get('PRESENCE_PENALTY');
      if (minP) reqBody.min_p = minP;
      if (topA) reqBody.top_a = topA;
      if (seed) reqBody.seed = seed;
      if (freqPen) reqBody.frequency_penalty = freqPen;
      if (presPen) reqBody.presence_penalty = presPen;

      if (provider === 'openrouter') {
        const reasoningEffort = config.get('REASONING_EFFORT');
        const reasoningMaxTokens = config.get('REASONING_MAX_TOKENS');
        if (reasoningEffort || reasoningMaxTokens) {
          reqBody.reasoning = {};
          if (reasoningEffort) reqBody.reasoning.effort = reasoningEffort;
          if (reasoningMaxTokens) reqBody.reasoning.max_tokens = reasoningMaxTokens;
        } else {
          const modelId = config.get('API_MODEL');
          supportsReasoning(modelId).then(supports => {
            if (supports && !reqBody.reasoning) {
              reqBody.reasoning = { effort: 'medium' };
            }
          }).catch(() => {});
        }

        const providerSort = config.get('PROVIDER_SORT');
        const providerOrder = config.get('PROVIDER_ORDER');
        const providerAllowFallbacks = config.get('PROVIDER_ALLOW_FALLBACKS');
        if (providerSort || providerOrder || providerAllowFallbacks !== undefined) {
          reqBody.provider = {};
          if (providerSort) reqBody.provider.sort = providerSort;
          if (providerOrder) {
            try { reqBody.provider.order = JSON.parse(providerOrder); } catch (e) {}
          }
          if (providerAllowFallbacks !== undefined) reqBody.provider.allow_fallbacks = providerAllowFallbacks;
        }

        const pluginsConfig = config.get('PLUGINS');
        if (pluginsConfig) {
          try { reqBody.plugins = JSON.parse(pluginsConfig); } catch (e) {}
        }

        const modelsConfig = config.get('OPENROUTER_MODELS');
        if (modelsConfig) {
          try { reqBody.models = JSON.parse(modelsConfig); } catch (e) {}
        }

        const userIdentifier = config.get('OPENROUTER_USER');
        if (userIdentifier) reqBody.user = userIdentifier;
      } else if (provider === 'openai') {
        const reasoningEffort = config.get('REASONING_EFFORT');
        if (reasoningEffort) {
          reqBody.reasoning_effort = reasoningEffort;
        }
        delete reqBody.stop;
      } else if (provider === 'anthropic') {
        reqBody.max_tokens = parseInt(promptConfig.n_predict) || 1024;
        delete reqBody.stop;
        delete reqBody.temperature;
        delete reqBody.top_p;
      }

      const postData = JSON.stringify(reqBody);

      const url = new URL(config.get('API_BASE_URL'));
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      };

      const apiKey = config.get('API_KEY');

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      if (provider === 'openrouter') {
        const referer = config.get('OPENROUTER_REFERER') || 'https://github.com/noelle-ai/noelle-system';
        const title = config.get('OPENROUTER_TITLE') || 'Noelle AI Assistant';
        headers['HTTP-Referer'] = referer;
        headers['X-OpenRouter-Title'] = title;
      } else if (provider === 'anthropic') {
        headers['anthropic-version'] = config.get('ANTHROPIC_API_VERSION') || '2023-06-01';
        headers['x-api-key'] = apiKey;
        delete headers['Authorization'];
      } else if (provider === 'openai') {
        const orgId = config.get('OPENAI_ORG_ID');
        if (orgId) headers['OpenAI-Organization'] = orgId;
      } else if (provider === 'azure') {
        const apiVersion = config.get('OPENAI_API_VERSION');
        if (apiVersion) url.searchParams.set('api-version', apiVersion);
        headers['api-key'] = apiKey;
        delete headers['Authorization'];
      }

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers,
        timeout: config.get('REQUEST_TIMEOUT')
      }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => reject(new Error(`API ${res.statusCode}: ${body.substring(0, 500)}`)));
          return;
        }

        if (provider === 'anthropic') {
          let eventBuffer = '';
          let currentEvent = '';

          res.on('data', chunk => {
            try {
              eventBuffer += chunk.toString('utf8');
              const lines = eventBuffer.split('\n');
              eventBuffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr) continue;
                  const data = JSON.parse(jsonStr);

                  if (currentEvent === 'content_block_delta' && data.delta?.text) {
                    parseAndEmit(data.delta.text);
                  } else if (currentEvent === 'message_start' && data.content) {
                    for (const block of data.content) {
                      if (block.text) parseAndEmit(block.text);
                    }
                  } else if (currentEvent === 'message_delta' && data.usage) {
                    streamUsage = data.usage;
                  }
                }
              }
            } catch (e) { }
          });
          res.on('end', () => finishOnce(fullContent, deepThinkContent));
        } else {
          res.on('data', chunk => {
            try {
              const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6);
                  if (jsonStr && jsonStr !== '[DONE]') {
                    const data = JSON.parse(jsonStr);

                    if (data.error) {
                      console.error(`${provider} stream error:`, data.error.message || JSON.stringify(data.error));
                      if (data.choices?.[0]?.finish_reason === 'error') {
                        finishOnce(fullContent, deepThinkContent);
                        return;
                      }
                    }

                    if (data.usage) {
                      streamUsage = data.usage;
                    }

                    const thinkChunk = data.choices?.[0]?.thinking
                      || data.choices?.[0]?.delta?.reasoning_content
                      || data.choices?.[0]?.delta?.thinking
                      || data.choices?.[0]?.delta?.reasoning
                      || "";
                    if (thinkChunk) {
                      deepThinkContent += thinkChunk;
                      emitChunk('think', thinkChunk);
                    }

                    const reasoningDetails = data.choices?.[0]?.delta?.reasoning_details;
                    if (reasoningDetails && Array.isArray(reasoningDetails)) {
                      for (const detail of reasoningDetails) {
                        if (detail.type === 'reasoning.text' && detail.text) {
                          deepThinkContent += detail.text;
                          emitChunk('think', detail.text);
                        }
                      }
                    }

                    if (data.choices?.[0]?.delta?.content) {
                      parseAndEmit(data.choices[0].delta.content);
                    }
                  }
                }
              }
            } catch (e) { }
          });
          res.on('end', () => finishOnce(fullContent, deepThinkContent));
        }
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();
    }
  });
}

async function askLLMStream(promptConfig) {
  try {
    return await withTimeout(streamAttemptRequest(promptConfig));
  } catch (e) {
    console.error("LLM 请求超时/异常:", e.message);
    return { content: "", think: "" };
  }
}

function withTimeout(promise, timeoutMs, errorMsg) {
  const ms = timeoutMs || config.get('REQUEST_TIMEOUT');
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg || "请求超时")), ms))
  ]);
}

function getStreamUsage() {
  return streamUsage;
}

module.exports = { askLLMStream, getStreamUsage };
