const net = require('net');
const { execSync } = require('child_process');

function checkPortOpen(host, port, timeout = 10000) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
    s.connect(port, host);
  });
}

function killPortProcess(port) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 5000 });
      const lines = result.split('\n').filter(l => l.includes('LISTENING'));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(parseInt(pid))) {
          try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) { }
        }
      }
    } else {
      try {
        const pid = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
        if (pid) pid.split('\n').forEach(p => { try { process.kill(parseInt(p), 'SIGKILL'); } catch (e) { } });
      } catch (e) { }
    }
  } catch (e) { }
}

async function ensurePortAvailable(host, port, autoKill = true) {
  const busy = await checkPortOpen(host, port);
  if (!busy) return true;
  if (autoKill) {
    killPortProcess(port);
    await new Promise(r => setTimeout(r, 500));
    if (!await checkPortOpen(host, port)) return true;
  }
  console.error(`端口 ${port} 被占用`);
  return false;
}

module.exports = { checkPortOpen, killPortProcess, ensurePortAvailable };
