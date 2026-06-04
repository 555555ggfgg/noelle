/**
 * Noelle MCP Server — Official Anthropic MCP SDK v1.29.0
 * Protocol: 2025-11-25
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ALLOWED_DIR = path.resolve('.');

function sanitizePath(userPath) {
  const resolved = path.resolve(userPath);
  if (!resolved.startsWith(ALLOWED_DIR)) {
    throw new Error(`路径不允许: ${userPath} (在允许目录之外)`);
  }
  return resolved;
}
const mcpSdkDir = path.dirname(require.resolve('@modelcontextprotocol/sdk/server'));
const { Server } = require('@modelcontextprotocol/sdk/server');
const { StreamableHTTPServerTransport } = require(path.join(mcpSdkDir, 'streamableHttp.js'));
const {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
  PingRequestSchema, CompleteRequestSchema,
  SetLevelRequestSchema
} = require(path.join(mcpSdkDir, '..', 'types.js'));

const config = require('../config');
const state = require('../state');
const { imageToBase64, isVisionModel } = require('../utils/image');
const {
  saveConversation, loadConversation, listConversations,
  deleteConversation, createNewConversation
} = require('../ws/conversations');



// ===================== Tool Implementations =====================
async function readFile(args) {
  try {
    const safePath = sanitizePath(args.path);
    const content = fs.readFileSync(safePath, 'utf8');
    return { content: [{ type: "text", text: content.substring(0, 50000) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `读取失败: ${e.message}` }], isError: true };
  }
}

async function editFile(args) {
  try {
    const safePath = sanitizePath(args.path);
    let content = fs.readFileSync(safePath, 'utf8');
    if (!content.includes(args.old_text)) {
      return { content: [{ type: "text", text: "未找到要替换的文本" }], isError: true };
    }
    content = content.replace(args.old_text, args.new_text);
    fs.writeFileSync(safePath, content, 'utf8');
    return { content: [{ type: "text", text: `已编辑 ${safePath}` }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `编辑失败: ${e.message}` }], isError: true };
  }
}

function isPrivateIP(urlObj) {
  const hostname = urlObj.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  if (/^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
  return false;
}

async function httpGet(url, timeoutMs = 15000, maxRedirects = 5) {
  const urlObj = new URL(url);
  const client = urlObj.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectCount) => {
      const currentUrlObj = new URL(currentUrl);
      const opts = {
        hostname: currentUrlObj.hostname,
        port: currentUrlObj.port || (currentUrlObj.protocol === 'https:' ? 443 : 80),
        path: currentUrlObj.pathname + currentUrlObj.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/json,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate'
        }
      };

      const req = client.request(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            return reject(new Error("重定向次数过多"));
          }
          const redirectUrl = new URL(res.headers.location, currentUrl).href;
          res.resume();
          return doRequest(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        const chunks = [];
        const encoding = res.headers['content-encoding'];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          let buffer = Buffer.concat(chunks);
          if (encoding === 'gzip') {
            try {
              const zlib = require('zlib');
              buffer = zlib.gunzipSync(buffer);
            } catch (e) {
              return reject(new Error("解压缩失败"));
            }
          } else if (encoding === 'deflate') {
            try {
              const zlib = require('zlib');
              buffer = zlib.inflateSync(buffer);
            } catch (e) {
              return reject(new Error("解压缩失败"));
            }
          }
          const contentType = (res.headers['content-type'] || '').toLowerCase();
          let charset = 'utf8';
          const charsetMatch = contentType.match(/charset=([^;]+)/);
          if (charsetMatch) charset = charsetMatch[1].trim();
          try {
            const text = buffer.toString(charset).substring(0, 50000);
            resolve(text);
          } catch (e) {
            resolve(buffer.toString('utf8').substring(0, 50000));
          }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error("请求超时")); });
      req.on('error', reject);
      req.end();
    };

    doRequest(url, 0);
  });
}

async function webFetch(args) {
  try {
    const urlObj = new URL(args.url);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { content: [{ type: "text", text: "仅支持 http/https 协议" }], isError: true };
    }
    if (isPrivateIP(urlObj)) {
      return { content: [{ type: "text", text: "不允许访问内网地址" }], isError: true };
    }
    const content = await httpGet(args.url);
    return { content: [{ type: "text", text: content }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `获取失败: ${e.message}` }], isError: true };
  }
}

async function webSearch(args) {
  const engines = [
    { name: 'Bing中国', buildUrl: q => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN`, parse: parseBing },
    { name: 'DuckDuckGo', buildUrl: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo }
  ];
  for (const engine of engines) {
    try {
      const html = await httpGet(engine.buildUrl(args.query));
      const items = engine.parse(html);
      if (items.length > 0) {
        const text = items.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
        ).join('\n\n');
        return { content: [{ type: "text", text }], isError: false };
      }
    } catch (e) {
      console.warn(`⚠️ ${engine.name} 搜索失败: ${e.message}`);
    }
  }
  return { content: [{ type: "text", text: `"${args.query}" 无搜索结果（所有引擎均失败）` }], isError: false };
}

function parseBing(html) {
  const items = [];
  const liRegex = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) && items.length < 8) {
    const block = liMatch[1];
    const titleMatch = block.match(/<h2>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (titleMatch) {
      items.push({
        title: titleMatch[2].replace(/<[^>]+>/g, '').trim(),
        url: titleMatch[1],
        snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''
      });
    }
  }
  return items;
}

function parseDuckDuckGo(html) {
  const items = [];
  const regex = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && items.length < 8) {
    const title = match[1].replace(/<[^>]+>/g, '').trim();
    const snippet = match[2].replace(/<[^>]+>/g, '').trim();
    if (title) items.push({ title, snippet, url: '' });
  }
  return items;
}

const SHELL_BLOCKLIST = ['rm -rf /', 'mkfs', 'dd if=', ':(){ :|:& };:', '> /dev/', 'shutdown', 'reboot', 'poweroff', 'init 0', 'init 6'];
function isBlockedCommand(cmd) {
  return SHELL_BLOCKLIST.some(bad => cmd.toLowerCase().includes(bad));
}

async function shellExec(args) {
  if (isBlockedCommand(args.command)) {
    return { content: [{ type: "text", text: "命令被系统安全策略禁止" }], isError: true };
  }
  return new Promise((resolve) => {
    const maxTimeout = Math.min(args.timeout || 10000, 60000);
    exec(args.command, { timeout: maxTimeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ content: [{ type: "text", text: `错误: ${error.message}\n${stderr}` }], isError: true });
      } else {
        resolve({ content: [{ type: "text", text: (stdout || "").substring(0, 50000) }], isError: false });
      }
    });
  });
}

async function analyzeImage(args) {
  try {
    if (!isVisionModel(config.get('API_MODEL'))) {
      return { content: [{ type: "text", text: "当前模型不支持图像分析" }], isError: true };
    }
    const safePath = sanitizePath(args.path);
    const base64 = await imageToBase64(safePath);
    return { content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` }, prompt: args.prompt || "详细描述这张图片的内容" }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `图像分析失败: ${e.message}` }], isError: true };
  }
}

// ===================== Conversation Tools =====================
async function listConversationsTool(args) {
  try {
    const convs = listConversations();
    let results = convs;
    if (args?.query) {
      const q = args.query.toLowerCase();
      results = convs.filter(c => c.name.toLowerCase().includes(q));
    }
    const text = results.length === 0
      ? "暂无对话"
      : results.map(c => `ID: ${c.id} | ${c.name} | ${new Date(c.updatedAt).toLocaleString()}`).join('\n');
    return { content: [{ type: "text", text }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `获取对话列表失败: ${e.message}` }], isError: true };
  }
}

async function getConversationTool(args) {
  try {
    const convPath = path.join(config.get('CONVERSATIONS_PATH'), `${args.id}.json`);
    if (!fs.existsSync(convPath)) {
      return { content: [{ type: "text", text: `对话 ${args.id} 不存在` }], isError: true };
    }
    const data = JSON.parse(fs.readFileSync(convPath, 'utf8'));
    let messages = data.memory || [];
    if (args.lastN) messages = messages.slice(-args.lastN);
    const text = [
      `对话: ${data.name || args.id}`,
      `创建: ${new Date(data.createdAt).toLocaleString()}`,
      `HP: ${data.HP} | MP: ${data.MP} | Desire: ${data.Desire} | Like: ${data.Like}`,
      `消息数: ${messages.length}`,
      '',
      ...messages.map(m => `[${m.role}] ${m.text}`)
    ].join('\n');
    return { content: [{ type: "text", text }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `获取对话失败: ${e.message}` }], isError: true };
  }
}

async function createConversationTool() {
  try {
    saveConversation(state.currentConversationId);
    const id = createNewConversation();
    return { content: [{ type: "text", text: `✅ 已创建新对话: ${id}` }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `创建对话失败: ${e.message}` }], isError: true };
  }
}

async function switchConversationTool(args) {
  try {
    saveConversation(state.currentConversationId);
    const ok = loadConversation(args.id);
    if (!ok) return { content: [{ type: "text", text: `对话 ${args.id} 不存在` }], isError: true };
    return { content: [{ type: "text", text: `✅ 已切换到对话: ${args.id}` }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `切换对话失败: ${e.message}` }], isError: true };
  }
}

async function deleteConversationTool(args) {
  try {
    if (args.id === state.currentConversationId) createNewConversation();
    const ok = deleteConversation(args.id);
    if (!ok) return { content: [{ type: "text", text: `对话 ${args.id} 不存在` }], isError: true };
    return { content: [{ type: "text", text: `✅ 已删除对话: ${args.id}` }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `删除对话失败: ${e.message}` }], isError: true };
  }
}

async function continueConversationTool(args) {
  try {
    saveConversation(state.currentConversationId);
    const ok = loadConversation(args.id);
    if (!ok) return { content: [{ type: "text", text: `对话 ${args.id} 不存在` }], isError: true };
    const recent = state.getRecentMemory(3).map(m => m.text);
    return {
      content: [{ type: "text", text: `✅ 已恢复对话: ${args.id}\n最近消息:\n${recent.map((t, i) => `  ${i + 1}. ${t.substring(0, 100)}`).join('\n')}` }],
      isError: false
    };
  } catch (e) {
    return { content: [{ type: "text", text: `延续对话失败: ${e.message}` }], isError: true };
  }
}

async function searchConversationsTool(args) {
  try {
    const convs = listConversations();
    const keyword = args.keyword.toLowerCase();
    const maxResults = args.maxResults || 10;
    const matches = [];
    for (const c of convs) {
      const convPath = path.join(config.get('CONVERSATIONS_PATH'), `${c.id}.json`);
      try {
        const data = JSON.parse(fs.readFileSync(convPath, 'utf8'));
        const mems = data.memory || [];
        for (const m of mems) {
          if (m.text.toLowerCase().includes(keyword)) {
            matches.push({ convId: c.id, convName: c.name, role: m.role, text: m.text.substring(0, 200) });
            if (matches.length >= maxResults) break;
          }
        }
      } catch (e) { }
      if (matches.length >= maxResults) break;
    }
    if (matches.length === 0) {
      return { content: [{ type: "text", text: `未找到包含 "${args.keyword}" 的消息` }], isError: false };
    }
    return { content: [{ type: "text", text: `找到 ${matches.length} 条结果:\n\n${matches.map(m => `[${m.convId}] ${m.role}: ${m.text}`).join('\n---\n')}` }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `搜索对话失败: ${e.message}` }], isError: true };
  }
}

// ===================== Tool Dispatch =====================
const handlers = {
  read_file: readFile, edit_file: editFile, web_fetch: webFetch,
  web_search: webSearch, shell_exec: shellExec, analyze_image: analyzeImage,
  list_conversations: listConversationsTool, get_conversation: getConversationTool,
  create_conversation: createConversationTool, switch_conversation: switchConversationTool,
  delete_conversation: deleteConversationTool, continue_conversation: continueConversationTool,
  search_conversations: searchConversationsTool
};

const getToolDefs = () => [
  { name: "read_file", description: "读取文件内容", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "edit_file", description: "编辑文件，替换指定文本", inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "web_fetch", description: "获取网页内容", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "web_search", description: "搜索引擎搜索（DuckDuckGo）", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "shell_exec", description: "执行shell命令", inputSchema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } },
  { name: "analyze_image", description: "分析图像内容（仅视觉模型可用）", inputSchema: { type: "object", properties: { path: { type: "string" }, prompt: { type: "string" } }, required: ["path"] } },
  { name: "list_conversations", description: "列出所有历史对话（支持关键词筛选）", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "get_conversation", description: "获取指定对话的完整历史记录", inputSchema: { type: "object", properties: { id: { type: "string" }, lastN: { type: "number" } }, required: ["id"] } },
  { name: "create_conversation", description: "创建新的空白对话", inputSchema: { type: "object", properties: {} } },
  { name: "switch_conversation", description: "切换到指定对话（当前对话自动保存）", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_conversation", description: "删除指定对话", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "continue_conversation", description: "延续/恢复一个历史对话", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "search_conversations", description: "全文搜索所有对话中的历史消息", inputSchema: { type: "object", properties: { keyword: { type: "string" }, maxResults: { type: "number" } }, required: ["keyword"] } }
];

// ===================== Resource Readers =====================
async function readResource(uri) {
  if (uri === "noelle://status") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ hp: state.HP, mp: state.MP, desire: state.Desire, like: state.Like, memoryCount: state.memory.length, factsCount: state.profile.facts.length, rulesCount: state.profile.rules.length, currentConversation: state.currentConversationId, role: state.ROLE_INFO }, null, 2) }] };
  }
  if (uri === "noelle://profile") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state.profile, null, 2) }] };
  }
  if (uri === "noelle://conversations") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(listConversations(), null, 2) }] };
  }
  if (uri === "noelle://config") {
    const c = { ...config.getAll() };
    if (c.API_KEY) c.API_KEY = "***";
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(c, null, 2) }] };
  }
  const convMatch = uri.match(/^noelle:\/\/conversations\/([^/]+)$/);
  if (convMatch) {
    const convPath = path.join(config.get('CONVERSATIONS_PATH'), `${convMatch[1]}.json`);
    if (!fs.existsSync(convPath)) return { contents: [] };
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(JSON.parse(fs.readFileSync(convPath, 'utf8')), null, 2) }] };
  }
  const recentMatch = uri.match(/^noelle:\/\/conversations\/([^/]+)\/recent\/(\d+)$/);
  if (recentMatch) {
    const convPath = path.join(config.get('CONVERSATIONS_PATH'), `${recentMatch[1]}.json`);
    if (!fs.existsSync(convPath)) return { contents: [] };
    const data = JSON.parse(fs.readFileSync(convPath, 'utf8'));
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ id: recentMatch[1], name: data.name, recentMessages: (data.memory || []).slice(-parseInt(recentMatch[2], 10)) }, null, 2) }] };
  }
  throw new Error(`Resource not found: ${uri}`);
}

// ===================== Prompt Implementations =====================
async function getPrompt(name, args) {
  if (name === "character_intro") {
    return { description: "诺艾尔的角色介绍", messages: [{ role: "user", content: { type: "text", text: `介绍角色：${state.ROLE_INFO.name}\n身份：${state.ROLE_INFO.role}\n性格：${state.ROLE_INFO.personality}\n当前状态：HP ${state.HP}/100, MP ${state.MP}/100, 好感度 ${state.Like}/999, 依赖度 ${state.Desire}/100` } }] };
  }
  if (name === "chat_start") {
    const userName = args?.userName || '先生';
    return { description: "开始新对话", messages: [{ role: "system", content: { type: "text", text: `你是${state.ROLE_INFO.name}，${state.ROLE_INFO.personality}。胆小内向敏感，轻声细语，统一用"${userName}"称呼用户。当前好感度${state.Like}，依赖度${state.Desire}。` } }] };
  }
  if (name === "conversation_summary") {
    let convData = { memory: [] };
    if (args?.convId) {
      const convPath = path.join(config.get('CONVERSATIONS_PATH'), `${args.convId}.json`);
      if (fs.existsSync(convPath)) convData = JSON.parse(fs.readFileSync(convPath, 'utf8'));
    }
    const recentMsgs = (convData.memory || []).slice(-10).map(m => `[${m.role}] ${m.text.substring(0, 200)}`).join('\n');
    return { description: "对话摘要", messages: [{ role: "user", content: { type: "text", text: `请总结以下对话的核心内容、情感变化和关键事件：\n\n${recentMsgs}` } }] };
  }
  throw new Error(`Unknown prompt: ${name}`);
}

const promptDefs = [
  { name: "character_intro", description: "诺艾尔角色介绍", arguments: [] },
  { name: "chat_start", description: "开始新对话的系统提示词", arguments: [{ name: "userName", description: "用户称呼（默认: 先生）", required: false }] },
  { name: "conversation_summary", description: "对话摘要提示词", arguments: [{ name: "convId", description: "对话ID", required: false }] }
];

// ===================== MCP Server Setup =====================
function createMCPServer(port, bindIp) {
  const transport = new StreamableHTTPServerTransport({ sessionId: `noelle-${Date.now()}` });

  const server = new Server(
    { name: "noelle-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {}
      }
    }
  );

  // ---- Tools ----
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefs() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return await handler(args || {});
  });

  // ---- Resources ----
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "noelle://status", name: "诺艾尔当前状态", description: "当前角色属性状态", mimeType: "application/json" },
      { uri: "noelle://profile", name: "诺艾尔角色档案", description: "角色设定档案（规则/事实/人设）", mimeType: "application/json" },
      { uri: "noelle://conversations", name: "对话列表", description: "所有历史对话列表", mimeType: "application/json" },
      { uri: "noelle://config", name: "系统配置", description: "当前系统配置", mimeType: "application/json" }
    ]
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "noelle://conversations/{id}", name: "指定对话", description: "获取指定ID的完整对话历史", mimeType: "application/json" },
      { uriTemplate: "noelle://conversations/{id}/recent/{n}", name: "指定对话最近N条消息", description: "获取指定对话的最近N条消息", mimeType: "application/json" }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return await readResource(req.params.uri);
  });

  // ---- Prompts ----
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: promptDefs }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    return await getPrompt(req.params.name, req.params.arguments);
  });

  // ---- Ping ----
  server.setRequestHandler(PingRequestSchema, async () => ({}));

  // ---- Logging ----
  server.setRequestHandler(SetLevelRequestSchema, async () => ({}));

  // ---- Completion ----
  server.setRequestHandler(CompleteRequestSchema, async () => ({
    completion: { values: [], hasMore: false }
  }));

  // ---- Connect ----
  server.connect(transport);

  // ---- HTTP Handler ----
  const httpHandler = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: "noelle-mcp",
        version: "1.0.0",
        protocol: "2025-11-25",
        sdk: "@modelcontextprotocol/sdk v1.29.0",
        tools: getToolDefs().length,
        endpoints: ["/mcp (JSON-RPC 2.0)"]
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404); res.end();
  };

  const serverInstance = http.createServer(httpHandler);
  serverInstance.listen(port, bindIp, () => {
    const sdkPkg = require(path.join(mcpSdkDir, '..', '..', '..', 'package.json'));
    console.log(`🤖 MCP Server (Anthropic SDK ${sdkPkg.version})`);
    console.log(`   Protocol: 2025-11-25 | Endpoint: http://${bindIp}:${port}/mcp`);
    console.log(`   Tools: ${getToolDefs().length} | Resources: 4+2 | Prompts: 3`);
  });

  return serverInstance;
}

const dynamicTools = [];
let _toolsCache = null;

function getTools() {
  if (!_toolsCache) _toolsCache = [...getToolDefs(), ...dynamicTools];
  return _toolsCache;
}

function registerTool(tool) {
  _toolsCache = null;
  handlers[tool.name] = tool.handler || (async () => ({ content: [{ type: "text", text: "stub" }] }));
  dynamicTools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
}

async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`未知工具: ${name}`);
  return await handler(args || {});
}

module.exports = { getTools, registerTool, createMCPServer, executeTool };
