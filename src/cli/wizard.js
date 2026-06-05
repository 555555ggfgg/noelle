const chalk = require('chalk');
const readlineSync = require('readline-sync');
const inquirer = require('inquirer');
const { execSync } = require('child_process');
const config = require('../config');
const { checkPortOpen } = require('../utils/port');
const { getModelList, listModelsByCapability, invalidateCache } = require('../utils/models');

function selectMenu(options, title = "请选择") {
  return inquirer.prompt([{
    type: "list", name: "opt", message: title, choices: options, prefix: ""
  }]).then(a => options.indexOf(a.opt));
}

function input(prompt, def = "") {
  const tip = def ? `[默认:${def}]` : "";
  return readlineSync.question(chalk.cyan(`\n${prompt} ${tip} `)).trim() || def;
}

function checkLlamaCppInstalled() {
  try { execSync("llama-server --version", { stdio: "ignore" }); return true; } catch (e) { return false; }
}

function checkOllamaInstalled() {
  try { execSync("ollama --version", { stdio: "ignore" }); return true; } catch (e) { return false; }
}

async function runWizard() {
  console.clear();
  console.log(chalk.cyan.bold("==== NOELLE 初始化向导 ===="));

  const backOpts = ["llama.cpp 本地", "ollama 本地", "在线API"];
  const bid = await selectMenu(backOpts, "选择后端");

  if (bid === 0) {
    config.set("BACKEND_TYPE", "llama.cpp");
    await setupLlamaCpp();
  } else if (bid === 1) {
    config.set("BACKEND_TYPE", "ollama");
    await setupOllama();
  } else {
    config.set("BACKEND_TYPE", "api");
    await setupAPI();
  }

  let port = parseInt(input("WebSocket端口", config.get("PORT")));
  if (isNaN(port) || port < 0 || port > 65535) port = config.get("PORT") || 3232;
  config.set("PORT", port);
  config.set("BIND_IP", input("绑定IP", config.get("BIND_IP")));

  const apiEn = await selectMenu(["禁用", "启用"], "启用OpenAI兼容API？");
  config.set("OPENAI_API_ENABLED", apiEn === 1);
  if (apiEn === 1) {
    config.set("OPENAI_API_PORT", parseInt(input("API端口", config.get("OPENAI_API_PORT"))));
  }

  config.saveConfig();
}

async function setupLlamaCpp() {
  if (!checkLlamaCppInstalled()) {
    console.log(chalk.red("未安装 llama.cpp"));
    console.log("请先安装: https://github.com/ggml-org/llama.cpp");
    process.exit(1);
  }
  while (!await checkPortOpen(config.get('LLAMA_HOST'), config.get('LLAMA_PORT'))) {
    const ok = await selectMenu(["已启动", "修改端口"], "未检测到 llama-server");
    if (ok === 1) config.set("LLAMA_PORT", parseInt(input("输入端口")));
  }
}

async function setupOllama() {
  if (!checkOllamaInstalled()) {
    console.log(chalk.red("未安装 ollama"));
    console.log("请先安装: https://ollama.ai");
    process.exit(1);
  }
  const list = execSync("ollama list", { encoding: "utf8" })
    .split("\n").slice(1).filter(l => l.trim());
  if (!list.length) {
    console.log(chalk.yellow("请先执行 ollama pull <模型名>"));
    process.exit(1);
  }
  const models = list.map(l => l.split(/\s+/)[0]);
  const mid = await selectMenu(models, "选择模型");
  config.set("API_MODEL", models[mid]);
  config.set("API_BASE_URL", "http://localhost:11434/v1/chat/completions");
}

async function setupAPI() {
  const providers = [
    { id: "openai",    name: "OpenAI",            base: "https://api.openai.com/v1/chat/completions",                                     def: "gpt-4o-mini" },
    { id: "anthropic", name: "Anthropic (Claude)", base: "https://api.anthropic.com/v1/messages",                                           def: "claude-sonnet-4-20250514" },
    { id: "openrouter",name: "OpenRouter",         base: "https://openrouter.ai/api/v1/chat/completions",                                  def: "" },
    { id: "azure",     name: "Azure OpenAI",       base: "",                                                                                def: "gpt-4o-mini" },
    { id: "google",    name: "Google Gemini",      base: "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse", def: "gemini-2.0-flash" },
    { id: "groq",      name: "Groq",               base: "https://api.groq.com/openai/v1/chat/completions",                                def: "llama-3.3-70b-versatile" },
    { id: "together",  name: "Together AI",        base: "https://api.together.xyz/v1/chat/completions",                                   def: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    { id: "mistral",   name: "Mistral AI",         base: "https://api.mistral.ai/v1/chat/completions",                                     def: "mistral-large-latest" },
    { id: "perplexity",name: "Perplexity",          base: "https://api.perplexity.ai/chat/completions",                                     def: "sonar-pro" },
    { id: "xai",       name: "xAI Grok",           base: "https://api.x.ai/v1/chat/completions",                                           def: "grok-2-latest" },
    { id: "deepseek",  name: "DeepSeek",           base: "https://api.deepseek.com/v1/chat/completions",                                   def: "deepseek-chat" },
    { id: "硅基流动",   name: "硅基流动",           base: "https://api.siliconflow.cn/v1/chat/completions",                                 def: "Qwen/Qwen2.5-7B-Instruct" },
    { id: "百度",       name: "百度文心一言",       base: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions", def: "ernie-3.5-8k" },
    { id: "custom",    name: "自定义",              base: "",                                                                                def: "" }
  ];
  const pNames = providers.map(x => x.name);
  const pid = await selectMenu(pNames, "选择API提供商");
  const p = providers[pid];
  config.set("API_PROVIDER", p.id);
  config.set("API_BASE_URL", input("API地址", p.base));
  config.set("API_KEY", input("API密钥"));

  if (p.id === "openrouter") {
    await setupOpenRouterModel();
  } else if (p.id === "azure") {
    config.set("API_BASE_URL", input("Azure OpenAI 端点 (含部署名)", "https://your-resource.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions"));
    config.set("API_MODEL", input("模型部署名", "gpt-4o-mini"));
    config.set("OPENAI_API_VERSION", input("API版本", "2024-08-01-preview"));
  } else if (p.id === "openai") {
    const orgId = input("组织ID (可选，留空跳过)");
    if (orgId) config.set("OPENAI_ORG_ID", orgId);
    const reasoningEffort = await selectMenu(["禁用", "启用"], "启用 o1/o3 推理参数 (reasoning_effort)？");
    if (reasoningEffort === 1) {
      config.set("REASONING_EFFORT", input("推理力度 (low/medium/high)", "medium"));
    }
    config.set("API_MODEL", input("模型名", p.def));
  } else if (p.id === "anthropic") {
    config.set("API_MODEL", input("模型名", p.def));
    config.set("ANTHROPIC_API_VERSION", input("API版本", config.get("ANTHROPIC_API_VERSION")));
  } else if (p.id === "google") {
    config.set("GOOGLE_API_KEY", input("Google API密钥"));
    const model = input("模型名", p.def);
    config.set("API_MODEL", model);
    const baseUrl = config.get("API_BASE_URL").replace("{model}", model);
    config.set("API_BASE_URL", baseUrl);
    config.set("API_KEY", config.get("GOOGLE_API_KEY"));
  } else if (p.id === "custom") {
    config.set("API_MODEL", input("模型名", ""));
  } else {
    config.set("API_MODEL", input("模型名", p.def));
  }
}

async function setupOpenRouterModel() {
  const modelSource = await selectMenu(
    ["从 OpenRouter 在线获取模型列表", "手动输入模型名"],
    "选择模型方式"
  );

  if (modelSource === 0) {
    console.log(chalk.cyan("\n正在获取 OpenRouter 模型列表..."));
    try {
      invalidateCache();
      const allModels = await getModelList();
      console.log(chalk.green(`✅ 获取到 ${allModels.length} 个模型\n`));

      const filterOpts = ["显示全部", "仅免费模型", "仅视觉模型", "仅推理模型", "按价格筛选"];
      const filterIdx = await selectMenu(filterOpts, "模型筛选");

      let filtered = allModels;
      if (filterIdx === 1) {
        filtered = allModels.filter(m => {
          const p = m.pricing;
          return p && parseFloat(p.prompt) === 0 && parseFloat(p.completion) === 0;
        });
      } else if (filterIdx === 2) {
        filtered = allModels.filter(m => (m.input_modalities || []).includes('image'));
      } else if (filterIdx === 3) {
        filtered = allModels.filter(m => (m.supported_parameters || []).includes('reasoning'));
      } else if (filterIdx === 4) {
        const maxP = parseFloat(input("最大价格 ($/M tokens)", "1")) || 1;
        filtered = allModels.filter(m => {
          const p = m.pricing;
          if (!p) return false;
          return parseFloat(p.prompt) <= maxP && parseFloat(p.completion) <= maxP;
        });
      }

      if (filtered.length === 0) {
        console.log(chalk.yellow("⚠️ 无匹配模型，使用全部列表"));
        filtered = allModels;
      }

      filtered.sort((a, b) => {
        const pa = a.pricing ? parseFloat(a.pricing.prompt) || 0 : 0;
        const pb = b.pricing ? parseFloat(b.pricing.prompt) || 0 : 0;
        return pa - pb;
      });

      const modelChoices = filtered.slice(0, 100).map(m => {
        const price = m.pricing
          ? `$${(parseFloat(m.pricing.prompt) * 1e6).toFixed(2)}/M in`
          : '';
        const vision = (m.input_modalities || []).includes('image') ? '🖼️' : '';
        const reasoning = (m.supported_parameters || []).includes('reasoning') ? '🧠' : '';
        const ctx = m.context_length ? `ctx:${(m.context_length / 1024).toFixed(0)}k` : '';
        return {
          name: `${m.id} ${vision}${reasoning} ${price} ${ctx}`.trim().slice(0, 80),
          value: m.id
        };
      });

      if (filtered.length > 100) {
        modelChoices.push({ name: chalk.yellow(`...及 ${filtered.length - 100} 个更多模型（输入自定义）`), value: "__more__" });
      }

      modelChoices.push({ name: "手动输入", value: "__custom__" });

      const { selected } = await inquirer.prompt([{
        type: "list", name: "selected", message: "选择模型 (按价格排序)",
        choices: modelChoices, pageSize: 20, prefix: ""
      }]);

      if (selected === "__custom__") {
        config.set("API_MODEL", input("输入模型名", "openai/gpt-4o-mini"));
      } else {
        config.set("API_MODEL", selected);
      }
    } catch (e) {
      console.log(chalk.yellow(`⚠️ 获取模型列表失败: ${e.message}`));
      config.set("API_MODEL", input("输入模型名", "openai/gpt-4o-mini"));
    }
  } else {
    config.set("API_MODEL", input("输入模型名", "openai/gpt-4o-mini"));
  }

  const reasoningChoice = await selectMenu(["自动检测", "启用推理 (reasoning)", "禁用推理"], "推理模型设置");
  if (reasoningChoice === 1) {
    config.set("REASONING_EFFORT", input("推理力度 (low/medium/high)", "medium"));
  } else if (reasoningChoice === 0) {
    const modelId = config.get('API_MODEL');
    try {
      const { supportsReasoning: checkReasoning } = require('../utils/models');
      const canReason = await checkReasoning(modelId);
      if (canReason) {
        config.set("REASONING_EFFORT", "medium");
        console.log(chalk.green("🧠 自动检测到推理模型，已启用 medium 推理"));
      }
    } catch (e) {}
  }

  const sortOptions = ["默认(负载均衡)", "按价格排序", "按吞吐量排序", "按延迟排序"];
  const sortIdx = await selectMenu(sortOptions, "提供商排序策略");
  if (sortIdx > 0) {
    config.set("PROVIDER_SORT", ["", "price", "throughput", "latency"][sortIdx]);
  }
}

module.exports = { runWizard };
