const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execFile, execSync, spawn, exec } = require('child_process');
const chalk = require('chalk');
const readlineSync = require('readline-sync');
const inquirer = require('inquirer');
const net = require('net');
const readline = require('readline');
const os = require('os'); // 剪贴板临时文件
const clipboardy = require('clipboardy'); // 剪贴板支持
const sharp = require('sharp'); // 图像处理
//runWizard();
// ====================== 全局配置（从.noll-env加载） ======================
let CONFIG = {
  PORT: 3232,
  BIND_IP: "127.0.0.1",
  BACKEND_TYPE: "ollama", // llama.cpp / ollama / api
  SSL_ENABLED: false,
  SSL_CERT: "",
  SSL_KEY: "",
  
  // OpenAI兼容API配置
  OPENAI_API_ENABLED: false,
  OPENAI_API_PORT: 8080,
  
  // llama.cpp 配置
  LLAMA_HOST: "127.0.0.1",
  LLAMA_PORT: 8080,
  LLAMA_PATH: "/completion",
  
  // API 配置（已按各厂商官方文档对齐）
  API_PROVIDER: "openrouter",
  API_KEY: "",
  API_MODEL: "qwen2.5-vl:7b",
  API_BASE_URL: "http://localhost:11434/v1/chat/completions",
  
  // 系统核心配置
  THOUGHT_COOLDOWN: 10000,
  EVOLUTION_INTERVAL: 6,
  REFLECTION_INTERVAL: 12,
  AFK_THRESHOLD: 300,
  STREAM_TYPING_SPEED: 60, // 打字机间隔ms
  REQUEST_TIMEOUT: 300000,  // 请求超时5分钟
  ENABLE_DEEP_THINK: true,  // 深度思考
  SAVE_THINK_LOG: true,     // 思考日志
  THINK_LOG_PATH: "./think_logs/",
  STRATEGY: "standard", // standard | cot | cod | tot | self-refine
  
  // 新增：多对话管理配置
  CONVERSATIONS_PATH: "./conversations/",
  CURRENT_CONVERSATION: "default",
  
  // 新增：视觉模型配置
  MAX_IMAGE_SIZE: 1024, // 图像最大宽度
  IMAGE_QUALITY: 80     // JPEG压缩质量
};

// ====================== 全局状态变量 ======================
let isProcessing = false;
let isEvolving = false;
let HP = 100;
let MP = 98;
let Desire = 3;
let Like = 599;
let memory = [];
let profile = { facts: [], rules: [] };
let lastInteractionTime = Date.now();
let lastThoughtContent = "先生今天会来吗...";
let currentMode = "Private";
let wssServer = null;
let httpServer = null;
let currentChatMode = null; // "websocket" / "cli" / null
let consciousnessTimer = null; // 防止多次启动潜意识循环
let attachedFiles = []; // [{name, content, type}]
let commandHistory = []; // 命令历史记录
let conversations = {}; // 多对话存储
let currentConversationId = "default";
let currentPickerDir = process.cwd(); // 多级文件选择器当前目录

// 角色全局定义
const ROLE_INFO = {
  name: "诺艾儿",
  role: "内向胆小猫耳少女",
  gender: "女",
  personality: "敏感、缺安全感、轻声细语、依赖先生"
};

// 视觉模型自动检测
const VISION_MODELS = ['vl', 'vision', 'gpt-4o', 'gemini', 'claude-3-opus', 'claude-3-sonnet', 'qwen2.5-vl'];
function isVisionModel(modelName) {
  return VISION_MODELS.some(m => modelName.toLowerCase().includes(m));
}

// ====================== MCP Tool 定义（Anthropic标准） ======================
const MCP_TOOLS = [
  {
    name: "read_file",
    description: "读取文件内容",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "文件路径" } }, required: ["path"] }
  },
  {
    name: "edit_file",
    description: "编辑文件，替换指定文本",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "文件路径" }, old_text: { type: "string", description: "要替换的文本" }, new_text: { type: "string", description: "替换后的文本" } }, required: ["path", "old_text", "new_text"] }
  },
  {
    name: "web_fetch",
    description: "获取网页内容",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL地址" } }, required: ["url"] }
  },
  {
    name: "web_search",
    description: "搜索引擎搜索",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "搜索关键词" } }, required: ["query"] }
  },
  {
    name: "shell_exec",
    description: "执行shell命令",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Shell命令" }, timeout: { type: "number", description: "超时毫秒(默认10000)" } }, required: ["command"] }
  },
  {
    name: "analyze_image",
    description: "分析图像内容（仅视觉模型可用）",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "图像文件路径" }, prompt: { type: "string", description: "分析提示词" } }, required: ["path"] }
  }
];

// MCP Tool 执行器（已按行业标准重写）
async function executeMCPTool(name, args) {
  switch (name) {
    case "read_file": {
      try {
        const content = fs.readFileSync(args.path, 'utf8');
        return { content: [{ type: "text", text: content.substring(0, 50000) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `读取失败: ${e.message}` }], isError: true };
      }
    }
    case "edit_file": {
      try {
        let content = fs.readFileSync(args.path, 'utf8');
        if (!content.includes(args.old_text)) {
          return { content: [{ type: "text", text: `未找到要替换的文本` }], isError: true };
        }
        content = content.replace(args.old_text, args.new_text);
        fs.writeFileSync(args.path, content, 'utf8');
        return { content: [{ type: "text", text: `已编辑 ${args.path}` }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `编辑失败: ${e.message}` }], isError: true };
      }
    }
    case "web_fetch": {
      try {
        const content = await new Promise((resolve, reject) => {
          const urlObj = new URL(args.url);
          const client = urlObj.protocol === 'https:' ? https : http;
          client.get(args.url, { 
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            }
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data.substring(0, 50000)));
          }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error("请求超时")); });
        });
        return { content: [{ type: "text", text: content }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `获取失败: ${e.message}` }], isError: true };
      }
    }
    case "web_search": {
      try {
        const html = await new Promise((resolve, reject) => {
          https.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, { 
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            }
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
          }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error("搜索超时")); });
        });
        const results = [];
        const regex = /class="result__a"[^>]*>([^<]+)<[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = regex.exec(html)) && results.length < 5) {
          results.push(`- ${match[1].trim()}: ${match[2].replace(/<[^>]+>/g, '').trim()}`);
        }
        const text = results.length > 0 ? results.join('\n') : "无搜索结果";
        return { content: [{ type: "text", text }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `搜索失败: ${e.message}` }], isError: true };
      }
    }
    case "shell_exec": {
      return new Promise((resolve) => {
        exec(args.command, { timeout: args.timeout || 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            resolve({ content: [{ type: "text", text: `错误: ${error.message}\n${stderr}` }], isError: true });
          } else {
            resolve({ content: [{ type: "text", text: (stdout || "").substring(0, 50000) }], isError: false });
          }
        });
      });
    }
    case "analyze_image": {
      try {
        if (!isVisionModel(CONFIG.API_MODEL)) {
          return { content: [{ type: "text", text: "当前模型不支持图像分析，请切换到视觉模型" }], isError: true };
        }
        const base64 = await imageToBase64(args.path);
        return { 
          content: [{ 
            type: "image_url", 
            image_url: { url: `data:image/jpeg;base64,${base64}` },
            prompt: args.prompt || "详细描述这张图片的内容"
          }], 
          isError: false 
        };
      } catch (e) {
        return { content: [{ type: "text", text: `图像分析失败: ${e.message}` }], isError: true };
      }
    }
    default:
      return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
  }
}

// MCP JSON-RPC 处理器
function handleMCPRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        let result;

        if (msg.method === 'initialize') {
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "noelle-mcp", version: "1.0.0" }
          };
        } else if (msg.method === 'tools/list') {
          result = { tools: MCP_TOOLS };
        } else if (msg.method === 'tools/call') {
          result = await executeMCPTool(msg.params?.name, msg.params?.arguments || {});
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `未知方法: ${msg.method}` } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: "Not found" }));
}

// 服务器URL存储
let serverURLs = {};

// ====================== 基础工具函数 ======================
function getBeautyTriad(thought, emotion, action) {
  return `
💭内心独白：${thought}
😶情绪状态：${emotion}
🤌肢体动作：${action}
`;
}

// 生成进度动画计时器
let generatingTimer = null;
let generatingStart = 0;
const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}S`;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(0);
  return `${m}M${sec}S`;
}

function startGeneratingTimer() {
  generatingStart = Date.now();
  let frameIdx = 0;
  generatingTimer = setInterval(() => {
    const elapsed = Date.now() - generatingStart;
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    frameIdx++;
    process.stdout.write(`\r${chalk.magenta(frame)} ${chalk.gray(`生成中`)} ${chalk.bold.white(formatElapsed(elapsed))}   `);
  }, 120);
}

function stopGeneratingTimer() {
  if (generatingTimer) {
    clearInterval(generatingTimer);
    generatingTimer = null;
    const elapsed = Date.now() - generatingStart;
    process.stdout.write(`\r${chalk.green('✓')} ${chalk.gray(`生成完成`)} ${chalk.bold.green(formatElapsed(elapsed))}   \n`);
  }
}

// 打字机逐字输出
async function typeWriter(text, color = chalk.green, speed = CONFIG.STREAM_TYPING_SPEED) {
  if (!text || text.length === 0) { console.log(""); return; }
  return new Promise(resolve => {
    let index = 0;
    const interval = setInterval(() => {
      process.stdout.write(color(text[index]));
      index++;
      if (index >= text.length) {
        clearInterval(interval);
        console.log("");
        resolve();
      }
    }, speed);
  });
}

// 实时流式深度思考显示
let thinkingStreamActive = false;
let thinkingBuffer = "";

function startThinkingStream() {
  thinkingStreamActive = true;
  thinkingBuffer = "";
  process.stdout.write(chalk.yellow.bold("\nThinking... "));
}

function feedThinkingChunk(chunk) {
  if (!chunk) return;
  thinkingBuffer += chunk;
  if (thinkingStreamActive) {
    process.stdout.write(chalk.yellow(chunk));
  }
}

function endThinkingStream() {
  thinkingStreamActive = false;
  if (thinkingBuffer) {
    console.log(chalk.yellow.bold(`\n...done thinking. (${thinkingBuffer.length}字)`));
  } else {
    console.log(chalk.yellow.bold(" (空)"));
  }
  return thinkingBuffer;
}

// 深度思考日志工具
function initThinkLogDir() {
  if (CONFIG.SAVE_THINK_LOG && !fs.existsSync(CONFIG.THINK_LOG_PATH)) {
    fs.mkdirSync(CONFIG.THINK_LOG_PATH, { recursive: true });
  }
}

function saveThinkLog(thinkContent, userInput, modelReply) {
  if (!CONFIG.SAVE_THINK_LOG || !thinkContent) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(CONFIG.THINK_LOG_PATH, `think_${timestamp}.log`);
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
  console.log(chalk.gray(`📝 深度思考日志已保存: ${logFile}`));
}

// 带超时的Promise包装
function withTimeout(promise, timeoutMs = CONFIG.REQUEST_TIMEOUT, errorMsg = "请求超时") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
  ]);
}

// ====================== 图像工具函数 ======================
async function imageToBase64(imagePath) {
  try {
    const buffer = fs.readFileSync(imagePath);
    // 统一转换为JPEG并压缩
    const jpegBuffer = await sharp(buffer)
      .resize({ width: CONFIG.MAX_IMAGE_SIZE, withoutEnlargement: true })
      .jpeg({ quality: CONFIG.IMAGE_QUALITY })
      .toBuffer();
    return jpegBuffer.toString('base64');
  } catch (e) {
    throw new Error(`图像转换失败: ${e.message}`);
  }
}

// 剪贴板图像获取（支持Windows/macOS/Linux）
async function getClipboardImage() {
  try {
    // 检查剪贴板是否是文件路径
    const clipboard = clipboardy.readSync().trim();
    if (fs.existsSync(clipboard) && /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(clipboard)) {
      return { type: "file", path: clipboard };
    }

    // Windows系统剪贴板图像
    if (process.platform === 'win32') {
      const tempPath = path.join(os.tmpdir(), `clipboard_${Date.now()}.png`);
      execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { [System.Windows.Forms.Clipboard]::GetImage().Save('${tempPath}', [System.Drawing.Imaging.ImageFormat]::Png) }"`);
      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        return { type: "file", path: tempPath };
      }
    } 
    // macOS系统剪贴板图像
    else if (process.platform === 'darwin') {
      const tempPath = path.join(os.tmpdir(), `clipboard_${Date.now()}.png`);
      try {
        execSync(`pngpaste "${tempPath}" 2>/dev/null`);
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          return { type: "file", path: tempPath };
        }
      } catch (e) {}
    }
    // Linux系统剪贴板图像
    else if (process.platform === 'linux') {
      const tempPath = path.join(os.tmpdir(), `clipboard_${Date.now()}.png`);
      try {
        execSync(`xclip -selection clipboard -t image/png -o > "${tempPath}" 2>/dev/null`);
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          return { type: "file", path: tempPath };
        }
      } catch (e) {}
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ====================== 多对话管理工具函数 ======================
function initConversationsDir() {
  if (!fs.existsSync(CONFIG.CONVERSATIONS_PATH)) {
    fs.mkdirSync(CONFIG.CONVERSATIONS_PATH, { recursive: true });
  }
}

function saveConversation(id) {
  const convPath = path.join(CONFIG.CONVERSATIONS_PATH, `${id}.json`);
  const convData = {
    id,
    name: `对话 ${new Date().toLocaleString()}`,
    memory,
    HP,
    MP,
    Desire,
    Like,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  fs.writeFileSync(convPath, JSON.stringify(convData, null, 2));
}

function loadConversation(id) {
  const convPath = path.join(CONFIG.CONVERSATIONS_PATH, `${id}.json`);
  if (fs.existsSync(convPath)) {
    const convData = JSON.parse(fs.readFileSync(convPath, 'utf8'));
    memory = convData.memory || [];
    HP = convData.HP || 100;
    MP = convData.MP || 98;
    Desire = convData.Desire || 3;
    Like = convData.Like || 599;
    currentConversationId = id;
    return true;
  }
  return false;
}

function listConversations() {
  return fs.readdirSync(CONFIG.CONVERSATIONS_PATH)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const id = f.replace('.json', '');
      const convPath = path.join(CONFIG.CONVERSATIONS_PATH, f);
      try {
        const data = JSON.parse(fs.readFileSync(convPath, 'utf8'));
        return { id, name: data.name || id, updatedAt: data.updatedAt || 0 };
      } catch (e) {
        return { id, name: id, updatedAt: 0 };
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function deleteConversation(id) {
  const convPath = path.join(CONFIG.CONVERSATIONS_PATH, `${id}.json`);
  if (fs.existsSync(convPath)) {
    fs.unlinkSync(convPath);
    return true;
  }
  return false;
}

function createNewConversation() {
  const id = `conv_${Date.now()}`;
  memory = [];
  HP = 100;
  MP = 98;
  Desire = 3;
  Like = 599;
  currentConversationId = id;
  saveConversation(id);
  return id;
}
// ====================== 流式请求引擎（核心，已按各厂商文档重写） ======================
function streamAttemptRequest(promptConfig, onStructuredChunk) {
  return new Promise(async (resolve, reject) => {
    let fullContent = "";
    let deepThinkContent = "";
    let resolved = false;
    let firstTokenReceived = false;

    const finishOnce = (content, think = "") => {
      if (resolved) return;
      resolved = true;
      resolve({ content, think });
    };

    const emitChunk = (type, text) => {
      if (!text) return;
      if (!firstTokenReceived) firstTokenReceived = true;
      onStructuredChunk?.({ type, text });
    };

    // 流式<thinking>/标签解析器（兼容所有深度思考模型）
    let contentBuffer = "";
    let inThinkingTag = false;
    let thinkingTagDone = false;

    const parseAndEmit = (rawChunk) => {
      contentBuffer += rawChunk;

      while (contentBuffer.length > 0) {
        if (!thinkingTagDone) {
          if (!inThinkingTag) {
            // 同时支持<thinking>和两种标准标签
            const tag1 = contentBuffer.indexOf('<thinking>');
            const tag2 = contentBuffer.indexOf('');
            const tagStart = Math.max(tag1, tag2);
            
            if (tagStart === -1) {
              // 保留最多100字符用于标签检测，多余直接输出
              if (contentBuffer.length > 100) {
                const overflow = contentBuffer.substring(0, contentBuffer.length - 100);
                contentBuffer = contentBuffer.substring(contentBuffer.length - 100);
                fullContent += overflow;
                emitChunk('content', overflow);
              }
              break;
            }

            // 标签前的内容直接输出
            if (tagStart > 0) {
              const before = contentBuffer.substring(0, tagStart);
              fullContent += before;
              emitChunk('content', before);
            }

            inThinkingTag = true;
            // 移除已匹配的开始标签
            const tagLength = tagStart === tag1 ? '<thinking>'.length : ''.length;
            contentBuffer = contentBuffer.substring(tagStart + tagLength);
          }

          if (inThinkingTag) {
            // 寻找对应的结束标签
            const tagEnd1 = contentBuffer.indexOf('</thinking>');
            const tagEnd2 = contentBuffer.indexOf('');
            const tagEnd = Math.max(tagEnd1, tagEnd2);
            
            if (tagEnd === -1) {
              // 还在思考中，全部输出到思考流
              deepThinkContent += contentBuffer;
              emitChunk('think', contentBuffer);
              contentBuffer = "";
              break;
            }

            // 输出思考内容并标记完成
            const thinkText = contentBuffer.substring(0, tagEnd);
            deepThinkContent += thinkText;
            emitChunk('think', thinkText);
            inThinkingTag = false;
            thinkingTagDone = true;
            // 移除已匹配的结束标签
            const tagLength = tagEnd === tagEnd1 ? '</thinking>'.length : ''.length;
            contentBuffer = contentBuffer.substring(tagEnd + tagLength);
          }
        } else {
          // 思考标签已结束，剩余全部是回复内容
          fullContent += contentBuffer;
          emitChunk('content', contentBuffer);
          contentBuffer = "";
          break;
        }
      }
    };

    // 构建多轮消息（支持图像）
    const messages = buildMultiRoundMessages();
    
    // 处理图像输入（多模态）
    if (promptConfig.images && promptConfig.images.length > 0 && isVisionModel(CONFIG.API_MODEL)) {
      const lastMessage = messages[messages.length - 1];
      // 转换为OpenAI标准多模态格式
      lastMessage.content = [
        { type: "text", text: lastMessage.content }
      ];
      for (const image of promptConfig.images) {
        lastMessage.content.push({
          type: "image_url",
          image_url: { 
            url: `data:image/jpeg;base64,${image.base64}`,
            detail: "auto" // 自动选择图像分辨率
          }
        });
      }
    }

    if (CONFIG.BACKEND_TYPE === "llama.cpp") {
      const postData = JSON.stringify({
        prompt: promptConfig.prompt,
        n_predict: promptConfig.n_predict || 512,
        temperature: promptConfig.temperature || 0.9,
        top_p: promptConfig.top_p || 0.9,
        repeat_penalty: promptConfig.repeat_penalty || 1.1,
        stop: promptConfig.stop || ["<|im_end|>"],
        stream: true
      });

      const req = http.request({
        hostname: CONFIG.LLAMA_HOST,
        port: CONFIG.LLAMA_PORT,
        path: CONFIG.LLAMA_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        res.on('data', chunk => {
          try {
            const lines = chunk.toString('utf8').split('\n').filter(line => line.trim());
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.content) parseAndEmit(data.content);
            }
          } catch (e) {}
        });
        res.on('end', () => finishOnce(fullContent, deepThinkContent));
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();
    } else if (CONFIG.BACKEND_TYPE === "ollama") {
      // 支持深度思考的模型列表（按Ollama官方文档更新）
      const thinkingModels = ['deepseek-r1', 'qwen3', 'deepseek-v', 'qwen2.5-vl', 'glm-4'];
      const supportsThinking = thinkingModels.some(m => CONFIG.API_MODEL.toLowerCase().includes(m));

      const reqBody = {
        model: CONFIG.API_MODEL,
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

      const ollamaHost = CONFIG.API_BASE_URL.includes("localhost") || CONFIG.API_BASE_URL.includes("127.0.0.1")
        ? "127.0.0.1" : new URL(CONFIG.API_BASE_URL).hostname;
      const ollamaPort = new URL(CONFIG.API_BASE_URL).port || "11434";

      const req = http.request({
        hostname: ollamaHost,
        port: ollamaPort,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        res.on('data', chunk => {
          try {
            const lines = chunk.toString('utf8').split('\n').filter(line => line.trim());
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.message?.thinking) parseAndEmit(data.message.thinking);
              if (data.message?.content) parseAndEmit(data.message.content);
            }
          } catch (e) {}
        });
        res.on('end', () => finishOnce(fullContent, deepThinkContent));
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();
    } else {
      // 在线API / OpenAI兼容（已修复OpenRouter调用）
      const reqBody = {
        model: CONFIG.API_MODEL,
        messages: messages,
        stream: true,
        temperature: promptConfig.temperature || 0.95,
        max_tokens: promptConfig.n_predict || 512,
        stop: promptConfig.stop || ["<|im_end|>"]
      };
      const postData = JSON.stringify(reqBody);

      const url = new URL(CONFIG.API_BASE_URL);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      };
      
      // 统一API密钥处理
      if (CONFIG.API_KEY) {
        headers['Authorization'] = `Bearer ${CONFIG.API_KEY}`;
      }
      
      // OpenRouter 官方要求的特殊头信息（必须添加，否则会被拦截）
      if (CONFIG.API_PROVIDER.toLowerCase() === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/noelle-ai/noelle-system';
        headers['X-Title'] = 'Noelle AI Assistant';
      }
      
      // Anthropic 官方要求的特殊头信息
      if (CONFIG.API_PROVIDER.toLowerCase() === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        headers['x-api-key'] = CONFIG.API_KEY;
        delete headers['Authorization']; // Anthropic不使用Bearer格式
      }
      
      // 百度文心一言特殊处理
      if (CONFIG.API_PROVIDER.toLowerCase() === '百度文心一言') {
        delete headers['Authorization'];
        // 文心一言使用access_token参数，在URL中传递
        url.searchParams.set('access_token', CONFIG.API_KEY);
      }

      const req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers,
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        res.on('data', chunk => {
          try {
            const lines = chunk.toString('utf8').split('\n').filter(line => line.trim());
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6);
                if (jsonStr && jsonStr !== '[DONE]') {
                  const data = JSON.parse(jsonStr);
                  // 兼容所有厂商的深度思考字段
                  const thinkChunk = data.choices?.[0]?.thinking
                    || data.choices?.[0]?.delta?.reasoning_content
                    || data.choices?.[0]?.delta?.thinking
                    || "";
                  if (thinkChunk) parseAndEmit(thinkChunk);
                  // 回复内容
                  if (data.choices?.[0]?.delta?.content) {
                    parseAndEmit(data.choices[0].delta.content);
                  }
                }
              }
            }
          } catch (e) {}
        });
        res.on('end', () => finishOnce(fullContent, deepThinkContent));
      });

      req.on('timeout', () => { req.destroy(); finishOnce(fullContent || "", deepThinkContent); });
      req.on('error', e => reject(e));
      req.write(postData);
      req.end();
    }
  });
}

// ====================== 多轮上下文构建（支持多模态） ======================
function buildMultiRoundMessages() {
  const msgs = [];
  const now = new Date();
  const timeString = now.toLocaleTimeString('zh-CN', { hour12: false });
  const currentHour = now.getHours();
  const timeStatus = (currentHour >= 1 && currentHour < 6) ? "深夜" : "白天";
  const currentRules = profile.rules.length > 0 ? profile.rules.slice(-5).join("; ") : "无";
  const userFacts = profile.facts.length > 0 ? profile.facts.slice(-5).join("; ") : "无";

  // 生成MCP工具描述
  const toolDesc = MCP_TOOLS.map(t => `${t.name}(${Object.keys(t.inputSchema.properties || {}).join(',')})`).join(', ');

  msgs.push({
    role: "system",
    content: `你是${ROLE_INFO.name}，${ROLE_INFO.personality}。胆小内向敏感，轻声细语，禁止称呼哥哥/兄长/提尔德，统一用"先生"。
时间:${timeString}(${timeStatus}) HP:${HP} MP:${MP} Desire:${Desire} Like:${Like}
认知:${currentRules} 事实:${userFacts}

可用工具: ${toolDesc}
当你需要查看文件、搜索网页、执行命令时，在JSON中添加"tool_call":{"name":"工具名","arguments":{参数}}字段，我会执行后把结果告诉你。

必须先输出<thinking>长篇深度内心独白(200字以上)</thinking>，然后输出JSON:{"reply":"回复","emotion":"情绪","action":"动作","desire_change":0,"like_change":0,"tool_call":null}
thinking规则：像写小说一样详细描写内心世界，包含：对先生的感受、此刻的不安或期待、过去的回忆片段、胡思乱想。不要简短，要长篇展开。thinking放在XML标签中单独输出，不要放在JSON里。
tool_call为null表示不需要工具，需要时填入工具名和参数。
${CONFIG.STRATEGY !== "standard" ? `推理策略[${CONFIG.STRATEGY}]:` + {cot:"逐步推理再回答",cod:"先用5字以内草稿记录每步思路",tot:"生成多个推理路径选最优",self_refine:"先回答再自我批评再修正"}[CONFIG.STRATEGY.replace(/-/g,"_")] || "" : ""}
不要脱离人设，不要提及AI。`
  });

  // 带入最近4轮对话（控制token数防溢出）
  const recent = memory.slice(-4);
  recent.forEach(m => {
    const trimmedText = m.text.length > 200 ? m.text.substring(0, 200) + "..." : m.text;
    msgs.push({
      role: m.role === "user" ? "user" : "assistant",
      content: trimmedText
    });
  });

  return msgs;
}

// ====================== LLM请求封装 ======================
async function askLLMStream(promptConfig) {
  try {
    return await withTimeout(streamAttemptRequest(promptConfig));
  } catch (e) {
    console.error(chalk.red("❌ LLM请求超时/异常：", e.message));
    return { content: "", think: "" };
  }
}

// 非流式请求（兼容旧代码）
function attemptRequest(promptConfig) {
  return new Promise((resolve) => {
    if (CONFIG.BACKEND_TYPE === "llama.cpp") {
      const postData = JSON.stringify({
        prompt: promptConfig.prompt,
        n_predict: promptConfig.n_predict || 512,
        temperature: promptConfig.temperature || 0.9,
        top_p: promptConfig.top_p || 0.9,
        repeat_penalty: promptConfig.repeat_penalty || 1.1,
        stop: promptConfig.stop || ["<|im_end|>"]
      });

      const req = http.request({
        hostname: CONFIG.LLAMA_HOST,
        port: CONFIG.LLAMA_PORT,
        path: CONFIG.LLAMA_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve({ content: data.content || "", think: "" });
          } catch (e) {
            resolve({ content: body, think: "" });
          }
        });
      });

      req.on('error', (e) => {
        console.error(chalk.red(`❌ Llama连接失败: ${e.message}`));
        resolve({ content: "", think: "" });
      });

      req.write(postData);
      req.end();
    } else if (CONFIG.BACKEND_TYPE === "ollama") {
      const thinkingModels = ['deepseek-r1', 'qwen3', 'deepseek-v', 'qwen2.5-vl'];
      const supportsThinking = thinkingModels.some(m => CONFIG.API_MODEL.toLowerCase().includes(m));

      const reqBody = {
        model: CONFIG.API_MODEL,
        messages: buildMultiRoundMessages(),
        stream: false,
        ...(supportsThinking ? { think: true } : {}),
        keep_alive: "30m",
        options: {
          num_ctx: 8192,
          temperature: promptConfig.temperature || 0.9,
          num_predict: promptConfig.n_predict || 512,
          stop: promptConfig.stop || ["<|im_end|>"]
        }
      };
      const postData = JSON.stringify(reqBody);

      const ollamaHost = CONFIG.API_BASE_URL.includes("localhost") || CONFIG.API_BASE_URL.includes("127.0.0.1")
        ? "127.0.0.1" : new URL(CONFIG.API_BASE_URL).hostname;
      const ollamaPort = new URL(CONFIG.API_BASE_URL).port || "11434";

      const req = http.request({
        hostname: ollamaHost,
        port: ollamaPort,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const content = json.message?.content || body;
            const think = json.message?.thinking || "";
            resolve({ content, think });
          } catch (e) {
            resolve({ content: body, think: "" });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ content: "", think: "" });
      });

      req.on('error', (e) => {
        console.error(chalk.red(`❌ Ollama连接失败: ${e.message}`));
        resolve({ content: "", think: "" });
      });

      req.write(postData);
      req.end();
    } else {
      // 在线API非流式（已修复OpenRouter）
      const reqBody = {
        model: CONFIG.API_MODEL,
        messages: buildMultiRoundMessages(),
        temperature: promptConfig.temperature || 0.9,
        max_tokens: promptConfig.n_predict || 512,
        stop: promptConfig.stop || ["<|im_end|>"]
      };
      const postData = JSON.stringify(reqBody);

      const url = new URL(CONFIG.API_BASE_URL);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      };
      
      if (CONFIG.API_KEY) {
        headers['Authorization'] = `Bearer ${CONFIG.API_KEY}`;
      }
      
      // OpenRouter 特殊头
      if (CONFIG.API_PROVIDER.toLowerCase() === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/noelle-ai/noelle-system';
        headers['X-Title'] = 'Noelle AI Assistant';
      }
      
      // Anthropic 特殊头
      if (CONFIG.API_PROVIDER.toLowerCase() === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        headers['x-api-key'] = CONFIG.API_KEY;
        delete headers['Authorization'];
      }

      const req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: headers,
        timeout: CONFIG.REQUEST_TIMEOUT
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const content = json.choices?.[0]?.message?.content || body;
            const think = json.choices?.[0]?.thinking || "";
            resolve({ content, think });
          } catch (e) {
            resolve({ content: body, think: "" });
          }
        });
      });

      req.on('error', (e) => {
        console.error(chalk.red(`❌ API请求失败: ${e.message}`));
        resolve({ content: "", think: "" });
      });

      req.write(postData);
      req.end();
    }
  });
}

async function askLLM(promptConfig) {
  return await attemptRequest(promptConfig);
}

// 旧版Prompt构建（兼容非流式）
function buildPrompt(userText) {
  const now = new Date();
  const timeString = now.toLocaleTimeString('zh-CN', { hour12: false });
  const currentHour = now.getHours();
  const timeStatus = (currentHour >= 1 && currentHour < 6) ? "深夜" : "白天";

  const recentContext = memory.slice(-4).map(m => `${m.role}: ${m.text.length > 200 ? m.text.substring(0, 200) + "..." : m.text}`).join("\n");
  const currentRules = profile.rules.length > 0 ? profile.rules.slice(-5).join("; ") : "无";
  const userFacts = profile.facts.length > 0 ? profile.facts.slice(-5).join("; ") : "无";

  const toolDesc = MCP_TOOLS.map(t => `${t.name}(${Object.keys(t.inputSchema.properties || {}).join(',')})`).join(', ');

  return `<|im_start|>system
你是${ROLE_INFO.name}，${ROLE_INFO.personality}。胆小内向敏感，轻声细语，禁止称呼哥哥/兄长/提尔德，统一用"先生"。
时间:${timeString}(${timeStatus}) HP:${HP} MP:${MP} Desire:${Desire} Like:${Like}
认知:${currentRules} 事实:${userFacts}

可用工具: ${toolDesc}
当你需要查看文件、搜索网页、执行命令时，在JSON中添加"tool_call":{"name":"工具名","arguments":{参数}}字段。

必须输出JSON:{"reply":"回复","thinking":"长篇深度内心独白(200字以上)","emotion":"情绪","action":"动作","desire_change":0,"like_change":0,"tool_call":null}
thinking规则：像写小说一样详细描写内心世界。tool_call为null表示不需要工具。
不要脱离人设，不要提及AI。
【输出铁则】
你必须**只输出1个严格符合JSON语法的对象**，禁止任何额外文字、解释、markdown，所有内容必须包裹在{}中，多一个字符都不行。

字段定义（全部必填，无内容填默认值）：
- "reply": 对用户说的话，禁止用"哥哥/兄长"，统一叫"先生"，无内容填"对不起，我没听清..."
- "thinking": 你的内心独白，简短真实，无内容填""
- "emotion": 情绪，如normal/开心/害羞/疑惑，默认normal
- "action": 小动作，如"安静站着/拽衣角/递茶杯"，默认"安静站在一旁"
- "like_change": 好感度变化，整数[-5,5]，默认0
- "desire_change": 依赖度变化，整数[-5,5]，默认0
- "tool_call": 【可选】调用工具时填，格式{"name":"工具名","arguments":{...}}

【正确示例】
{"reply":"先生，茶泡好了哦","thinking":"不知道他喜不喜欢红茶","emotion":"期待","action":"双手递茶杯","like_change":1,"desire_change":0}

output lang use Chinese!
最近对话：
${recentContext}
<|im_end|>
<|im_start|>user
${userText}
<|im_end|>
<|im_start|>assistant
`;
}

// ====================== 核心对话处理函数（支持图像） ======================
let lastTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

async function chatWithOwen(userText, images = []) {
  const prompt = buildPrompt(userText);
  // 启动生成计时器和思考流
  startGeneratingTimer();
  startThinkingStream();
  
  // 流式请求
  const { content: rawReply, think: deepThink } = await askLLMStream({
    onStructuredChunk: (chunk) => {
      if (chunk.type === "think") feedThinkingChunk(chunk.text);
    },
    prompt: prompt,
    n_predict: 512,
    temperature: 0.95,
    repeat_penalty: 1.18,
    images: images
  });
  
  // 停止计时器
  endThinkingStream();
  stopGeneratingTimer();

  if (!rawReply) return null;

  try {
    // 提取JSON（兼容模型可能输出的额外文字）
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(chalk.red("❌ 模型未输出JSON格式"));
      return null;
    }

    const rawData = JSON.parse(jsonMatch[0]);
    
    // 统一称呼替换
    let cleanText = rawData.reply || "";
    if (cleanText.includes("哥哥")) cleanText = cleanText.replace(/哥哥|兄长|提尔德/g, "先生");
    if (!cleanText || cleanText === "undefined") cleanText = "对不起，我没听清...";

    // 合并深度思考内容
    const thoughtFromReply = rawData.thinking || rawData.thought || "";
    const mergedThinking = [deepThink, thoughtFromReply].filter(Boolean).join("\n");

    // 保存思考日志
    saveThinkLog(mergedThinking, userText, rawReply);

    // 输出状态信息
    console.log(chalk.cyan(`😶情绪: ${rawData.emotion ?? "normal"} | 🤌动作: ${rawData.action || "安静站在一旁"}`));

    // 估算Token使用量
    const promptEst = Math.ceil(prompt.length / 2.5);
    const completionEst = Math.ceil(rawReply.length / 2.5);
    lastTokenUsage = {
      prompt_tokens: promptEst,
      completion_tokens: completionEst,
      total_tokens: promptEst + completionEst
    };
    console.log(chalk.gray(`📊 Token: 输入${promptEst} | 输出${completionEst} | 共${promptEst + completionEst}`));

    // 打字机效果输出回复
    process.stdout.write(chalk.magenta(`${ROLE_INFO.name}: `));
    await typeWriter(cleanText);

    // 处理工具调用
    if (rawData.tool_call && rawData.tool_call.name) {
      const tc = rawData.tool_call;
      console.log(chalk.blue(`\n🔧 ${ROLE_INFO.name}请求使用工具: ${tc.name}`));
      const toolResult = await executeMCPTool(tc.name, tc.arguments || {});
      const resultText = toolResult.isError
        ? `工具执行失败: ${toolResult.content[0].text}`
        : toolResult.content[0].text;
      console.log(chalk.gray(`📋 工具结果: ${resultText.substring(0, 500)}`));

      // 把工具结果追加到对话并继续回复
      addMemory("ai", cleanText + ` [使用了${tc.name}]`);
      const followUpPrompt = `你使用了工具${tc.name}，结果是:\n${resultText.substring(0, 3000)}\n\n请根据工具结果继续回复。`;
      addMemory("user", followUpPrompt);
      const followUp = await chatWithOwen(followUpPrompt);
      if (followUp) return followUp;
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
    console.error(chalk.red("❌ JSON解析失败:", e.message));
    return null;
  }
}
// ====================== 第三部分：多级文件选择器 + CLI增强 + 多对话 + 服务入口 ======================

// ====================== 多级文件夹文件选择器（支持进入子目录/返回上级） ======================
//let currentPickerDir = process.cwd();

async function filePicker() {
  try {
    const dir = currentPickerDir;
    if (!fs.existsSync(dir)) {
      currentPickerDir = process.cwd();
      return await filePicker();
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const choices = [];

    // 返回上级目录
    if (dir !== path.parse(dir).root) {
      choices.push({
        name: chalk.yellow('📁 ../ 返回上级目录'),
        value: '..'
      });
    }

    // 子文件夹排序
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    dirs.forEach(d => {
      choices.push({
        name: chalk.cyan(`📁 ${d.name}/`),
        value: `dir:${d.name}`
      });
    });

    // 文件排序
    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    files.forEach(f => {
      choices.push({
        name: `📄 ${f.name}`,
        value: `file:${f.name}`
      });
    });

    if (choices.length === 0) {
      console.log(chalk.gray("当前目录无文件/文件夹"));
      return null;
    }

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: `当前目录：${dir}`,
      choices,
      pageSize: 20
    }]);

    // 处理返回上级
    if (selected === '..') {
      currentPickerDir = path.dirname(dir);
      return await filePicker();
    }

    // 进入子文件夹
    if (selected.startsWith('dir:')) {
      const folderName = selected.replace('dir:', '');
      currentPickerDir = path.join(dir, folderName);
      return await filePicker();
    }

    // 选中文件
    if (selected.startsWith('file:')) {
      const fileName = selected.replace('file:', '');
      const filePath = path.join(dir, fileName);

      try {
        // 图像文件 + 视觉模型检测
        if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileName) && isVisionModel(CONFIG.API_MODEL)) {
          const base64 = await imageToBase64(filePath);
          attachedFiles.push({
            name: fileName,
            content: base64,
            type: 'image'
          });
          console.log(chalk.green(`📎 已附加图像：${fileName}`));
        } else {
          // 普通文本文件
          const content = fs.readFileSync(filePath, 'utf8');
          attachedFiles.push({
            name: fileName,
            content: content.substring(0, 30000),
            type: 'text'
          });
          console.log(chalk.green(`📎 已附加文件：${fileName}`));
        }
        return fileName;
      } catch (e) {
        console.log(chalk.red(`读取失败：${e.message}`));
        return null;
      }
    }

  } catch (e) {
    console.log(chalk.red(`目录读取异常：${e.message}`));
    currentPickerDir = process.cwd();
    return null;
  }
}

// ====================== 命令自动补全列表 ======================
const COMMAND_LIST = [
  { cmd: "/help", desc: "显示帮助" },
  { cmd: "/quit", desc: "退出程序" },
  { cmd: "/exit-chat", desc: "返回菜单" },
  { cmd: "/mcp", desc: "MCP工具列表/调用" },
  { cmd: "/models", desc: "列出本地模型" },
  { cmd: "/url", desc: "查看服务地址" },
  { cmd: "/status", desc: "角色状态" },
  { cmd: "/conv", desc: "多对话管理" },
  { cmd: "/new", desc: "新建对话" },
  { cmd: "!记:", desc: "记录人物事实" },
  { cmd: "!summarize", desc: "文本摘要" },
  { cmd: "!extract", desc: "提取要点" },
  { cmd: "!analyze", desc: "内容分析" },
  { cmd: "!paste", desc: "粘贴剪贴板图像" }
];

async function commandAutocomplete(prefix) {
  const matches = COMMAND_LIST.filter(c => c.cmd.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].cmd;

  const choices = matches.map(c => ({
    name: `${c.cmd}  ${chalk.gray(c.desc)}`,
    value: c.cmd
  }));

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: `命令补全：${prefix}`,
    choices,
    pageSize: 10
  }]);
  return selected;
}

// ====================== 启动动画 ======================
async function showStartupAnimation() {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  const title = "NOELLE SYSTEM";
  process.stdout.write(chalk.magenta.bold(`  ${title} 启动中 `));
  for (let i = 0; i < 15; i++) {
    process.stdout.write(chalk.magenta(frames[i % frames.length]));
    await new Promise(r => setTimeout(r, 80));
    process.stdout.write('\b');
  }
  process.stdout.write(chalk.green('✓\n'));
}

// ====================== CLI聊天主界面（支持上下键历史+剪贴板+多对话） ======================
async function startCLIChat() {
  console.clear();
  await showStartupAnimation();
  console.log(chalk.cyan.bold("╔═══════════════════════════════════════╗"));
  console.log(chalk.cyan.bold("║       NOELLE CLI Chat Mode            ║"));
  console.log(chalk.cyan.bold("╚═══════════════════════════════════════╝"));
  renderStatusBar();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
    removeHistoryDuplicates: true
  });
  currentChatMode = "cli";

  function renderStatusBar() {
    const modelName = CONFIG.API_MODEL.length > 20 ? CONFIG.API_MODEL.slice(0,17)+"..." : CONFIG.API_MODEL;
    const thinkTag = CONFIG.ENABLE_DEEP_THINK ? "🧠" : "";
    const visionTag = isVisionModel(CONFIG.API_MODEL) ? "🖼️" : "";
    const strategyTag = CONFIG.STRATEGY !== "standard" ? `[${CONFIG.STRATEGY}]` : "";
    const tokens = lastTokenUsage.total_tokens > 0 ? `T:${lastTokenUsage.total_tokens}` : "";
    const convTag = `对话: ${currentConversationId.slice(0,12)}`;

    console.log(chalk.gray(`┌─ ${modelName} ${thinkTag}${visionTag}${strategyTag} | ${convTag} | HP:${HP} MP:${MP} Desire:${Desire} Like:${Like} ${tokens}`));
    console.log(chalk.gray("└─ /help 帮助 | @ 选文件 | !paste 粘贴图像 | /conv 对话管理"));
  }

  const promptUser = (prefill = "") => {
    const shortModel = CONFIG.API_MODEL.split(':').pop().slice(0,12);
    const attachedNames = attachedFiles.length
      ? chalk.green(`[${attachedFiles.map(f=>f.name).join(',')}] `)
      : "";

    rl.question(chalk.blue(`\n${shortModel}> `) + attachedNames, async (input) => {
      let userText = prefill + input;
      if (userText.trim() === "") { promptUser(); return; }

      // 存入历史
      commandHistory.push(userText.trim());

      // 1. 剪贴板图像粘贴
      if (userText.trim() === "!paste") {
        console.log(chalk.blue("📋 读取剪贴板图像..."));
        const imgRes = await getClipboardImage();
        if (imgRes) {
          const base64 = await imageToBase64(imgRes.path);
          attachedFiles.push({
            name: `clip_${Date.now()}.jpg`,
            content: base64,
            type: "image"
          });
          console.log(chalk.green("✅ 已粘贴剪贴板图像"));
        } else {
          console.log(chalk.yellow("⚠️ 剪贴板无可用图像"));
        }
        promptUser();
        return;
      }

      // 2. @ 唤起多级文件选择器
      if (userText.trim() === "@") {
        rl.pause();
        await filePicker();
        rl.resume();
        promptUser();
        return;
      }

      // 3. 命令自动补全
      if ((userText.startsWith('/') || userText.startsWith('!')) && userText.length > 1) {
        const matched = COMMAND_LIST.filter(c => c.cmd.startsWith(userText) && c.cmd !== userText);
        if (matched.length > 1) {
          rl.pause();
          const completed = await commandAutocomplete(userText);
          rl.resume();
          if (completed) userText = completed;
        }
      }

      // 4. 多对话管理命令
      if (userText === "/conv") {
        rl.pause();
        await handleConversationCommand();
        rl.resume();
        renderStatusBar();
        promptUser();
        return;
      }
      if (userText === "/new") {
        createNewConversation();
        console.log(chalk.green("✅ 已新建空白对话"));
        renderStatusBar();
        promptUser();
        return;
      }

      // 5. 基础命令
      if (userText === "/quit" || userText === "/exit") {
        console.log(chalk.yellow("\n👋 再见"));
        rl.close();
        process.exit(0);
      }
      if (userText === "/exit-chat") {
        console.log(chalk.yellow("\n退出聊天，返回菜单"));
        rl.close();
        currentChatMode = null;
        showServerMenu();
        return;
      }
      if (userText === "/help") {
        console.log(chalk.cyan("\n═══ 命令列表 ═══"));
        console.log(" /help        帮助");
        console.log(" /quit        退出");
        console.log(" /exit-chat   返回菜单");
        console.log(" /conv        多对话管理");
        console.log(" /new         新建对话");
        console.log(" /models      查看模型");
        console.log(" /url         服务地址");
        console.log(" /status      角色状态");
        console.log(" @            选择文件/图片");
        console.log(" !paste       粘贴剪贴板图片");
        console.log(" !记:xxx      记录事实");
        console.log(" !summarize   文本摘要");
        promptUser();
        return;
      }
      if (userText === "/status") {
        console.log(chalk.cyan("\n═══ 角色状态 ═══"));
        console.log(` HP: ${HP}/100 | MP: ${MP}/100 | Desire: ${Desire}/100 | 好感: ${Like}`);
        console.log(` 模型: ${CONFIG.API_MODEL} | 策略: ${CONFIG.STRATEGY}`);
        console.log(` 记忆: ${memory.length} | 事实: ${profile.facts.length} | 规则: ${profile.rules.length}`);
        console.log(` Token: ${lastTokenUsage.total_tokens}`);
        promptUser();
        return;
      }
      if (userText === "/models") {
        if (CONFIG.BACKEND_TYPE === "ollama") {
          try {
            const list = execSync("ollama list", { encoding:"utf8" });
            console.log(chalk.cyan("\n═══ Ollama模型 ═══\n", list));
          } catch(e) { console.log(chalk.red("获取模型失败")); }
        } else {
          console.log(chalk.gray("当前非Ollama后端"));
        }
        promptUser();
        return;
      }
      if (userText === "/url") {
        console.log(chalk.cyan("\n═══ 服务地址 ═══"));
        Object.entries(serverURLs).forEach(([k,v])=>console.log(chalk.green(` ${k}: ${v}`)));
        promptUser();
        return;
      }

      // 6. 快捷工具命令
      if (userText.startsWith("!记:")) {
        profile.facts.push(userText.slice(4).trim());
        saveProfile();
        console.log(chalk.green(`📝 已记录：${userText.slice(4)}`));
        promptUser();
        return;
      }
      if (userText.startsWith("!summarize ")) {
        const txt = userText.replace("!summarize ","");
        const prompt = `请精炼摘要以下内容：\n${txt}`;
        isProcessing = true; addMemory("user", prompt);
        const res = await chatWithOwen(prompt);
        if(res) console.log(chalk.green(`📋 摘要：${res.clean}`));
        isProcessing = false;
        promptUser();
        return;
      }
      if (userText.startsWith("!extract ")) {
        const txt = userText.replace("!extract ","");
        const prompt = `提取以下内容关键要点：\n${txt}`;
        isProcessing = true; addMemory("user", prompt);
        const res = await chatWithOwen(prompt);
        if(res) console.log(chalk.green(`📋 要点：${res.clean}`));
        isProcessing = false;
        promptUser();
        return;
      }

      // 7. 正常聊天 + 附加文件/图像
      isProcessing = true;
      lastInteractionTime = Date.now();

      let finalText = userText;
      let imgList = [];

      // 拼接文本附件、收集图像
      if (attachedFiles.length > 0) {
        const textFiles = attachedFiles.filter(f=>f.type==="text");
        const imgFiles = attachedFiles.filter(f=>f.type==="image");

        if (textFiles.length) {
          finalText += "\n\n【附加文件】\n"
            + textFiles.map(f=>`--- ${f.name} ---\n${f.content}`).join("\n\n");
        }
        imgList = imgFiles.map(f=>({ base64: f.content, name: f.name }));
        attachedFiles = [];
      }

      addMemory("user", finalText);
      try {
        const reply = await chatWithOwen(finalText, imgList);
        if (reply) {
          Like += reply.likeChange;
          Desire += reply.desireChange;
          Like = Math.max(0, Math.min(999, Like));
          Desire = Math.max(0, Math.min(100, Desire));
          addMemory("ai", reply.clean);

          // 记忆进化/复盘
          if (memory.length % CONFIG.EVOLUTION_INTERVAL === 0) setTimeout(()=>evolveMemory(),2000);
          if (memory.length % CONFIG.REFLECTION_INTERVAL === 0) setTimeout(()=>deepReflection(),2000);

          renderStatusBar();
        }
      } catch(e) {
        console.log(chalk.red("聊天异常：",e.message));
      } finally {
        isProcessing = false;
      }

      promptUser();
    });
  };

  promptUser();
}

// ====================== 多对话管理交互逻辑 ======================
async function handleConversationCommand() {
  const convs = listConversations();
  const opts = [
    { name: "🆕 新建对话", value: "new" },
    { name: "🔄 切换对话", value: "switch" },
    { name: "🗑️ 删除对话", value: "delete" },
    { name: "❌ 取消", value: "cancel" }
  ];

  const { act } = await inquirer.prompt([{
    type:"list", name:"act", message:"多对话管理", choices:opts
  }]);

  switch(act) {
    case "new":
      createNewConversation();
      console.log(chalk.green("✅ 新建对话完成"));
      break;
    case "switch":
      if (!convs.length) {
        console.log(chalk.gray("暂无保存的对话"));
        return;
      }
      const switchOpts = convs.map(c=>({
        name: `${c.name} | ${new Date(c.updatedAt).toLocaleString()}`,
        value: c.id
      })).concat([{name:"❌ 取消",value:"cancel"}]);
      const { sid } = await inquirer.prompt([{type:"list",name:"sid",message:"选择对话",choices:switchOpts}]);
      if (sid !== "cancel") {
        loadConversation(sid);
        console.log(chalk.green(`✅ 已切换到对话：${sid}`));
      }
      break;
    case "delete":
      if (!convs.length) {
        console.log(chalk.gray("暂无对话可删除"));
        return;
      }
      const delOpts = convs.map(c=>({
        name: `${c.name}`,
        value: c.id
      })).concat([{name:"❌ 取消",value:"cancel"}]);
      const { did } = await inquirer.prompt([{type:"list",name:"did",message:"删除对话",choices:delOpts}]);
      if (did !== "cancel") {
        if (did === currentConversationId) createNewConversation();
        deleteConversation(did);
        console.log(chalk.green(`✅ 已删除对话：${did}`));
      }
      break;
  }
}

// ====================== OpenAI 兼容API接口完整实现 ======================
async function handleOpenAIRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // 模型列表
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({
      object:"list",
      data:[{id:CONFIG.API_MODEL,object:"model",created:Date.now(),owned_by:"noelle-system"}]
    }));
    return;
  }

  // 对话补全
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data",c=>body+=c);
    req.on("end",async ()=>{
      try {
        const data = JSON.parse(body);
        const userMsg = data.messages?.filter(m=>m.role==="user").pop()?.content || "";
        const isStream = !!data.stream;

        isProcessing = true;
        lastInteractionTime = Date.now();
        addMemory("user", userMsg);

        const reply = await chatWithOwen(userMsg);
        if (!reply) {
          res.writeHead(500,{"Content-Type":"application/json"});
          res.end(JSON.stringify({error:{message:"生成失败"}}));
          isProcessing = false;
          return;
        }

        // 属性变更
        Like += reply.likeChange;
        Desire += reply.desireChange;
        Like = Math.max(0, Math.min(999, Like));
        Desire = Math.max(0, Math.min(100, Desire));
        addMemory("ai", reply.clean);

        const tokenUsage = {
          prompt_tokens: reply.promptTokens,
          completion_tokens: reply.completionTokens,
          total_tokens: reply.promptTokens + reply.completionTokens
        };

        // 流式 SSE
        if (isStream) {
          res.writeHead(200, {
            "Content-Type":"text/event-stream",
            "Cache-Control":"no-cache",
            "Connection":"keep-alive"
          });
          const cid = `chatcmpl-${Date.now()}`;
          const created = Math.floor(Date.now()/1000);

          // 角色帧
          res.write(`data: ${JSON.stringify({
            id:cid,object:"chat.completion.chunk",created,model:CONFIG.API_MODEL,
            choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]
          })}\n\n`);

          // 内容帧
          res.write(`data: ${JSON.stringify({
            id:cid,object:"chat.completion.chunk",created,model:CONFIG.API_MODEL,
            choices:[{index:0,delta:{content:reply.clean},finish_reason:null}]
          })}\n\n`);

          // 结束帧
          res.write(`data: ${JSON.stringify({
            id:cid,object:"chat.completion.chunk",created,model:CONFIG.API_MODEL,
            choices:[{index:0,delta:{},finish_reason:"stop"}],
            usage:tokenUsage
          })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // 非流式标准返回
          const resp = {
            id:`chatcmpl-${Date.now()}`,
            object:"chat.completion",
            created:Math.floor(Date.now()/1000),
            model:CONFIG.API_MODEL,
            system_fingerprint:"noelle-v3",
            choices:[{
              index:0,
              message:{
                role:"assistant",
                content:reply.clean,
                refusal:null,
                thinking:reply.thinking,
                emotion:reply.emotion,
                action:reply.action
              },
              logprobs:null,
              finish_reason:"stop"
            }],
            usage:tokenUsage,
            noelle:{hp:HP,mp:MP,desire:Desire,like:Like,role_info:ROLE_INFO}
          };
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify(resp));
        }

        // 后台记忆进化
        if (memory.length % CONFIG.EVOLUTION_INTERVAL === 0) setTimeout(()=>evolveMemory(),2000);
        if (memory.length % CONFIG.REFLECTION_INTERVAL === 0) setTimeout(()=>deepReflection(),2000);

      } catch(e) {
        if (!res.headersSent) {
          res.writeHead(400,{"Content-Type":"application/json"});
          res.end(JSON.stringify({error:e.message}));
        }
      } finally {
        isProcessing = false;
      }
    });
    return;
  }

  res.writeHead(404,{"Content-Type":"application/json"});
  res.end(JSON.stringify({error:"Not found"}));
}

// ====================== 通用工具、配置、端口、菜单、启动入口 ======================
function checkTurboWarpInstalled() {
  try {
    if (process.platform === "linux") { execSync("which turbowarp-desktop",{stdio:"ignore"});return true; }
    if (process.platform === "win32") { execSync("where turbowarp-desktop",{stdio:"ignore"});return true; }
    return false;
  } catch(e){return false;}
}

function loadProfile() {
  try {
    if (fs.existsSync("profile.json")) {
      profile = JSON.parse(fs.readFileSync("profile.json","utf8"));
    }
  } catch(e) {
    console.log(chalk.gray("无角色配置，使用默认"));
  }
}

function saveProfile() {
  fs.writeFileSync("profile.json", JSON.stringify(profile,null,2));
}

function addMemory(role, text) {
  memory.push({role,text,time:Date.now()});
  if (memory.length > 20) memory.shift();
}

async function detectFace(imagePath) {
  return new Promise(resolve=>{
    execFile("python",["face_detect.py",imagePath],(err,stdout)=>{
      if(err) return resolve({detected:false});
      try { resolve(JSON.parse(stdout)); } catch(e) { resolve({detected:false}); }
    });
  });
}

async function evolveMemory() {
  if (isEvolving || memory.length < 5) return;
  isEvolving = true;
  console.log(chalk.blue("🔄 记忆进化中..."));
  // 原有逻辑保留
  const recent = memory.slice(-4).map(m=>`${m.role}:${m.text.slice(0,200)}`).join("\n");
  const prompt = `<|im_start|>system\n提取对话规则与事实，输出JSON{"add_rules":[]}\n${recent}\n<|im_start|>assistant`;
  const {content} = await askLLM({prompt,n_predict:200,temperature:0.1});
  try {
    const m = content.match(/\{[\s\S]*\}/);
    if(m) {
      const d = JSON.parse(m[0]);
      if(Array.isArray(d.add_rules)) {
        d.add_rules.forEach(r=>{
          if(r.length>5 && !profile.rules.includes(r)) {
            profile.rules.push(r);
            console.log(chalk.green(`📌 新增规则：${r}`));
          }
        });
      }
    }
  } catch(e){}
  saveProfile();
  isEvolving = false;
}

async function deepReflection() {
  if (isEvolving) return;
  isEvolving = true;
  console.log(chalk.blue("🌙 [深度复盘] 诺艾儿正在整理今天的记忆..."));

  const recentContext = memory.slice(-4).map(m => `${m.role}: ${m.text.length > 200 ? m.text.substring(0, 200) + "..." : m.text}`).join("\n");
  
  const reflectionPrompt = `<|im_start|>system
你是诺艾儿，深夜反思。分析关系变化。
最近对话：
${recentContext}
输出JSON:{"diary_entry":"日记","add_rules":["新规则"],"remove_rules":["旧规则"]}
<|im_end|>
<|im_start|>assistant
`;

  const { content } = await askLLM({ prompt: reflectionPrompt, n_predict: 500, temperature: 0.7 });
  
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      if (data.diary_entry) {
        console.log(chalk.green(`📔 [日记] ${data.diary_entry}`));
        fs.appendFileSync('diary.txt', `[${new Date().toLocaleString()}] ${data.diary_entry}\n`);
      }
    }
  } catch (e) {
    console.error(chalk.red("❌ 反思解析失败:", e.message));
  }

  isEvolving = false;
} 

async function processOneThought(ws) {
  if (isProcessing) return;
  isProcessing = true;

  const now = new Date();
  const timeString = now.toLocaleTimeString('zh-CN', { hour12: false });
  const currentHour = now.getHours();
  const silenceDuration = Math.floor((Date.now() - lastInteractionTime) / 1000);
  const timeStatus = (currentHour >= 1 && currentHour < 6)
    ? "深夜"
    : "白天";

  console.log(chalk.blue(`\n🤔 [沉思] 沉默:${silenceDuration}秒`));

  const thoughtPrompt = `<|im_start|>system
诺艾儿，胆小内向。时间:${timeString}(${timeStatus}) 沉默:${silenceDuration}s 上个想法:"${lastThoughtContent}"
延续思维不重复。输出JSON:{"thought":"新独白","should_speak":true/false,"message":"...","new_rule":"..."}
<|im_end|>
<|im_start|>assistant
`;

  const { content: result } = await askLLM({ prompt: thoughtPrompt, n_predict: 200, temperature: 0.9 });
  
  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      const thoughtData = JSON.parse(match[0]);
      
      if (thoughtData.thought && lastThoughtContent && 
          thoughtData.thought.includes(lastThoughtContent.substring(0, 5))) {
        isProcessing = false;
        return;
      }

      lastThoughtContent = thoughtData.thought || lastThoughtContent;
      console.log(chalk.magenta(`💭 [心声] "${lastThoughtContent}"`));

      if (thoughtData.should_speak && thoughtData.message && ws) {
        console.log(chalk.green(`💬 [主动开口] "${thoughtData.message}"`));
        addMemory("ai", thoughtData.message);
        ws.send(JSON.stringify({
          "text": thoughtData.message,
          "action": "",
          "情绪": "normal",
          "HP": HP,
          "MP": MP,
          "Desire": Desire,
          "Like": Like,
          "role": ROLE_INFO
        }));
      }
    }
  } catch (e) {
    console.error(chalk.red("❌ 思考出错:", e.message));
  }

  isProcessing = false;
}


async function startConsciousness(ws) {
  // 防止重复启动：先清理旧的循环
  if (consciousnessTimer) {
    clearInterval(consciousnessTimer);
    consciousnessTimer = null;
  }
  console.log(chalk.green("[潜意识] 启动（高敏感模式）"));
  consciousnessTimer = setInterval(async () => {
    if (isProcessing || isEvolving) return;
    
    const silenceDuration = Math.floor((Date.now() - lastInteractionTime) / 1000);
    if (silenceDuration > CONFIG.AFK_THRESHOLD && Math.random() < 0.1) {
      await processOneThought(ws);
    }
  }, CONFIG.THOUGHT_COOLDOWN);
}



// 菜单、配置向导、端口检测、主函数全部沿用并修复
function selectMenu(options, title="请选择") {
  return inquirer.prompt([{type:"list",name:"opt",message:title,choices:options,prefix:""}])
    .then(a=>options.indexOf(a.opt));
}
function input(prompt, def="") {
  const tip = def ? `[默认:${def}]` : "";
  return readlineSync.question(chalk.cyan(`\n${prompt} ${tip} `)).trim() || def;
}
function checkLlamaCppInstalled() { try{execSync("llama-server --version",{stdio:"ignore"});return true;}catch(e){return false;} }
function checkOllamaInstalled() { try{execSync("ollama --version",{stdio:"ignore"});return true;}catch(e){return false;} }
async function checkPortOpen(host,port,t=10000) {
  return new Promise(resolve=>{
    const s = new net.Socket();
    s.setTimeout(t);
    s.on("connect",()=>{s.destroy();resolve(true);});
    s.on("timeout",()=>{s.destroy();resolve(false);});
    s.on("error",()=>resolve(false));
    s.connect(port,host);
  });
}
function killPortProcess(port) {
  try {
    const pid = execSync(`lsof -ti:${port} 2>/dev/null`).toString().trim();
    if(pid) pid.split("\n").forEach(p=>{try{process.kill(parseInt(p),"SIGKILL")}catch(e){}});
  }catch(e){}
}
async function ensurePortAvailable(host,port,autoKill=true) {
  const busy = await checkPortOpen(host,port);
  if(!busy) return true;
  if(autoKill) {
    killPortProcess(port);
    await new Promise(r=>setTimeout(r,300));
    if(!await checkPortOpen(host,port)) return true;
  }
  console.log(chalk.red(`端口${port}被占用`));
  return false;
}
function loadConfig() {
  try {
    if(fs.existsSync(".noll-env")) {
      CONFIG = {...CONFIG,...JSON.parse(fs.readFileSync(".noll-env","utf8"))};
      return true;
    }
  }catch(e){}
  return false;
}
function saveConfig() {
  fs.writeFileSync(".noll-env",JSON.stringify(CONFIG,null,2));
  console.log(chalk.green("✅ 配置已保存"));
}
async function runWizard() {
  // 初始化向导完整逻辑沿用
  console.clear();
  console.log(chalk.cyan.bold("==== NOELLE 初始化向导 ===="));
  const hasTW = checkTurboWarpInstalled();
  if(!hasTW) console.log(chalk.yellow("⚠ 未检测到TurboWarp"));

  const backOpts = ["llama.cpp 本地","ollama 本地","在线API"];
  const bid = await selectMenu(backOpts,"选择后端");
  if(bid===0) CONFIG.BACKEND_TYPE="llama.cpp",await setupLlamaCpp();
  if(bid===1) CONFIG.BACKEND_TYPE="ollama",await setupOllama();
  if(bid===2) CONFIG.BACKEND_TYPE="api",await setupAPI();

  CONFIG.PORT = parseInt(input("WebSocket端口",CONFIG.PORT));
  CONFIG.BIND_IP = input("绑定IP",CONFIG.BIND_IP);

  const apiEn = await selectMenu(["禁用","启用"],"启用OpenAI兼容API？");
  CONFIG.OPENAI_API_ENABLED = apiEn===1;
  if(CONFIG.OPENAI_API_ENABLED) CONFIG.OPENAI_API_PORT = parseInt(input("API端口",CONFIG.OPENAI_API_PORT));

  saveConfig();
}
async function setupLlamaCpp() {
  if(!checkLlamaCppInstalled()) {
    console.log(chalk.red("未安装llama.cpp"));
    process.exit(1);
  }
  while(!await checkPortOpen(CONFIG.LLAMA_HOST,CONFIG.LLAMA_PORT)) {
    const ok = await selectMenu(["已启动","修改端口"],"未检测到llama-server");
    if(ok===1) CONFIG.LLAMA_PORT = parseInt(input("输入端口"));
  }
}
async function setupOllama() {
  if(!checkOllamaInstalled()) {
    console.log(chalk.red("未安装ollama"));
    process.exit(1);
  }
  const list = execSync("ollama list",{encoding:"utf8"}).split("\n").slice(1).filter(l=>l.trim());
  if(!list.length) {
    console.log(chalk.yellow("请先 ollama pull 模型"));
    process.exit(1);
  }
  const models = list.map(l=>l.split(/\s+/)[0]);
  const mid = await selectMenu(models,"选择模型");
  CONFIG.API_MODEL = models[mid];
  CONFIG.API_BASE_URL = "http://localhost:11434/v1/chat/completions";
}
async function setupAPI() {
  const providers = [
    {name:"OpenRouter",base:"https://openrouter.ai/api/v1/chat/completions",def:"meta/llama-3-8b-instruct"},
    {name:"硅基流动",base:"https://api.siliconflow.cn/v1/chat/completions",def:"Qwen/Qwen2.5-7B-Instruct"},
    {name:"自定义",base:"",def:""}
  ];
  const pNames = providers.map(x=>x.name);
  const pid = await selectMenu(pNames,"选择API提供商");
  const p = providers[pid];
  CONFIG.API_PROVIDER = p.name;
  CONFIG.API_BASE_URL = input("API地址",p.base);
  CONFIG.API_MODEL = input("模型名",p.def);
  CONFIG.API_KEY = input("API密钥");
}
async function checkOllamaHealth() {
  return new Promise(resolve=>{
    const req = http.request({hostname:"127.0.0.1",port:11434,path:"/api/tags",timeout:5000},res=>{
      let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve(true));
    });
    req.on("error",()=>resolve(false));
    req.end();
  });
}
async function startServers() {
  initThinkLogDir();
  initConversationsDir();

  if(CONFIG.BACKEND_TYPE==="ollama") await checkOllamaHealth();

  // 端口校验
  const ports = [CONFIG.PORT, CONFIG.PORT+1];
  if(CONFIG.OPENAI_API_ENABLED) ports.push(CONFIG.OPENAI_API_PORT);
  for(const p of ports) {
    if(!await ensurePortAvailable(CONFIG.BIND_IP,p)) process.exit(1);
  }

  // WebSocket / MCP / OpenAI服务启动
  let wsHttp;
  if(CONFIG.SSL_ENABLED) {
    const opt = {cert:fs.readFileSync(CONFIG.SSL_CERT),key:fs.readFileSync(CONFIG.SSL_KEY)};
    wsHttp = https.createServer(opt);
  } else {
    wsHttp = http.createServer();
  }

  wssServer = new WebSocket.Server({server:wsHttp});

  // OpenAI API服务
  if(CONFIG.OPENAI_API_ENABLED) {
    httpServer = http.createServer(handleOpenAIRequest);
    httpServer.listen(CONFIG.OPENAI_API_PORT, CONFIG.BIND_IP, ()=>{
      serverURLs.openai = `http://${CONFIG.BIND_IP}:${CONFIG.OPENAI_API_PORT}/v1`;
    });
  }

  // MCP服务
  const mcpPort = CONFIG.PORT + 1;
  const mcpServer = http.createServer(handleMCPRequest);
  mcpServer.listen(mcpPort, CONFIG.BIND_IP, ()=>{
    serverURLs.mcp = `http://${CONFIG.BIND_IP}:${mcpPort}/mcp`;
  });

  // WebSocket服务
  const proto = CONFIG.SSL_ENABLED ? "wss" : "ws";
  serverURLs.websocket = `${proto}://${CONFIG.BIND_IP}:${CONFIG.PORT}`;

  wssServer.on("connection", ws=>{
    console.log(">>> 客户端已连接");
    startConsciousness(ws);
    // 消息监听沿用原有逻辑
    ws.on("message", async raw=>{
      const txt = String(raw).trim();
      if(!txt) return;
      lastInteractionTime = Date.now();
      if(isProcessing) return;
      isProcessing = true;
      addMemory("user",txt);
      const reply = await chatWithOwen(txt);
      if(reply) {
        Like += reply.likeChange;
        Desire += reply.desireChange;
        Like = Math.max(0,Math.min(999,Like));
        Desire = Math.max(0,Math.min(100,Desire));
        addMemory("ai",reply.clean);
        ws.send(JSON.stringify({
          text:reply.clean,action:reply.action,情绪:reply.emotion,
          HP,MP,Desire,Like,role:ROLE_INFO
        }));
      }
      isProcessing = false;
    });
    ws.on("close", ()=>{
      console.log(">>> 客户端断开");
      if(consciousnessTimer) clearInterval(consciousnessTimer);
      saveProfile();
    });
  });

  wsHttp.listen(CONFIG.PORT, CONFIG.BIND_IP);
}

async function showServerMenu() {
  console.log(chalk.cyan.bold("\n==== NOELLE 主菜单 ===="));
  console.log(chalk.gray(`后端:${CONFIG.BACKEND_TYPE} 模型:${CONFIG.API_MODEL} 策略:${CONFIG.STRATEGY}`));
  const opts = ["进入CLI聊天","重启服务","重新配置","退出程序"];
  const idx = await selectMenu(opts);
  switch(idx) {
    case 0: await startCLIChat(); break;
    case 1:
      if(wssServer) wssServer.close();
      if(httpServer) httpServer.close();
      await startServers();
      await showServerMenu();
      break;
    case 2:
      if(fs.existsSync(".noll-env")) fs.unlinkSync(".noll-env");
      await runWizard();
      await startServers();
      await showServerMenu();
      break;
    case 3:
      console.log(chalk.yellow("再见"));
      process.exit(0);
  }
}

// 命令行参数解析
let globalSkipMenu = false;
let globalPipeMode = null;
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  for(let i=0;i<args.length;i++) {
    const a = args[i];
    if(a==="--chat") globalSkipMenu = true;
    if(a==="--summarize"||a==="--extract") globalPipeMode = a;
    if(a==="--help") {console.log("参数：--chat 直接进聊天");process.exit(0);}
  }
}

// 程序入口
async function main() {
  parseCommandLineArgs();
  if(!loadConfig()) await runWizard();
  loadProfile();
  initConversationsDir();
  await startServers();
  await new Promise(r=>setTimeout(r,1000));

  if(globalSkipMenu) await startCLIChat();
  else await showServerMenu();
}

// 启动
main().catch(err=>console.log(chalk.red("全局异常：",err)));
