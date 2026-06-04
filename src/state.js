const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROFILE_PATH = path.resolve('profile.json');

let HP = 100;
let MP = 98;
let Desire = 3;
let Like = 599;
let memory = [];
let profile = { facts: [], rules: [] };
let lastInteractionTime = Date.now();
let lastThoughtContent = "先生今天会来吗...";
let isProcessing = false;
let isEvolving = false;
let attachedFiles = [];
let commandHistory = [];
let currentConversationId = "default";

const ROLE_INFO = {
  name: "诺艾儿",
  role: "内向胆小猫耳少女",
  gender: "女",
  personality: "敏感、缺安全感、轻声细语、依赖先生"
};

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    }
  } catch (e) {
    console.log("无角色配置，使用默认");
  }
}

function saveProfile() {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
}

function addMemory(role, text) {
  memory.push({ role, text, time: Date.now() });
  const limit = config.get('MEMORY_LIMIT') || 20;
  if (memory.length > limit) memory.shift();
}

function getRecentMemory(count = 4) {
  return memory.slice(-count);
}

function getStatus() {
  return { HP, MP, Desire, Like, role: ROLE_INFO };
}

function updateStatus(delta) {
  Like = Math.max(0, Math.min(999, Like + (delta.likeChange || 0)));
  Desire = Math.max(0, Math.min(100, Desire + (delta.desireChange || 0)));
}

function touchInteraction() {
  lastInteractionTime = Date.now();
}

module.exports = {
  HP, MP, Desire, Like, memory, profile,
  lastInteractionTime, lastThoughtContent,
  isProcessing, isEvolving, attachedFiles,
  commandHistory, currentConversationId,
  ROLE_INFO,
  loadProfile, saveProfile,
  addMemory, getRecentMemory,
  getStatus, updateStatus,
  touchInteraction
};
