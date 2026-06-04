const chalk = require('chalk');
const config = require('../config');

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let generatingTimer = null;
let generatingStart = 0;

function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}S`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}M${sec}S`;
}

function startGeneratingTimer() {
  generatingStart = Date.now();
  let frameIdx = 0;
  generatingTimer = setInterval(() => {
    const elapsed = Date.now() - generatingStart;
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    frameIdx++;
    process.stdout.write(`\r${chalk.magenta(frame)} ${chalk.gray('生成中')} ${chalk.bold.white(formatElapsed(elapsed))}   `);
  }, 120);
}

function stopGeneratingTimer() {
  if (generatingTimer) {
    clearInterval(generatingTimer);
    generatingTimer = null;
    const elapsed = Date.now() - generatingStart;
    process.stdout.write(`\r${chalk.green('✓')} ${chalk.gray('生成完成')} ${chalk.bold.green(formatElapsed(elapsed))}   \n`);
  }
}

async function typeWriter(text, color = chalk.green, speed) {
  if (!text || text.length === 0) { console.log(""); return; }
  const ms = speed || config.get('STREAM_TYPING_SPEED');
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
    }, ms);
  });
}

let thinkingStreamActive = false;
let thinkingBuffer = "";

function startThinkingStream() {
  thinkingStreamActive = true;
  thinkingBuffer = "";
  if (config.get('ENABLE_DEEP_THINK')) {
    process.stdout.write(chalk.yellow.bold("\nThinking... "));
  }
}

function feedThinkingChunk(chunk) {
  if (!chunk || !config.get('ENABLE_DEEP_THINK')) return;
  thinkingBuffer += chunk;
  if (thinkingStreamActive) {
    process.stdout.write(chalk.yellow(chunk));
  }
}

function endThinkingStream() {
  thinkingStreamActive = false;
  if (thinkingBuffer && config.get('ENABLE_DEEP_THINK')) {
    console.log(chalk.yellow.bold(`\n...思考完成 (${thinkingBuffer.length}字)`));
  }
  return thinkingBuffer;
}

function getBeautyTriad(thought, emotion, action) {
  return `
💭 内心独白：${thought}
😶 情绪状态：${emotion}
🤌 肢体动作：${action}
`;
}

async function showStartupAnimation() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  process.stdout.write(chalk.magenta.bold("  NOELLE SYSTEM 启动中 "));
  for (let i = 0; i < 15; i++) {
    process.stdout.write(chalk.magenta(frames[i % frames.length]));
    await new Promise(r => setTimeout(r, 80));
    process.stdout.write('\b');
  }
  process.stdout.write(chalk.green('✓\n'));
}

module.exports = {
  startGeneratingTimer, stopGeneratingTimer,
  typeWriter, startThinkingStream, feedThinkingChunk, endThinkingStream,
  getBeautyTriad, showStartupAnimation
};
