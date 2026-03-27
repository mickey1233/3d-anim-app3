import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WsGatewayV2 } from './wsGateway.js';
import { routeAndExecute } from './router/router.js';

const port = Number(process.env.V2_WS_PORT || 3112);
const host = process.env.V2_WS_HOST || '127.0.0.1';

// ── Codex startup check ───────────────────────────────────────────────────────
const routerProvider = (process.env.ROUTER_PROVIDER || 'agent').toLowerCase();
if (routerProvider === 'codex' || routerProvider === 'openai') {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  let loggedIn = false;
  let authMode = 'none';
  try {
    const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    authMode = String(data?.auth_mode || 'unknown');
    loggedIn = authMode === 'chatgpt' ? !!(data?.tokens) : !!(data?.OPENAI_API_KEY || data?.tokens);
  } catch { /* file missing */ }

  if (loggedIn) {
    console.log(`[Codex] ✓ Auth ready (mode=${authMode}) — ${authFile}`);
  } else {
    console.warn('[Codex] ✗ Not logged in! Run:  codex login');
    console.warn('[Codex]   Falling back to agent provider until login is complete.');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── USD upload + conversion ───────────────────────────────────────────────────
const CONVERTED_DIR = path.join(os.tmpdir(), 'usd-converted');
fs.mkdirSync(CONVERTED_DIR, { recursive: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USD_CONVERT_SCRIPT = path.join(__dirname, '..', 'usd_to_usdz.py');
const USD_TO_GLB_SCRIPT = path.join(__dirname, '..', 'usd_to_glb.py');

function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  // CORS — the frontend (localhost:5173) needs to reach localhost:3011
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${host}:${port}`);

  // POST /upload/convert-usd?name=<filename>
  if (req.method === 'POST' && url.pathname === '/upload/convert-usd') {
    const fileName = url.searchParams.get('name') || 'upload.usd';
    const ext = path.extname(fileName).toLowerCase();

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const uuid = randomUUID();
      const srcPath = path.join(CONVERTED_DIR, `${uuid}${ext}`);
      const dstPath = path.join(CONVERTED_DIR, `${uuid}.usdz`);

      try {
        fs.writeFileSync(srcPath, body);

        if (ext === '.usdz') {
          // Already the right format — copy as-is
          fs.copyFileSync(srcPath, dstPath);
        } else {
          // .usd (binary Crate) or .usda (text) — convert via pxr
          const result = spawnSync('python3', [USD_CONVERT_SCRIPT, srcPath, dstPath], {
            timeout: 60_000,
          });
          // Treat as failure only if the output file was NOT produced.
          // pxr often emits MDL/texture warnings (non-zero exit) but still writes a valid USDZ.
          const outputExists = fs.existsSync(dstPath) && fs.statSync(dstPath).size > 0;
          if (!outputExists) {
            const stderr = result.stderr?.toString() || 'Conversion failed — no output produced';
            console.error('[USD convert] error:', stderr);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: stderr }));
            return;
          }
          if (result.status !== 0) {
            console.warn('[USD convert] warnings (output ok):', result.stderr?.toString());
          }
        }

        const outName = path.basename(fileName, ext) + '.usdz';
        const publicHost = host === '127.0.0.1' ? 'localhost' : host;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: `http://${publicHost}:${port}/converted/${uuid}.usdz`,
          fileName: outName,
        }));
      } catch (err: any) {
        console.error('[USD convert] exception:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
    });
    req.on('error', (err) => {
      console.error('[USD upload] request error:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // GET /default-usd-path — return DEFAULT_USD_PATH from .env for auto-fill
  if (req.method === 'GET' && url.pathname === '/default-usd-path') {
    const defaultPath = process.env.DEFAULT_USD_PATH || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: defaultPath }));
    return;
  }

  // POST /convert-usd-path — USD → GLB via usd2gltf (preserves PBR materials, ~50MB output)
  if (req.method === 'POST' && url.pathname === '/convert-usd-path') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { path: srcPath } = JSON.parse(body) as { path: string };
        if (!srcPath || !fs.existsSync(srcPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `File not found: ${srcPath}` }));
          return;
        }
        const ext = path.extname(srcPath).toLowerCase();
        const outName = path.basename(srcPath, ext) + '.glb';

        // Save to same directory as source USD (permanent copy)
        const savedPath = path.join(path.dirname(srcPath), outName);

        // If a saved copy already exists, serve it directly (skip re-conversion)
        if (fs.existsSync(savedPath) && fs.statSync(savedPath).size > 0) {
          console.log(`[USD→GLB] using cached GLB: ${savedPath}`);
        } else {
          const uuid = randomUUID();
          const tmpPath = path.join(CONVERTED_DIR, `${uuid}.glb`);

          console.log(`[USD→GLB] converting ${path.basename(srcPath)} ...`);
          const result = spawnSync('python3', [USD_TO_GLB_SCRIPT, srcPath, tmpPath], {
            timeout: 180_000,
          });
          const outputExists = fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0;
          if (!outputExists) {
            const stderr = result.stderr?.toString() || 'Conversion failed';
            console.error('[USD→GLB] error:', stderr);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: stderr }));
            return;
          }
          // Move to permanent saved location
          fs.copyFileSync(tmpPath, savedPath);
          fs.unlinkSync(tmpPath);
          const sizeMB = (fs.statSync(savedPath).size / 1024 / 1024).toFixed(1);
          console.log(`[USD→GLB] saved → ${savedPath} (${sizeMB}MB)`);
        }

        // Serve from CONVERTED_DIR under a stable uuid for this session
        const serveUuid = randomUUID();
        const servePath = path.join(CONVERTED_DIR, `${serveUuid}.glb`);
        fs.copyFileSync(savedPath, servePath);

        const publicHost = host === '127.0.0.1' ? 'localhost' : host;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: `http://${publicHost}:${port}/converted/${serveUuid}.glb`,
          fileName: outName,
          savedPath,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
    });
    return;
  }

  // GET /converted/<uuid>.glb or <uuid>.usdz
  const convertedMatch = url.pathname.match(/^\/converted\/([a-f0-9-]+\.(glb|usdz))$/);
  if (req.method === 'GET' && convertedMatch) {
    const filePath = path.join(CONVERTED_DIR, convertedMatch[1]);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentType = convertedMatch[2] === 'glb' ? 'model/gltf-binary' : 'model/vnd.usdz+zip';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ── HTTP + WS server ──────────────────────────────────────────────────────────
const httpServer = http.createServer(handleHttp);
const gateway = new WsGatewayV2(httpServer);
gateway.start();

httpServer.listen(port, host, () => {
  console.log(`[MCP v2] WS gateway + HTTP listening on ${host}:${port} (router=${routerProvider})`);
});

if (process.env.ROUTER_WARMUP_ON_BOOT !== '0') {
  setTimeout(() => {
    void routeAndExecute('warmup', {
      parts: [],
      cadFileName: null,
      stepCount: 0,
      currentStepId: null,
      selectionPartId: null,
      interactionMode: 'select',
      toolResults: [],
      iteration: 0,
    }).catch(() => undefined);
  }, 50);
}

// Pre-warm the VLM model so it's loaded in GPU memory before the first mate request.
// Without this, Ollama must evict the LLM model (up to 45 GB) and load the VLM model,
// causing 30–60 s delay on the first VLM call.
if (process.env.VLM_WARMUP_ON_BOOT !== '0') {
  const vlmModel = process.env.VLM_MATE_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:27b';
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  setTimeout(() => {
    fetch(`${ollamaBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: vlmModel, prompt: '', keep_alive: '10m', options: { num_ctx: 8192 } }),
      signal: AbortSignal.timeout(60_000),
    })
      .then((r) => r.json())
      .then(() => console.log(`[MCP v2] VLM warmup: ${vlmModel} loaded`))
      .catch((e) => console.warn(`[MCP v2] VLM warmup failed: ${e?.message}`));
  }, 2000);
}
