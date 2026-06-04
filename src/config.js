const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve('.noll-env');

const DEFAULTS = {
  PORT: 3232,
  BIND_IP: "127.0.0.1",
  BACKEND_TYPE: "ollama",
  SSL_ENABLED: false,
  SSL_CERT: "",
  SSL_KEY: "",

  OPENAI_API_ENABLED: false,
  OPENAI_API_PORT: 8080,

  LLAMA_HOST: "127.0.0.1",
  LLAMA_PORT: 8080,
  LLAMA_PATH: "/completion",

  API_PROVIDER: "openrouter",
  API_KEY: "",
  API_MODEL: "qwen2.5-vl:7b",
  API_BASE_URL: "http://localhost:11434/v1/chat/completions",

  THOUGHT_COOLDOWN: 10000,
  EVOLUTION_INTERVAL: 6,
  REFLECTION_INTERVAL: 12,
  AFK_THRESHOLD: 300,
  STREAM_TYPING_SPEED: 60,
  REQUEST_TIMEOUT: 300000,
  ENABLE_DEEP_THINK: true,
  SAVE_THINK_LOG: true,
  THINK_LOG_PATH: "./think_logs/",
  STRATEGY: "standard",
  MEMORY_LIMIT: 20,

  CONVERSATIONS_PATH: "./conversations/",
  CURRENT_CONVERSATION: "default",

  MAX_IMAGE_SIZE: 1024,
  IMAGE_QUALITY: 80,
  VISION_MODELS: '',
  SHELL_BLOCKLIST_ENABLED: true,
  WS_PING_INTERVAL: 30000,

  OPENROUTER_REFERER: "https://github.com/noelle-ai/noelle-system",
  OPENROUTER_TITLE: "Noelle AI Assistant",
  REASONING_EFFORT: "",
  REASONING_MAX_TOKENS: "",
  PROVIDER_SORT: "",
  PROVIDER_ORDER: "",
  PROVIDER_ALLOW_FALLBACKS: true,
  PLUGINS: "",
  OPENROUTER_MODELS: "",
  OPENROUTER_USER: "",
  MIN_P: "",
  TOP_A: "",
  SEED: "",
  FREQUENCY_PENALTY: "",
  PRESENCE_PENALTY: "",

  UPDATE_URL: "",
  AUTO_UPDATE: true
};

let CONFIG = { ...DEFAULTS };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      CONFIG = { ...DEFAULTS, ...raw };
      if (typeof CONFIG.PORT !== 'number' || isNaN(CONFIG.PORT) || CONFIG.PORT <= 0 || CONFIG.PORT > 65535) {
        CONFIG.PORT = DEFAULTS.PORT;
      }
      return true;
    }
  } catch (e) {
    console.error("配置加载失败，使用默认配置:", e.message);
  }
  return false;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
  console.log("✅ 配置已保存到 .noll-env");
}

function get(key) {
  return CONFIG[key];
}

function set(key, value) {
  CONFIG[key] = value;
}

function getAll() {
  return CONFIG;
}

module.exports = { loadConfig, saveConfig, get, set, getAll, DEFAULTS };
