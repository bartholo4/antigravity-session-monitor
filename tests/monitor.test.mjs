import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SIDECAR_DIR = join(REPO_ROOT, 'sidecars', 'monitor_pane');

const MOCK_SIDECAR_SDK = `
import http from 'node:http';

export class Response {
  constructor(body, { status = 200, contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.contentType = contentType;
    this.headers = headers;
  }
}

export class SidecarApp {
  constructor() {
    this.config = { conversationId: process.env.MOCK_DEFAULT_CONV_ID || '' };
    this.routes = new Map();
  }
  page(path, handler) {
    this.routes.set('GET ' + path, async (q) => new Response(await handler(q), { contentType: 'text/html; charset=utf-8' }));
  }
  api(path, handler, method = 'GET') {
    this.routes.set(method.toUpperCase() + ' ' + path, handler);
  }
  async run() {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const key = (req.method || 'GET').toUpperCase() + ' ' + u.pathname;
        const handler = this.routes.get(key);
        if (!handler) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const query = Object.fromEntries(u.searchParams.entries());
        const out = await handler(query);
        if (out instanceof Response) {
          res.writeHead(out.status, { 'Content-Type': out.contentType, ...out.headers });
          res.end(out.body);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(err?.stack || err));
      }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const addr = server.address();
    process.stdout.write('MOCK_READY ' + addr.port + '\\n');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  }
}
`;

function startMockSidecar(execDataDir, defaultConvId = '') {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [join(SIDECAR_DIR, 'main.mjs')], {
      cwd: SIDECAR_DIR,
      env: {
        ...process.env,
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: execDataDir,
        MOCK_DEFAULT_CONV_ID: defaultConvId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectStart(new Error(`Timed out waiting for sidecar. stderr=${stderrBuf}`));
    }, 8000);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      const m = /MOCK_READY\s+(\d+)/.exec(stdoutBuf);
      if (m) {
        clearTimeout(timer);
        resolveStart({ child, port: Number(m[1]) });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new Error(`Sidecar exited early with code ${code}. stderr=${stderrBuf}`));
    });
  });
}

test('manifests and static assets are valid', async () => {
  const pluginJson = JSON.parse(await readFile(join(REPO_ROOT, 'plugin.json'), 'utf-8'));
  assert.equal(pluginJson.name, 'session-monitor');
  assert.equal(typeof pluginJson.version, 'string');
  assert.equal(typeof pluginJson.description, 'string');
  assert.ok(Array.isArray(pluginJson.suggestedPrompts) && pluginJson.suggestedPrompts.length <= 3);

  const logoSvg = await readFile(join(REPO_ROOT, pluginJson.logo), 'utf-8');
  assert.match(logoSvg, /<svg[\s>]/);

  const sidecarJson = JSON.parse(await readFile(join(SIDECAR_DIR, 'sidecar.json'), 'utf-8'));
  assert.equal(sidecarJson.command, 'node');
  assert.deepEqual(sidecarJson.args, ['main.mjs']);
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config?.views?.[0]?.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  const pkgJson = JSON.parse(await readFile(join(SIDECAR_DIR, 'package.json'), 'utf-8'));
  assert.equal(pkgJson.type, 'module');
});

test('JavaScript files pass Node syntax check', () => {
  execFileSync(process.execPath, ['--check', join(SIDECAR_DIR, 'main.mjs')], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', join(SIDECAR_DIR, 'app.js')], { stdio: 'pipe' });
});

test('end-to-end metrics, recent list, incremental append, and fs.watch long-poll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-session-monitor-test-'));
  const execDataDir = join(root, 'sidecar_data', 'session-monitor', 'monitor_pane');
  const sdkDir = join(root, 'lib', 'node_modules', 'sidecar_sdk');
  const convId = '11111111-2222-3333-4444-555555555555';
  const logsDir = join(root, 'brain', convId, '.system_generated', 'logs');
  const transcriptFile = join(logsDir, 'transcript.jsonl');

  await mkdir(execDataDir, { recursive: true });
  await mkdir(sdkDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(sdkDir, 'index.mjs'), MOCK_SIDECAR_SDK, 'utf-8');

  const lines = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-19T10:00:00.000Z',
      content: '<USER_REQUEST>\nVerify telemetry metrics\n</USER_REQUEST>\n`Model Selection` from None to Gemini 4 Pro (High).',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:01.000Z',
      input_tokens: 30000,
      cache_read_tokens: 0,
      output_tokens: 400,
      tool_calls: [{ name: 'read_file', args: { toolSummary: 'Read config' } }],
    },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:05.000Z',
      input_tokens: 4000,
      cache_read_tokens: 36000,
      output_tokens: 600,
      tool_calls: [],
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:11.000Z',
      input_tokens: 2000,
      cache_read_tokens: 18000,
      output_tokens: 300,
      tool_calls: [],
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:14.000Z',
      input_tokens: 22000,
      cache_read_tokens: 0,
      output_tokens: 500,
      tool_calls: [],
    },
    {
      step_index: 5,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-19T10:00:19.000Z',
      content: 'step closed marker',
    },
  ];
  await writeFile(transcriptFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf-8');

  let proc;
  try {
    const started = await startMockSidecar(execDataDir, convId);
    proc = started.child;
    const base = `http://127.0.0.1:${started.port}`;

    // 1. Static endpoints
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /会话状态监控/);

    const cssRes = await fetch(`${base}/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(await cssRes.text(), /progress-ring/);

    const jsRes = await fetch(`${base}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(await jsRes.text(), /fetchMetrics/);

    // 2. Recent list endpoint
    const recentRes = await (await fetch(`${base}/api/recent`)).json();
    assert.equal(recentRes.ok, true);
    assert.equal(recentRes.recent.length, 1);
    assert.equal(recentRes.recent[0].id, convId);
    assert.equal(recentRes.recent[0].title, 'Verify telemetry metrics');
    assert.equal(recentRes.recent[0].contextTokens, 22000);

    // 3. Initial metrics snapshot
    const m1 = await (await fetch(`${base}/api/metrics?conversationId=${convId}`)).json();
    assert.equal(m1.ok, true);
    assert.equal(m1.longPoll, true);
    assert.equal(m1.model, 'Gemini 4 Pro (High)');
    assert.equal(m1.summary.plannerSteps, 4);
    assert.equal(m1.summary.userTurns, 1);
    assert.equal(m1.summary.toolCalls, 1);
    assert.equal(m1.summary.compactions, 1);
    assert.equal(m1.summary.cacheResets, 1);
    assert.equal(m1.summary.peakContextTokens, 40000);
    assert.equal(m1.current.contextTokens, 22000);
    assert.equal(m1.current.tps, 100); // 500 output / 5s
    assert.equal(m1.summary.avgTps, 100); // (400+600+300+500)/(4+6+3+5) = 1800/18 = 100

    // 4. Incremental append + fs.watch long-poll wake-up
    const t0 = Date.now();
    const lpPromise = fetch(
      `${base}/api/metrics?conversationId=${convId}&etag=${encodeURIComponent(m1.etag)}&waitMs=5000`,
    ).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 150));
    const nextStep = {
      step_index: 6,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:21.000Z',
      input_tokens: 2000,
      cache_read_tokens: 23000,
      output_tokens: 240,
      tool_calls: [],
    };
    const nextClose = {
      step_index: 7,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-19T10:00:23.000Z',
      content: 'closed',
    };
    await appendFile(transcriptFile, `${JSON.stringify(nextStep)}\n${JSON.stringify(nextClose)}\n`, 'utf-8');

    const m2 = await lpPromise;
    const elapsed = Date.now() - t0;
    assert.equal(m2.ok, true);
    assert.notEqual(m2.unchanged, true);
    assert.equal(m2.summary.plannerSteps, 5);
    assert.equal(m2.current.contextTokens, 25000);
    assert.equal(m2.current.hitRate, 92); // 23000 / 25000 = 92.0%
    assert.equal(m2.current.tps, 120); // 240 / 2s = 120
    assert.equal(m2.summary.peakTps, 120);
    assert.ok(elapsed < 4000, `Expected fs.watch wake-up well before 5000ms timeout, got ${elapsed}ms`);
  } finally {
    if (proc) {
      proc.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
    await rm(root, { recursive: true, force: true });
  }
});
