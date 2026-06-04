const fs = require('fs');
const path = require('path');
const state = require('../state');
const config = require('../config');

function initConversationsDir() {
  const dir = config.get('CONVERSATIONS_PATH');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveConversation(id) {
  const dir = config.get('CONVERSATIONS_PATH');
  const convPath = path.join(dir, `${id}.json`);
  let createdAt = Date.now();
  try {
    if (fs.existsSync(convPath)) {
      const existing = JSON.parse(fs.readFileSync(convPath, 'utf8'));
      if (existing.createdAt) createdAt = existing.createdAt;
    }
  } catch (e) {}
  const convData = {
    id,
    name: `对话 ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    memory: state.memory,
    HP: state.HP,
    MP: state.MP,
    Desire: state.Desire,
    Like: state.Like,
    createdAt,
    updatedAt: Date.now()
  };
  fs.writeFileSync(convPath, JSON.stringify(convData, null, 2), (e) => {
    if (e) console.error("保存对话失败:", e.message);
  });
}

function loadConversation(id) {
  const dir = config.get('CONVERSATIONS_PATH');
  const convPath = path.join(dir, `${id}.json`);
  if (fs.existsSync(convPath)) {
    const convData = JSON.parse(fs.readFileSync(convPath, 'utf8'));
    state.memory.length = 0;
    (convData.memory || []).forEach(m => state.memory.push(m));
    state.HP = convData.HP || 100;
    state.MP = convData.MP || 98;
    state.Desire = convData.Desire || 3;
    state.Like = convData.Like || 599;
    state.currentConversationId = id;
    return true;
  }
  return false;
}

function listConversations() {
  const dir = config.get('CONVERSATIONS_PATH');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const id = f.replace('.json', '');
        const convPath = path.join(dir, f);
        try {
          const data = JSON.parse(fs.readFileSync(convPath, 'utf8'));
          return { id, name: data.name || id, updatedAt: data.updatedAt || 0 };
        } catch (e) {
          return { id, name: id, updatedAt: 0 };
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    return [];
  }
}

function deleteConversation(id) {
  const dir = config.get('CONVERSATIONS_PATH');
  const convPath = path.join(dir, `${id}.json`);
  if (fs.existsSync(convPath)) {
    fs.unlinkSync(convPath);
    return true;
  }
  return false;
}

function createNewConversation() {
  const id = `conv_${Date.now()}`;
  state.memory.length = 0;
  state.HP = 100;
  state.MP = 98;
  state.Desire = 3;
  state.Like = 599;
  state.currentConversationId = id;
  saveConversation(id);
  return id;
}

module.exports = {
  initConversationsDir, saveConversation, loadConversation,
  listConversations, deleteConversation, createNewConversation
};
