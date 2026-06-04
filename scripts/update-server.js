const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 3456;
const PACKAGES_DIR = path.resolve(process.argv.find(a => a.startsWith('--packages='))?.split('=')[1]) || path.resolve('packages');
const CONFIG_PATH = path.resolve(process.argv.find(a => a.startsWith('--config='))?.split('=')[1]) || path.join(PACKAGES_DIR, 'manifest.json');

if (!fs.existsSync(PACKAGES_DIR)) fs.mkdirSync(PACKAGES_DIR, { recursive: true });

function loadManifest() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`Config load error: ${e.message}`);
  }
  return { latestVersion: '0.0.0', releases: [] };
}

function saveManifest(manifest) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(manifest, null, 2));
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJSON(res, { error: 'Package not found' }, 404);
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  switch (pathname) {
    case '/check': {
      const manifest = loadManifest();
      const release = manifest.releases.find(r => r.version === manifest.latestVersion);
      sendJSON(res, {
        latestVersion: manifest.latestVersion,
        downloadUrl: `http://${req.headers.host}/download/${manifest.latestVersion}`,
        changelog: release?.changelog || '',
        releaseDate: release?.date || '',
        size: release?.size || 0
      });
      break;
    }

    case '/download': {
      const version = parsed.query.v || manifest.latestVersion;
      const filePath = path.join(PACKAGES_DIR, `noelle-${version}.zip`);
      sendFile(res, filePath);
      break;
    }

    case '/manifest': {
      sendJSON(res, loadManifest());
      break;
    }

    default:
      sendJSON(res, { error: 'Not found', endpoints: ['/check', '/download?v=<version>', '/manifest'] }, 404);
  }
});

server.listen(PORT, () => {
  console.log(`Noelle Update Server v1.0`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Packages: ${PACKAGES_DIR}`);
  console.log(`  Manifest: ${CONFIG_PATH}`);
  console.log(`  Endpoints:`);
  console.log(`    GET /check          - Check for latest version`);
  console.log(`    GET /download?v=X.X.X - Download specific version package`);
  console.log(`    GET /manifest       - View full manifest`);
});
