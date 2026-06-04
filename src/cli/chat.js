const fs = require('fs');
const chalk = require('chalk');
const inquirer = require('inquirer');
const readline = require('readline');
const state = require('../state');
const config = require('../config');
const { chatWithOwen, getTokenUsage } = require('../core/chat');
const { evolveMemory, deepReflection } = require('../core/evolve');
const { filePicker } = require('./picker');
const { getClipboardImage } = require('../utils/clipboard');
const { imageToBase64, isVisionModel } = require('../utils/image');
const { supportsVision, supportsReasoning } = require('../utils/models');
const { checkForUpdate, downloadUpdate, applyUpdate, getUpdateInfo, cleanOldRollbacks } = require('../utils/update');
const {
  saveConversation, loadConversation, listConversations,
  deleteConversation, createNewConversation
} = require('../ws/conversations');
const display = require('../ui/display');

const COMMAND_LIST = [
  { cmd: "/help", desc: "显示帮助" },
  { cmd: "/quit", desc: "退出程序" },
  { cmd: "/exit-chat", desc: "返回菜单" },
  { cmd: "/models", desc: "列出本地模型" },
  { cmd: "/url", desc: "查看服务地址" },
  { cmd: "/status", desc: "角色状态" },
  { cmd: "/think", desc: "切换思考显示" },
  { cmd: "/tokens", desc: "查看Token用量" },
  { cmd: "/conv", desc: "多对话管理" },
  { cmd: "/new", desc: "新建对话" },
  { cmd: "!记:", desc: "记录人物事实" },
  { cmd: "!summarize", desc: "文本摘要" },
  { cmd: "!extract", desc: "提取要点" },
  { cmd: "!paste", desc: "粘贴剪贴板图像" },
  { cmd: "/update", desc: "检查并应用更新" }
];

let _serverURLs = {};

async function startCLIChat(urls) {
  _serverURLs = urls || {};
  console.clear();
  await display.showStartupAnimation();

  console.log(chalk.cyan.bold("╔═══════════════════════════════════════╗"));
  console.log(chalk.cyan.bold("║       NOELLE CLI Chat Mode            ║"));
  console.log(chalk.cyan.bold("╚═══════════════════════════════════════╝"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
    removeHistoryDuplicates: true
  });

  function renderStatusBar() {
    const modelName = config.get('API_MODEL').length > 20
      ? config.get('API_MODEL').slice(0, 17) + "..."
      : config.get('API_MODEL');
    const thinkTag = config.get('ENABLE_DEEP_THINK') ? "🧠" : "";
    const visionTag = isVisionModel(config.get('API_MODEL')) ? "🖼️" : "";
    const strategyTag = config.get('STRATEGY') !== "standard" ? `[${config.get('STRATEGY')}]` : "";
    const usage = getTokenUsage();
    const tokens = usage.total_tokens > 0 ? `T:${usage.total_tokens}` : "";
    const convTag = `对话: ${state.currentConversationId.slice(0, 12)}`;

    console.log(chalk.gray(`┌─ ${modelName} ${thinkTag}${visionTag}${strategyTag} | ${convTag} | HP:${state.HP} MP:${state.MP} Desire:${state.Desire} Like:${state.Like} ${tokens}`));
    console.log(chalk.gray("└─ /help 帮助 | /think 思考 | @ 选文件 | !paste 粘贴 | /conv 对话 | /update 更新"));
  }

  renderStatusBar();

  if (config.get('AUTO_UPDATE') && config.get('UPDATE_URL')) {
    checkForUpdate().then(update => {
      if (update) {
        console.log(chalk.green(`\n📦 发现新版本 v${update.latestVersion} (当前: v${getUpdateInfo().currentVersion})`));
        console.log(chalk.gray(`   输入 /update 查看详情并更新`));
      }
    }).catch(() => {});
  }

  const promptUser = () => {
    const shortModel = config.get('API_MODEL').split(':').pop().slice(0, 12);
    const attachedNames = state.attachedFiles.length
      ? chalk.green(`[${state.attachedFiles.map(f => f.name).join(',')}] `)
      : "";

    rl.question(chalk.blue(`\n${shortModel}> `) + attachedNames, async (input) => {
      let userText = input.trim();
      if (userText === "") { promptUser(); return; }

      state.commandHistory.push(userText);

      // !paste - clipboard image
      if (userText === "!paste") {
        console.log(chalk.blue("📋 读取剪贴板图像..."));
        const imgRes = await getClipboardImage();
        if (imgRes) {
          const base64 = await imageToBase64(imgRes.path);
          state.attachedFiles.push({ name: `clip_${Date.now()}.jpg`, content: base64, type: "image" });
          console.log(chalk.green("✅ 已粘贴剪贴板图像"));
        } else {
          console.log(chalk.yellow("⚠️ 剪贴板无可用图像"));
        }
        promptUser();
        return;
      }

      // @ - file picker
      if (userText === "@") {
        rl.pause();
        await filePicker();
        rl.resume();
        promptUser();
        return;
      }

      // Conversation management
      if (userText === "/conv") {
        rl.pause();
        await handleConversationCommand();
        rl.resume();
        renderStatusBar();
        promptUser();
        return;
      }

      if (userText === "/new") {
        saveConversation(state.currentConversationId);
        createNewConversation();
        console.log(chalk.green("✅ 已新建空白对话"));
        renderStatusBar();
        promptUser();
        return;
      }

      // Basic commands
      if (userText === "/quit" || userText === "/exit") {
        saveConversation(state.currentConversationId);
        state.saveProfile();
        console.log(chalk.yellow("\n👋 再见"));
        rl.close();
        process.exit(0);
      }

      if (userText === "/exit-chat") {
        saveConversation(state.currentConversationId);
        state.saveProfile();
        console.log(chalk.yellow("\n退出聊天，返回菜单"));
        rl.close();
        showServerMenu();
        return;
      }

      if (userText === "/help") {
        printHelp();
        promptUser();
        return;
      }

      if (userText === "/status") {
        printStatus();
        promptUser();
        return;
      }

      if (userText === "/models") {
        await printModels();
        promptUser();
        return;
      }

      if (userText === "/url") {
        printUrls();
        promptUser();
        return;
      }

      if (userText === "/think") {
        const current = config.get('ENABLE_DEEP_THINK');
        config.set('ENABLE_DEEP_THINK', !current);
        console.log(chalk.green(`🧠 深度思考显示: ${!current ? '已开启' : '已关闭'}`));
        promptUser();
        return;
      }

      if (userText === "/tokens") {
        const usage = getTokenUsage();
        console.log(chalk.cyan(`📊 Token用量: 输入${usage.prompt_tokens} | 输出${usage.completion_tokens} | 总计${usage.total_tokens}`));
        promptUser();
        return;
      }

      if (userText === "/update") {
        await handleUpdateCommand();
        renderStatusBar();
        promptUser();
        return;
      }

      // Quick tool commands
      if (userText.startsWith("!记:")) {
        const fact = userText.slice(3).trim();
        state.profile.facts.push(fact);
        state.saveProfile();
        console.log(chalk.green(`📝 已记录：${fact}`));
        promptUser();
        return;
      }

      if (userText.startsWith("!summarize ")) {
        const txt = userText.replace("!summarize ", "");
        const prompt = `请精炼摘要以下内容：\n${txt}`;
        state.isProcessing = true;
        state.addMemory("user", prompt);
        const res = await chatWithOwen(prompt);
        if (res) console.log(chalk.green(`📋 摘要：${res.clean}`));
        state.isProcessing = false;
        promptUser();
        return;
      }

      if (userText.startsWith("!extract ")) {
        const txt = userText.replace("!extract ", "");
        const prompt = `提取以下内容关键要点：\n${txt}`;
        state.isProcessing = true;
        state.addMemory("user", prompt);
        const res = await chatWithOwen(prompt);
        if (res) console.log(chalk.green(`📋 要点：${res.clean}`));
        state.isProcessing = false;
        promptUser();
        return;
      }

      // Normal chat
      state.isProcessing = true;
      state.touchInteraction();

      let finalText = userText;
      let imgList = [];

      if (state.attachedFiles.length > 0) {
        const textFiles = state.attachedFiles.filter(f => f.type === "text");
        const imgFiles = state.attachedFiles.filter(f => f.type === "image");

        if (textFiles.length) {
          finalText += "\n\n【附加文件】\n" +
            textFiles.map(f => `--- ${f.name} ---\n${f.content}`).join("\n\n");
        }
        imgList = imgFiles.map(f => ({ base64: f.content, name: f.name }));
        state.attachedFiles = [];
      }

      state.addMemory("user", finalText);
      try {
        const reply = await chatWithOwen(finalText, imgList);
        if (reply) {
          state.updateStatus(reply);
          state.addMemory("ai", reply.clean);
          saveConversation(state.currentConversationId);

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

          renderStatusBar();
        }
      } catch (e) {
        console.log(chalk.red("聊天异常:", e.message));
      } finally {
        state.isProcessing = false;
      }

      promptUser();
    });
  };

  promptUser();
}

function printHelp() {
  console.log(chalk.cyan("\n═══ 命令列表 ═══"));
  console.log(" /help        帮助");
  console.log(" /quit        退出");
  console.log(" /exit-chat   返回菜单");
  console.log(" /conv        多对话管理");
  console.log(" /new         新建对话");
  console.log(" /models      查看模型");
  console.log(" /think       切换思考显示");
  console.log(" /tokens      查看Token用量");
  console.log(" /update      检查更新");
  console.log(" /url         服务地址");
  console.log(" /status      角色状态");
  console.log(" @            选择文件/图片");
  console.log(" !paste       粘贴剪贴板图片");
  console.log(" !记:xxx      记录事实");
  console.log(" !summarize   文本摘要");
  console.log(" !extract     提取要点");
}

function printStatus() {
  const usage = getTokenUsage();
  console.log(chalk.cyan("\n═══ 角色状态 ═══"));
  console.log(` HP: ${state.HP}/100 | MP: ${state.MP}/100 | Desire: ${state.Desire}/100 | 好感: ${state.Like}`);
  console.log(` 模型: ${config.get('API_MODEL')} | 策略: ${config.get('STRATEGY')}`);
  console.log(` 记忆: ${state.memory.length} | 事实: ${state.profile.facts.length} | 规则: ${state.profile.rules.length}`);
  console.log(` Token: ${usage.total_tokens}`);
}

async function printModels() {
  if (config.get('BACKEND_TYPE') === "ollama") {
    try {
      const { execSync } = require('child_process');
      const list = execSync("ollama list", { encoding: "utf8" });
      console.log(chalk.cyan("\n═══ Ollama模型 ═══\n"), list);
    } catch (e) {
      console.log(chalk.red("获取模型失败"));
    }
    return;
  }

  if (config.get('BACKEND_TYPE') === "api") {
    const provider = (config.get('API_PROVIDER') || '').toLowerCase();
    const modelName = config.get('API_MODEL');
    console.log(chalk.cyan(`\n═══ 当前模型: ${modelName} ═══`));
    console.log(`  提供商: ${config.get('API_PROVIDER')}`);

    if (provider === 'openrouter') {
      try {
        const { getModelList, findModel } = require('../utils/models');
        const model = await findModel(modelName);
        if (model) {
          const ctx = model.context_length ? `${(model.context_length / 1024).toFixed(0)}k` : '?';
          const pricing = model.pricing
            ? `输入: $${(parseFloat(model.pricing.prompt) * 1e6).toFixed(2)}/M | 输出: $${(parseFloat(model.pricing.completion) * 1e6).toFixed(2)}/M`
            : '价格未知';
          console.log(`  上下文: ${ctx}`);
          console.log(`  定价: ${pricing}`);
          console.log(`  视觉: ${(model.input_modalities || []).includes('image') ? '✅' : '❌'}`);
          console.log(`  推理: ${(model.supported_parameters || []).includes('reasoning') ? '✅' : '❌'}`);
          console.log(`  工具: ${(model.supported_parameters || []).includes('tools') ? '✅' : '❌'}`);
        } else {
          console.log(chalk.gray("  未在 OpenRouter 模型列表中找到，可能是别名或自定义模型"));
        }
      } catch (e) {
        console.log(chalk.gray("  无法获取模型详情"));
      }
    }
    return;
  }

  console.log(chalk.gray(`后端: ${config.get('BACKEND_TYPE')} | 模型: ${config.get('API_MODEL')}`));
}

function printUrls() {
  console.log(chalk.cyan("\n═══ 服务地址 ═══"));
    Object.entries(_serverURLs).forEach(([k, v]) => console.log(chalk.green(` ${k}: ${v}`)));
}

async function handleConversationCommand() {
  const convs = listConversations();
  const opts = [
    { name: "🆕 新建对话", value: "new" },
    { name: "🔄 切换对话", value: "switch" },
    { name: "🗑️ 删除对话", value: "delete" },
    { name: "❌ 取消", value: "cancel" }
  ];

  const { act } = await inquirer.prompt([{
    type: "list", name: "act", message: "多对话管理", choices: opts
  }]);

  switch (act) {
    case "new":
      saveConversation(state.currentConversationId);
      createNewConversation();
      console.log(chalk.green("✅ 新建对话完成"));
      break;

    case "switch":
      if (!convs.length) {
        console.log(chalk.gray("暂无保存的对话"));
        return;
      }
      saveConversation(state.currentConversationId);
      const switchOpts = convs.map(c => ({
        name: `${c.name} | ${new Date(c.updatedAt).toLocaleString()}`,
        value: c.id
      })).concat([{ name: "❌ 取消", value: "cancel" }]);
      const { sid } = await inquirer.prompt([{
        type: "list", name: "sid", message: "选择对话", choices: switchOpts
      }]);
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
      const delOpts = convs.map(c => ({
        name: c.name,
        value: c.id
      })).concat([{ name: "❌ 取消", value: "cancel" }]);
      const { did } = await inquirer.prompt([{
        type: "list", name: "did", message: "删除对话", choices: delOpts
      }]);
      if (did !== "cancel") {
        if (did === state.currentConversationId) createNewConversation();
        deleteConversation(did);
        console.log(chalk.green(`✅ 已删除对话：${did}`));
      }
      break;
  }
}

async function handleUpdateCommand() {
  const info = getUpdateInfo();
  console.log(chalk.cyan(`\n═══ 更新管理 ═══`));
  console.log(`  当前版本: v${info.currentVersion}`);
  console.log(`  更新地址: ${info.updateUrl || '(未配置)'}`);

  if (!info.updateUrl) {
    console.log(chalk.yellow(`\n⚠️ 未配置更新服务器地址`));
    console.log(chalk.gray(`  请在配置中设置 UPDATE_URL (如 http://your-server:3456)`));
    return;
  }

  console.log(chalk.gray(`\n  正在检查更新...`));
  const update = await checkForUpdate();
  if (!update) {
    console.log(chalk.green(`  ✅ 已是最新版 v${info.currentVersion}`));
    return;
  }

  console.log(chalk.green(`\n  📦 发现新版本: v${update.latestVersion}`));
  if (update.releaseDate) console.log(`  发布日期: ${update.releaseDate}`);
  if (update.changelog) console.log(`  更新日志:\n${update.changelog.split('\n').map(l => `    ${l}`).join('\n')}`);

  const { apply } = await inquirer.prompt([{
    type: "confirm", name: "apply", message: "是否下载并应用更新?", default: false
  }]);

  if (!apply) {
    console.log(chalk.gray("  已取消更新"));
    return;
  }

  try {
    console.log(chalk.cyan(`  正在下载 v${update.latestVersion}...`));
    const zipPath = await downloadUpdate(update.latestVersion, update.downloadUrl);
    console.log(chalk.cyan(`  正在应用更新...`));
    applyUpdate(update.latestVersion, zipPath);
    console.log(chalk.green(`  ✅ 更新完成! 请重启程序以使用新版本 v${update.latestVersion}`));
    cleanOldRollbacks();
  } catch (e) {
    console.log(chalk.red(`  ❌ 更新失败: ${e.message}`));
  }
}

async function showServerMenu() {
  console.log(chalk.cyan.bold("\n==== NOELLE 主菜单 ===="));
  console.log(chalk.gray(`后端:${config.get('BACKEND_TYPE')} 模型:${config.get('API_MODEL')} 策略:${config.get('STRATEGY')}`));
  const { action } = await inquirer.prompt([{
    type: "list", name: "action", message: "请选择",
    choices: [
      { name: "💬 进入CLI聊天", value: "chat" },
      { name: "🔄 重启服务", value: "restart" },
      { name: "⚙️  重新配置", value: "reconfig" },
      { name: "🚪 退出程序", value: "exit" }
    ]
  }]);
  switch (action) {
    case "chat":
      await startCLIChat(_serverURLs);
      break;
    case "restart":
      console.log("重启服务...");
      process.exit(0);
    case "reconfig":
      if (fs.existsSync(".noll-env")) fs.unlinkSync(".noll-env");
      process.exit(0);
    case "exit":
      console.log(chalk.yellow("再见"));
      process.exit(0);
  }
}

module.exports = { startCLIChat, showServerMenu };
