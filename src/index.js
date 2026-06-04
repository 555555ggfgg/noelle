const http = require('http');
const https = require('https');
const config = require('./config');
const state = require('./state');
const { createWebSocketServer } = require('./ws/server');
const { initConversationsDir } = require('./ws/conversations');
const { createMCPServer } = require('./mcp/server');
const { createAPIServer } = require('./api/server');
const { initThinkLogDir } = require('./core/evolve');
const { ensurePortAvailable } = require('./utils/port');
const { checkForUpdate, getUpdateInfo, cleanOldRollbacks } = require('./utils/update');
const { startCLIChat, showServerMenu } = require('./cli/chat');
const { runWizard } = require('./cli/wizard');

let serverURLs = {};

async function startServers() {
  initThinkLogDir();
  initConversationsDir();

  if (config.get('BACKEND_TYPE') === "ollama") {
    checkOllamaHealth();
  }

  const apiPort = config.get('OPENAI_API_ENABLED')
    ? config.get('OPENAI_API_PORT')
    : config.get('PORT') + 2;
  const ports = [config.get('PORT'), config.get('PORT') + 1, apiPort];

  for (const p of ports) {
    if (!await ensurePortAvailable(config.get('BIND_IP'), p)) {
      console.error(`端口 ${p} 不可用，请修改配置或释放端口`);
      process.exit(1);
    }
  }

  let wsHttp;
  if (config.get('SSL_ENABLED')) {
    const fs = require('fs');
    const opt = {
      cert: fs.readFileSync(config.get('SSL_CERT')),
      key: fs.readFileSync(config.get('SSL_KEY'))
    };
    wsHttp = https.createServer(opt);
  } else {
    wsHttp = http.createServer();
  }

  const wss = createWebSocketServer(wsHttp);

  const mcpPort = config.get('PORT') + 1;
  const mcpServer = createMCPServer(mcpPort, config.get('BIND_IP'));

  const apiServer = createAPIServer(apiPort, config.get('BIND_IP'));

  const proto = config.get('SSL_ENABLED') ? "wss" : "ws";
  serverURLs = {
    web: `http://${config.get('BIND_IP')}:${apiPort}`,
    websocket: `${proto}://${config.get('BIND_IP')}:${config.get('PORT')}`,
    mcp: `http://${config.get('BIND_IP')}:${mcpPort}/mcp`,
    api: `http://${config.get('BIND_IP')}:${apiPort}/v1`
  };

  wsHttp.listen(config.get('PORT'), config.get('BIND_IP'), () => {
    console.log(`🔌 WebSocket: ${serverURLs.websocket}`);
  });

  return serverURLs;
}

function checkOllamaHealth() {
  const http = require('http');
  const req = http.request({
    hostname: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 5000
  }, (res) => {
    console.log("✅ Ollama 服务连接正常");
  });
  req.on('error', () => console.warn("⚠️ Ollama 服务未响应，请确保已启动"));
  req.end();
}

function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  const result = { skipMenu: false, showUpdateMenu: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chat") result.skipMenu = true;
    if (args[i] === "--update") result.showUpdateMenu = true;
    if (args[i] === "--help") {
      console.log("");
      console.log("  Noelle · 诺艾尔 AI  v3.1");
      console.log("");
      console.log("  用法:  node src/index.js [选项]");
      console.log("         npm start");
      console.log("         npm run chat");
      console.log("");
      console.log("  选项:");
      console.log("    --chat   跳过主菜单，直接进入 CLI 聊天");
      console.log("    --update 检查更新");
      console.log("    --help   显示此帮助");
      console.log("");
      process.exit(0);
    }
  }
  return result;
}

async function main() {
  console.log("");
  console.log("  ╭─────────────────────────────────────╮");
  console.log("  │   ✦  Noelle · 诺艾尔  AI  v3.1  ✦   │");
  console.log("  │   内向胆小猫耳少女 · 拟人化交互系统    │");
  console.log("  │                                     │");
  console.log("  │   命令:  node src/index.js           │");
  console.log("  │         npm start                    │");
  console.log("  │         npm run chat                 │");
  console.log("  ╰─────────────────────────────────────╯");
  console.log("");

  const args = parseCommandLineArgs();

  if (!config.loadConfig()) {
    await runWizard();
  }

  state.loadProfile();
  initConversationsDir();

  const urls = await startServers();
  await new Promise(r => setTimeout(r, 1000));

  if (args.showUpdateMenu) {
    const { handleUpdateCommand } = require('./cli/chat');
    await handleUpdateCommand();
    if (!args.skipMenu) showServerMenu();
  }

  cleanOldRollbacks();

  if (args.skipMenu) {
    await startCLIChat(urls);
  } else {
    showServerMenu();
  }
}

main().catch(err => {
  console.error("全局异常:", err);
  process.exit(1);
});
