const WS_PORT = location.port || '3232';
let ws = null;
let currentFiles = [];
let currentEmotion = 'normal';
let currentAction = '';

const EMOJI_MAP = {
  normal: '😶', 开心: '😊', 害羞: '😳', 疑惑: '🤔',
 伤心: '😢', 生气: '😤', 担心: '😟', 期待: '🥺',
 害怕: '😰', 感动: '🥹', 惊喜: '🎉', 疲惫: '😮‍💨'
};

function getEmoji(e) { return EMOJI_MAP[e] || '😶'; }

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname || '127.0.0.1';
  const url = `${proto}://${host}:${WS_PORT}`;

  setConnStatus('connecting');

  ws = new WebSocket(url);

  ws.onopen = () => {
    setConnStatus('connected');
    addSystemMsg('💕 诺艾尔轻轻来到你身边...');
    setTimeout(loadConvList, 1000);
  };

  ws.onclose = () => {
    setConnStatus('disconnected');
    addSystemMsg('🔌 诺艾尔暂时离开了...');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    setConnStatus('error');
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleMessage(data);
    } catch (err) {
      console.error('Parse error:', err);
    }
  };
}

function setConnStatus(status) {
  const el = document.getElementById('conn-status');
  const map = {
    connecting: { text: '◌ 连接中...', color: '#f39c12' },
    connected: { text: '● 已连接', color: '#2ecc71' },
    disconnected: { text: '○ 已断开', color: '#e74c3c' },
    error: { text: '✕ 连接错误', color: '#e74c3c' }
  };
  const s = map[status] || map.disconnected;
  el.textContent = s.text;
  el.style.color = s.color;
}

// --- Message handling ---
function handleMessage(data) {
  hideTyping();

  if (data.text) {
    addAIMsg(data.text, data.emotion || data.情绪, data.action, data.thinking);
  }

  if (data.HP !== undefined) updateStats(data);
  const emotion = data.emotion || data.情绪;
  if (emotion) {
    currentEmotion = emotion;
    updateEmotion(emotion, data.action);
  }
}

function showThinking(thinkingText) {
  const overlay = document.getElementById('thinking-overlay');
  const content = document.getElementById('thinking-content');
  content.textContent = thinkingText;
  overlay.classList.remove('hidden');
}

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.add('hidden');
});

function addAIMsg(text, emotion, action, thinking) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ai';

  const emoji = getEmoji(emotion);
  let meta = '';
  if (emotion) meta += `${emoji} ${emotion}`;
  if (action) meta += ` · ${action}`;

  let thinkingBtn = '';
  if (thinking) {
    const id = 'think-' + Date.now();
    thinkingBtn = `<span class="think-btn" data-think="${id}" style="font-size:11px;color:var(--accent-light);cursor:pointer;display:inline-block;margin-top:4px">💭 查看内心独白</span>`;
    const hiddenDiv = document.createElement('div');
    hiddenDiv.id = id;
    hiddenDiv.style.display = 'none';
    hiddenDiv.textContent = thinking;
    document.body.appendChild(hiddenDiv);
  }

  div.innerHTML = `
    <div class="msg-avatar">🐱</div>
    <div class="msg-content">
      <div class="msg-bubble">${escapeHtml(text)}</div>
      ${thinkingBtn}
      ${meta ? `<div class="msg-emotion">${meta}</div>` : ''}
    </div>
  `;

  container.appendChild(div);

  if (thinking) {
    const btn = div.querySelector('.think-btn');
    btn.addEventListener('click', () => {
      const id = btn.dataset.think;
      const content = document.getElementById(id);
      if (content) showThinking(content.textContent);
    });
  }

  scrollBottom();
}

function addUserMsg(text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `
    <div class="msg-avatar">👤</div>
    <div class="msg-content">
      <div class="msg-bubble">${escapeHtml(text)}</div>
    </div>
  `;
  container.appendChild(div);
  scrollBottom();
}

function addSystemMsg(text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-avatar">🐱</div>
    <div class="msg-content">
      <div class="msg-bubble" style="background:transparent;text-align:center;font-size:12px;color:var(--text-dim)">${escapeHtml(text)}</div>
    </div>
  `;
  container.appendChild(div);
  scrollBottom();
}

function showTyping() {
  document.getElementById('typing-indicator').classList.remove('hidden');
  scrollBottom();
}

function hideTyping() {
  document.getElementById('typing-indicator').classList.add('hidden');
}

// --- Stats ---
function updateStats(data) {
  animateBar('hp-bar', 'hp-text', data.HP, 100);
  animateBar('mp-bar', 'mp-text', data.MP, 100);
  animateBar('desire-bar', 'desire-text', data.Desire, 100);
  animateBar('like-bar', 'like-text', data.Like, 999);
}

function animateBar(barId, textId, value, max) {
  const bar = document.getElementById(barId);
  const text = document.getElementById(textId);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  bar.style.width = pct + '%';
  text.textContent = Math.round(value);
}

// --- Emotion ---
function updateEmotion(emotion, action) {
  const icon = document.getElementById('emotion-icon');
  const text = document.getElementById('emotion-text');
  icon.textContent = getEmoji(emotion);
  text.textContent = action ? `${emotion} · ${action}` : emotion;
}

// --- Input ---
function sendMessage() {
  const input = document.getElementById('msg-input');
  let text = input.value.trim();
  if (!text && currentFiles.length === 0) return;

  if (currentFiles.length > 0) {
    const fileInfo = currentFiles.map(f => f.name).join(', ');
    text = text || `[发送了附件: ${fileInfo}]`;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    addUserMsg(text);
    ws.send(text);
    showTyping();
  } else {
    addSystemMsg('⚠️ 诺艾尔不在线，正在重连...');
    connectWS();
  }

  input.value = '';
  input.style.height = 'auto';
  clearFiles();
}

// --- File handling ---
document.getElementById('btn-file').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', (e) => {
  for (const file of e.target.files) {
    if (currentFiles.length >= 5) break;
    if (file.size > 5 * 1024 * 1024) {
      addSystemMsg(`⚠️ ${file.name} 超过5MB限制，已跳过`);
      continue;
    }
    currentFiles.push(file);
  }
  e.target.value = '';
  renderFilePreview();
});

function renderFilePreview() {
  const container = document.getElementById('file-preview');
  container.innerHTML = currentFiles.map((f, i) =>
    `<span class="file-tag">📎 ${f.name} <span class="remove-file" data-idx="${i}">✕</span></span>`
  ).join('');

  container.querySelectorAll('.remove-file').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      currentFiles.splice(idx, 1);
      renderFilePreview();
    });
  });
}

function clearFiles() {
  currentFiles = [];
  renderFilePreview();
}

// --- Events ---
document.getElementById('btn-send').addEventListener('click', sendMessage);

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('msg-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

document.getElementById('btn-new-conv').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send('/new');
    document.getElementById('messages').innerHTML = '';
    addSystemMsg('🆕 新的对话开始了...');
    setTimeout(loadConvList, 500);
  }
});

document.getElementById('btn-refresh-conv').addEventListener('click', loadConvList);

document.getElementById('btn-mcp-info').addEventListener('click', async () => {
  try {
    const res = await fetch('/mcp', { method: 'GET' });
    const data = await res.json();
    const overlay = document.getElementById('mcp-overlay');
    const content = document.getElementById('mcp-content');
    content.innerHTML = `
      <div style="margin-bottom:12px"><b>服务器:</b> ${data.server} v${data.version}</div>
      <div style="margin-bottom:12px"><b>协议:</b> ${data.protocol}</div>
      <div><b>端点:</b></div>
      <ul style="margin:4px 0 12px 20px">
        ${data.endpoints.map(e => `<li><code style="color:var(--accent-light)">${e}</code></li>`).join('')}
      </ul>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--text-dim)">
        完整的 Anthropic MCP 协议实现。支持 Tools (13), Resources (4), ResourceTemplates (2), Prompts (3)。
      </div>
    `;
    overlay.classList.remove('hidden');
  } catch (e) {
    addSystemMsg('⚠️ 无法获取 MCP 信息');
  }
});

// --- Conversation List ---
async function loadConvList() {
  try {
    const res = await fetch('/v1/models'); // just check health
    const convs = await fetch(`/health`).then(r => r.json());
    // Actually fetch from MCP
    const mcpRes = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'resources/read',
        params: { uri: 'noelle://conversations' }
      })
    });
    const mcpData = await mcpRes.json();
    const container = document.getElementById('conv-list');
    const convs_data = mcpData.result?.contents?.[0]?.text
      ? JSON.parse(mcpData.result.contents[0].text)
      : [];

    if (!convs_data || convs_data.length === 0) {
      container.innerHTML = '<div class="conv-empty">暂无对话</div>';
      return;
    }

    container.innerHTML = convs_data.map(c => {
      const isActive = c.id === 'default' || false;
      return `<div class="conv-item${isActive ? ' active' : ''}" data-conv-id="${c.id}">${c.name || c.id}</div>`;
    }).join('');

    container.querySelectorAll('.conv-item').forEach(el => {
      el.addEventListener('click', () => {
        const convId = el.dataset.convId;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(`/conv ${convId}`);
          document.getElementById('messages').innerHTML = '';
          addSystemMsg(`🔄 切换到对话: ${convId}`);
          container.querySelectorAll('.conv-item').forEach(i => i.classList.remove('active'));
          el.classList.add('active');
        }
      });
    });

  } catch (e) {
    // Silently fail, conv list is optional
  }
}

// --- MCP Overlay close ---
document.addEventListener('click', (e) => {
  const overlay = document.getElementById('mcp-overlay');
  if (e.target === overlay) overlay.classList.add('hidden');
});

// --- Thinking overlay ---
let thinkingTimeout = null;

// --- Utils ---
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function scrollBottom() {
  const el = document.getElementById('messages');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// --- Init ---
function init() {
  // Try to connect on page load
  setTimeout(connectWS, 500);

  // Load model info from API
  fetch(`/v1/models`)
    .then(r => r.json())
    .then(data => {
      if (data.data && data.data[0]) {
        document.getElementById('model-info').textContent = `模型: ${data.data[0].id}`;
      }
    })
    .catch(() => {});

  addSystemMsg('🐱 诺艾尔正在等待你的到来...');
  addSystemMsg('💡 发送消息开始对话吧');

  // Load conversation list
  setTimeout(loadConvList, 1500);
}

document.addEventListener('click', (e) => {
  const overlay = document.getElementById('thinking-overlay');
  if (e.target === overlay) overlay.classList.add('hidden');
});

init();
