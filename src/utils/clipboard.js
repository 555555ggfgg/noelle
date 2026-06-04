const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function readClipboardText() {
  try {
    if (process.platform === 'win32') {
      return execSync('powershell -command "[System.Windows.Forms.Clipboard]::GetText()"', {
        timeout: 5000, encoding: 'utf8'
      }).trim();
    } else if (process.platform === 'darwin') {
      return execSync('pbpaste', { timeout: 5000, encoding: 'utf8' }).trim();
    } else {
      return execSync('xclip -selection clipboard -o 2>/dev/null', { timeout: 5000, encoding: 'utf8' }).trim();
    }
  } catch (e) {
    return "";
  }
}

async function getClipboardImage() {
  try {
    const clipboard = readClipboardText();
    if (clipboard && fs.existsSync(clipboard) && /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(clipboard)) {
      return { type: "file", path: clipboard };
    }

    const tempPath = path.join(os.tmpdir(), `clipboard_${Date.now()}.png`);

    if (process.platform === 'win32') {
      execSync(
        `powershell -command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { [System.Windows.Forms.Clipboard]::GetImage().Save('${tempPath}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
        { timeout: 10000 }
      );
      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        return { type: "file", path: tempPath };
      }
    } else if (process.platform === 'darwin') {
      try {
        execSync(`pngpaste "${tempPath}" 2>/dev/null`, { timeout: 5000 });
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          return { type: "file", path: tempPath };
        }
      } catch (e) { }
    } else if (process.platform === 'linux') {
      try {
        execSync(`xclip -selection clipboard -t image/png -o > "${tempPath}" 2>/dev/null`, { timeout: 5000 });
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          return { type: "file", path: tempPath };
        }
      } catch (e) { }
    }

    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { getClipboardImage };
