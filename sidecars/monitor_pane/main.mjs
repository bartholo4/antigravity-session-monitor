/**
 * Session Monitor Sidecar Backend (DSH-style realtime telemetry panel).
 *
 * Strictly read-only: incrementally parses <appData>/brain/<convId>/.system_generated/logs/transcript.jsonl
 * via byte-offset tail reads + fs.watch long-polling to compute live Context Window %,
 * Prefix Cache Hit Rate, and Effective Tokens/sec (tok/s) with minimal CPU & disk I/O.
 */
import { existsSync, watch } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

const MAX_PARSE_CACHE = 48;
const MAX_SUMMARY_CACHE = 80;
const MAX_STORED_STEPS = 48; // Keep slightly more than the 40 displayed steps
const RECENT_LIST_TTL_MS = 15_000;
const WORKING_TIMEOUT_MS = 10 * 60 * 1000;
const STAT_BATCH_SIZE = 32;
const HEAD_READ_BYTES = 16 * 1024;
const TAIL_READ_BYTES = 32 * 1024;
const TAIL_FALLBACK_BYTES = 128 * 1024;

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const candidates = [];
    const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '';
    if (execDataDir) {
      for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
        if (basename(d) === 'sidecar_data') {
          candidates.push(join(dirname(d), 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
          break;
        }
      }
    }
    candidates.push(join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return await import(pathToFileURL(candidate).href);
      }
    }
    throw new Error('Unable to locate sidecar_sdk');
  }
}

let cachedBrainDir = '';
function getBrainDir() {
  if (cachedBrainDir) return cachedBrainDir;
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '';
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const brain = join(dirname(d), 'brain');
        if (existsSync(brain)) {
          cachedBrainDir = brain;
          return cachedBrainDir;
        }
      }
    }
  }
  const fallback = join(homedir(), '.gemini', 'antigravity', 'brain');
  if (existsSync(fallback)) {
    cachedBrainDir = fallback;
    return cachedBrainDir;
  }
  return '';
}

function transcriptPath(brainDir, convId) {
  return join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function extractUserRequestTitle(content) {
  if (typeof content !== 'string') return '';
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = (m ? m[1] : content).trim();
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) || '';
  return firstLine.trim().slice(0, 56);
}

function extractModelSelection(content) {
  if (typeof content !== 'string' || !content.includes('Model Selection')) return '';
  const m = /Model Selection`\s+from\s+.*?\s+to\s+([^.\r\n<]+)/i.exec(content);
  return m ? m[1].trim() : '';
}

function parseToolSummary(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return { count: 0, label: '直接回复' };
  const counts = new Map();
  for (const tc of toolCalls) {
    const rawSummary = tc?.args?.toolSummary;
    let cleanSummary = '';
    if (typeof rawSummary === 'string') {
      cleanSummary = rawSummary.replace(/^"+|"+$/g, '').trim();
    }
    const name = cleanSummary || tc?.name || 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const parts = [];
  let idx = 0;
  for (const [k, v] of counts.entries()) {
    if (idx < 2) parts.push(v > 1 ? `${k} ×${v}` : k);
    idx++;
  }
  if (counts.size > 2) parts.push(`+${counts.size - 2}`);
  return { count: toolCalls.length, label: parts.join(' · ') };
}

function computeStatus(lastRawType, lastRawStatus, lastRawHasTools, lastRawToolLabel, mtimeMs) {
  let status = 'idle';
  let statusDetail = '就绪';
  if (!lastRawType && !lastRawStatus) return { status, statusDetail };

  const ageMs = Date.now() - mtimeMs;
  if (lastRawStatus === 'ERROR' || lastRawType === 'ERROR_MESSAGE') {
    status = 'error';
    statusDetail = '最近一步异常';
  } else if (ageMs < WORKING_TIMEOUT_MS) {
    if (
      lastRawType === 'USER_INPUT' ||
      lastRawType === 'GENERIC' ||
      lastRawType === 'EPHEMERAL_MESSAGE'
    ) {
      status = 'working';
      statusDetail = '模型推理中…';
    } else if (lastRawType === 'PLANNER_RESPONSE' && lastRawHasTools) {
      status = 'working';
      statusDetail = `工具执行中 · ${lastRawToolLabel || '工具'}`;
    }
  }
  return { status, statusDetail };
}

// ── True LRU Cache Helper ──
function lruGet(map, key) {
  const val = map.get(key);
  if (val !== undefined) {
    map.delete(key);
    map.set(key, val);
  }
  return val;
}

function lruSet(map, key, val, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

// ── Incremental Transcript Parser ──
const parseCache = new Map(); // filePath -> IncrementalEntry

function createIncrementalEntry(convId) {
  return {
    convId,
    byteOffset: 0,
    size: 0,
    mtimeMs: 0,
    rawStepCount: 0,
    title: '',
    model: '',
    userTurns: 0,
    totalToolCalls: 0,
    subagentCalls: 0,

    prevContext: 0,
    compactions: 0,
    cacheResets: 0,

    sumUncached: 0,
    sumCacheRead: 0,
    sumOutput: 0,
    warmUncached: 0,
    warmCacheRead: 0,

    closedMeasurableOutput: 0,
    closedMeasurableDurSec: 0,
    closedPeakTps: 0,
    peakContextTokens: 0,

    plannerStepCount: 0,
    plannerSteps: [], // Rolling window (last MAX_STORED_STEPS)
    pendingPlanner: null, // { stepRef, startMs, outputTokens, rawIndex, expectedTools, seenTools, lastToolMs, observedEndMs }

    lastRawType: '',
    lastRawStatus: '',
    lastRawHasTools: false,
    lastRawToolLabel: '',
  };
}

function calcDurationAndTps(startMs, endMs, outputTokens) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { durationSec: null, tps: null, measurable: false };
  }
  const diffMs = endMs - startMs;
  if (diffMs < -500 || diffMs > 600_000) {
    return { durationSec: null, tps: null, measurable: false };
  }
  const durationSec = Math.max(0.5, diffMs / 1000);
  if (outputTokens > 0) {
    const tps = outputTokens / durationSec;
    if (tps > 0 && tps < 2000) {
      return { durationSec, tps, measurable: true };
    }
  }
  return { durationSec, tps: null, measurable: false };
}

function closePendingPlanner(entry, endMs) {
  const p = entry.pendingPlanner;
  if (!p) return;
  if (Number.isFinite(endMs)) {
    const calc = calcDurationAndTps(p.startMs, endMs, p.outputTokens);
    p.stepRef.durationSec = calc.durationSec !== null ? Number(calc.durationSec.toFixed(1)) : null;
    p.stepRef.tps = calc.tps !== null ? Number(calc.tps.toFixed(1)) : null;
    if (calc.measurable) {
      entry.closedMeasurableOutput += p.outputTokens;
      entry.closedMeasurableDurSec += calc.durationSec;
      if (calc.tps > entry.closedPeakTps) entry.closedPeakTps = calc.tps;
    }
  }
  entry.pendingPlanner = null;
}

function ingestRawStep(entry, s) {
  const rawIdx = entry.rawStepCount++;

  // Close a previously open planner step at its actual generation boundary:
  // - Multi-tool batches stream tool calls sequentially; each GENERIC step's created_at marks
  //   when that tool call finished streaming, so wait for the N-th (last) GENERIC tool step.
  // - Ignore interleaved SYSTEM_MESSAGE / EPHEMERAL_MESSAGE / CHECKPOINT notifications mid-batch.
  // - For direct replies (expectedTools === 0), never measure across USER_INPUT / SYSTEM_MESSAGE
  //   wait time; preserve live mtime-observed completion if available.
  if (entry.pendingPlanner) {
    const p = entry.pendingPlanner;
    const stepType = typeof s?.type === 'string' ? s.type : '';
    const stepMs = typeof s?.created_at === 'string' ? Date.parse(s.created_at) : NaN;

    if (p.expectedTools > 0) {
      if (stepType === 'GENERIC') {
        p.seenTools++;
        if (Number.isFinite(stepMs)) {
          p.lastToolMs = Number.isFinite(p.lastToolMs) ? Math.max(p.lastToolMs, stepMs) : stepMs;
        }
        if (p.seenTools >= p.expectedTools) {
          closePendingPlanner(entry, p.lastToolMs);
        }
      } else if (stepType === 'PLANNER_RESPONSE' || stepType === 'USER_INPUT' || stepType === 'ERROR_MESSAGE') {
        closePendingPlanner(entry, p.lastToolMs);
      }
    } else {
      if (stepType === 'GENERIC') {
        closePendingPlanner(entry, stepMs);
      } else if (
        stepType === 'PLANNER_RESPONSE' ||
        stepType === 'USER_INPUT' ||
        stepType === 'SYSTEM_MESSAGE' ||
        stepType === 'ERROR_MESSAGE'
      ) {
        closePendingPlanner(entry, p.observedEndMs);
      }
    }
  }

  if (s?.type === 'USER_INPUT') {
    entry.userTurns++;
    if (!entry.title) entry.title = extractUserRequestTitle(s.content);
    const m = extractModelSelection(s.content);
    if (m) entry.model = m;
  } else if (typeof s?.content === 'string' && s.content.includes('Model Selection')) {
    const m = extractModelSelection(s.content);
    if (m) entry.model = m;
  }

  entry.lastRawType = typeof s?.type === 'string' ? s.type : '';
  entry.lastRawStatus = typeof s?.status === 'string' ? s.status : '';
  entry.lastRawHasTools = false;
  entry.lastRawToolLabel = '';

  if (s?.type !== 'PLANNER_RESPONSE') return;

  const uncachedInput = Math.max(0, Number(s.input_tokens) || 0);
  const cacheRead = Math.max(0, Number(s.cache_read_tokens) || 0);
  const contextTokens = uncachedInput + cacheRead;
  const outputTokens = Math.max(0, Number(s.output_tokens) || 0);
  const hitRate = contextTokens > 0 ? (cacheRead / contextTokens) * 100 : null;

  const prevCount = entry.plannerStepCount;
  const compacted =
    entry.prevContext > 16_000 &&
    contextTokens > 0 &&
    contextTokens < entry.prevContext * 0.72 &&
    entry.prevContext - contextTokens > 8_000;
  const cacheReset =
    prevCount > 0 &&
    entry.prevContext > 12_000 &&
    cacheRead === 0 &&
    uncachedInput > 10_000 &&
    !compacted;

  if (compacted) entry.compactions++;
  if (cacheReset) entry.cacheResets++;
  if (contextTokens > 0) entry.prevContext = contextTokens;
  if (contextTokens > entry.peakContextTokens) entry.peakContextTokens = contextTokens;

  const toolInfo = parseToolSummary(s.tool_calls);
  entry.totalToolCalls += toolInfo.count;
  if (toolInfo.count > 0) {
    entry.lastRawHasTools = true;
    entry.lastRawToolLabel = toolInfo.label;
    for (const tc of s.tool_calls) {
      if (tc?.name === 'invoke_subagent') entry.subagentCalls++;
    }
  }

  entry.sumUncached += uncachedInput;
  entry.sumCacheRead += cacheRead;
  entry.sumOutput += outputTokens;
  if (prevCount > 0) {
    entry.warmUncached += uncachedInput;
    entry.warmCacheRead += cacheRead;
  }

  entry.plannerStepCount++;
  const stepObj = {
    seq: entry.plannerStepCount,
    stepIndex: s.step_index ?? rawIdx,
    time: s.created_at || null,
    uncachedInput,
    cacheRead,
    contextTokens,
    outputTokens,
    hitRate: hitRate !== null ? Number(hitRate.toFixed(1)) : null,
    durationSec: null,
    tps: null,
    toolCount: toolInfo.count,
    toolLabel: toolInfo.label,
    hasThinking: Boolean(s.thinking),
    compacted,
    cacheReset,
  };

  entry.plannerSteps.push(stepObj);
  if (entry.plannerSteps.length > MAX_STORED_STEPS) {
    entry.plannerSteps.shift();
  }

  const startMs = typeof s.created_at === 'string' ? Date.parse(s.created_at) : NaN;
  entry.pendingPlanner = {
    stepRef: stepObj,
    startMs,
    outputTokens,
    rawIndex: rawIdx,
    expectedTools: toolInfo.count,
    seenTools: 0,
    lastToolMs: NaN,
    observedEndMs: NaN,
  };
}

function buildMetricsSnapshot(entry) {
  const { status, statusDetail } = computeStatus(
    entry.lastRawType,
    entry.lastRawStatus,
    entry.lastRawHasTools,
    entry.lastRawToolLabel,
    entry.mtimeMs,
  );

  // Clone the last 40 steps only if provisional tail step needs mtime-derived tps/durationSec.
  let stepsOut = entry.plannerSteps.slice(-40);
  let sumMeasurableOutput = entry.closedMeasurableOutput;
  let sumMeasurableDurSec = entry.closedMeasurableDurSec;
  let peakTps = entry.closedPeakTps;

  const p = entry.pendingPlanner;
  if (p && p.rawIndex === entry.rawStepCount - 1) {
    const endMs = Number.isFinite(p.observedEndMs) ? p.observedEndMs : entry.mtimeMs;
    const calc = calcDurationAndTps(p.startMs, endMs, p.outputTokens);
    const provisionalDur = calc.durationSec !== null ? Number(calc.durationSec.toFixed(1)) : null;
    const provisionalTps = calc.tps !== null ? Number(calc.tps.toFixed(1)) : null;
    if (stepsOut.length > 0 && stepsOut[stepsOut.length - 1] === p.stepRef) {
      stepsOut = [...stepsOut.slice(0, -1), { ...p.stepRef, durationSec: provisionalDur, tps: provisionalTps }];
    }
    if (calc.measurable) {
      sumMeasurableOutput += p.outputTokens;
      sumMeasurableDurSec += calc.durationSec;
      if (calc.tps > peakTps) peakTps = calc.tps;
    }
  }

  const latest = stepsOut[stepsOut.length - 1] || null;
  const prev = stepsOut[stepsOut.length - 2] || null;
  const totalInputAll = entry.sumUncached + entry.sumCacheRead;
  const warmInputAll = entry.warmUncached + entry.warmCacheRead;
  const cumulativeHitRate =
    totalInputAll > 0 ? Number(((entry.sumCacheRead / totalInputAll) * 100).toFixed(1)) : null;
  const warmHitRate =
    warmInputAll > 0 ? Number(((entry.warmCacheRead / warmInputAll) * 100).toFixed(1)) : null;
  const avgTps =
    sumMeasurableDurSec > 0 ? Number((sumMeasurableOutput / sumMeasurableDurSec).toFixed(1)) : null;

  const mtimeRounded = Math.round(entry.mtimeMs);
  return {
    conversationId: entry.convId,
    title: entry.title || `会话 ${entry.convId.slice(0, 8)}`,
    model: entry.model || 'Gemini (默认模型)',
    updatedAt: mtimeRounded,
    etagKey: `${entry.convId}:${entry.size}:${mtimeRounded}:${status}`,
    status,
    statusDetail,
    current: latest
      ? {
          contextTokens: latest.contextTokens,
          contextDelta: prev ? latest.contextTokens - prev.contextTokens : latest.contextTokens,
          uncachedInput: latest.uncachedInput,
          cacheRead: latest.cacheRead,
          outputTokens: latest.outputTokens,
          hitRate: latest.hitRate,
          tps: latest.tps,
          durationSec: latest.durationSec,
          seq: latest.seq,
          time: latest.time,
          toolLabel: latest.toolLabel,
        }
      : null,
    summary: {
      peakContextTokens: entry.peakContextTokens,
      cumulativeHitRate,
      warmHitRate,
      avgTps,
      peakTps: peakTps > 0 ? Number(peakTps.toFixed(1)) : null,
      totalUncachedInput: entry.sumUncached,
      totalCacheRead: entry.sumCacheRead,
      totalInput: totalInputAll,
      totalOutput: entry.sumOutput,
      plannerSteps: entry.plannerStepCount,
      userTurns: entry.userTurns,
      toolCalls: entry.totalToolCalls,
      subagentCalls: entry.subagentCalls,
      compactions: entry.compactions,
      cacheResets: entry.cacheResets,
    },
    steps: stepsOut,
  };
}

async function parseTranscriptIncremental(brainDir, convId) {
  const filePath = transcriptPath(brainDir, convId);
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }

  let entry = lruGet(parseCache, filePath);

  // If truncated or rewritten smaller than our consumed offset, start clean.
  if (!entry || st.size < entry.byteOffset) {
    entry = createIncrementalEntry(convId);
    lruSet(parseCache, filePath, entry, MAX_PARSE_CACHE);
  }

  // Fast path: file unchanged (size + mtimeMs identical) -> zero disk reads!
  if (entry.size === st.size && entry.mtimeMs === st.mtimeMs && entry.byteOffset > 0) {
    return buildMetricsSnapshot(entry);
  }

  // Incremental delta read: only read newly appended bytes [byteOffset, st.size).
  const deltaLen = st.size - entry.byteOffset;
  if (deltaLen > 0) {
    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.allocUnsafe(deltaLen);
      let totalRead = 0;
      while (totalRead < deltaLen) {
        const { bytesRead } = await fh.read(buf, totalRead, deltaLen - totalRead, entry.byteOffset + totalRead);
        if (bytesRead <= 0) break;
        totalRead += bytesRead;
      }

      if (totalRead > 0) {
        const slice = buf.subarray(0, totalRead);
        const lastNl = slice.lastIndexOf(0x0a);

        // Consume all newline-terminated complete lines first.
        if (lastNl >= 0) {
          const text = slice.subarray(0, lastNl + 1).toString('utf-8');
          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            try {
              ingestRawStep(entry, JSON.parse(line));
            } catch {
              // Skip malformed line if any.
            }
          }
          entry.byteOffset += lastNl + 1;
        }

        // Check if there is a complete JSON object after the last newline (file without trailing \n).
        const remStart = lastNl >= 0 ? lastNl + 1 : 0;
        if (remStart < totalRead) {
          const remText = slice.subarray(remStart).toString('utf-8').trim();
          if (remText) {
            try {
              const obj = JSON.parse(remText);
              ingestRawStep(entry, obj);
              entry.byteOffset += totalRead - remStart;
            } catch {
              // Partial mid-flush line: leave byteOffset at lastNl + 1 so next read picks it up cleanly.
            }
          } else {
            entry.byteOffset += totalRead - remStart;
          }
        }
      }
    } catch {
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  entry.size = st.size;
  entry.mtimeMs = st.mtimeMs;
  if (
    entry.pendingPlanner &&
    entry.pendingPlanner.expectedTools === 0 &&
    entry.pendingPlanner.rawIndex === entry.rawStepCount - 1 &&
    !Number.isFinite(entry.pendingPlanner.observedEndMs)
  ) {
    entry.pendingPlanner.observedEndMs = st.mtimeMs;
  }
  lruSet(parseCache, filePath, entry, MAX_PARSE_CACHE);
  return buildMetricsSnapshot(entry);
}

// ── Lightweight Summary Reader for Recent Dropdown (Head + Tail Read Only) ──
const summaryCache = new Map(); // filePath -> { size, mtimeMs, title, contextTokens, lastRawType, lastRawStatus, lastRawHasTools, lastRawToolLabel }

async function readRange(fh, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fh.read(buf, offset, length - offset, start + offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return buf.subarray(0, offset);
}

async function readLightweightSummary(brainDir, convId, st) {
  const filePath = transcriptPath(brainDir, convId);

  // 1. Reuse hot parseCache if already up-to-date (0 bytes I/O).
  const fullEntry = parseCache.get(filePath);
  if (fullEntry && fullEntry.size === st.size && fullEntry.mtimeMs === st.mtimeMs && fullEntry.byteOffset > 0) {
    const { status } = computeStatus(
      fullEntry.lastRawType,
      fullEntry.lastRawStatus,
      fullEntry.lastRawHasTools,
      fullEntry.lastRawToolLabel,
      st.mtimeMs,
    );
    const latest = fullEntry.plannerSteps[fullEntry.plannerSteps.length - 1];
    return {
      id: convId,
      title: fullEntry.title || `会话 ${convId.slice(0, 8)}`,
      updatedAt: Math.round(st.mtimeMs),
      contextTokens: latest?.contextTokens ?? 0,
      status,
    };
  }

  // 2. Reuse summaryCache if unchanged (0 bytes I/O).
  const prev = lruGet(summaryCache, filePath);
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    const { status } = computeStatus(
      prev.lastRawType,
      prev.lastRawStatus,
      prev.lastRawHasTools,
      prev.lastRawToolLabel,
      st.mtimeMs,
    );
    return {
      id: convId,
      title: prev.title || `会话 ${convId.slice(0, 8)}`,
      updatedAt: Math.round(st.mtimeMs),
      contextTokens: prev.contextTokens,
      status,
    };
  }

  // 3. Minimal Head (for title, only if unknown) + Tail (for latest contextTokens & status) read.
  let title = prev?.title || '';
  let contextTokens = prev?.contextTokens || 0;
  let lastRawType = '';
  let lastRawStatus = '';
  let lastRawHasTools = false;
  let lastRawToolLabel = '';

  let fh;
  try {
    fh = await open(filePath, 'r');

    if (!title) {
      const headLen = Math.min(st.size, HEAD_READ_BYTES);
      const headBuf = await readRange(fh, 0, headLen);
      const headLines = headBuf.toString('utf-8').split(/\r?\n/);
      for (const line of headLines) {
        if (!line || !line.includes('"USER_INPUT"')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === 'USER_INPUT') {
            const t = extractUserRequestTitle(obj.content);
            if (t) {
              title = t;
              break;
            }
          }
        } catch {
          // Last line in head chunk may be cut mid-line; ignore.
        }
      }
    }

    // Read tail chunk to find last step & latest PLANNER_RESPONSE context size.
    const tryTail = async (bytes) => {
      const len = Math.min(st.size, bytes);
      const start = st.size - len;
      const tailBuf = await readRange(fh, start, len);
      const text = tailBuf.toString('utf-8');
      const lines = text.split(/\r?\n/);
      // If we started mid-file, drop the potentially truncated first line.
      const startIdx = start > 0 ? 1 : 0;
      let foundLast = false;
      let foundPlanner = false;
      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i];
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!foundLast) {
          foundLast = true;
          lastRawType = typeof obj?.type === 'string' ? obj.type : '';
          lastRawStatus = typeof obj?.status === 'string' ? obj.status : '';
          if (obj?.type === 'PLANNER_RESPONSE' && Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            lastRawHasTools = true;
            lastRawToolLabel = parseToolSummary(obj.tool_calls).label;
          }
        }
        if (!foundPlanner && obj?.type === 'PLANNER_RESPONSE') {
          const uncached = Math.max(0, Number(obj.input_tokens) || 0);
          const cached = Math.max(0, Number(obj.cache_read_tokens) || 0);
          contextTokens = uncached + cached;
          foundPlanner = true;
        }
        if (foundLast && foundPlanner) break;
      }
      return foundPlanner;
    };

    const gotPlanner = await tryTail(TAIL_READ_BYTES);
    if (!gotPlanner && st.size > TAIL_READ_BYTES) {
      await tryTail(TAIL_FALLBACK_BYTES);
    }
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  lruSet(
    summaryCache,
    filePath,
    {
      size: st.size,
      mtimeMs: st.mtimeMs,
      title,
      contextTokens,
      lastRawType,
      lastRawStatus,
      lastRawHasTools,
      lastRawToolLabel,
    },
    MAX_SUMMARY_CACHE,
  );

  const { status } = computeStatus(lastRawType, lastRawStatus, lastRawHasTools, lastRawToolLabel, st.mtimeMs);
  return {
    id: convId,
    title: title || `会话 ${convId.slice(0, 8)}`,
    updatedAt: Math.round(st.mtimeMs),
    contextTokens,
    status,
  };
}

// ── Recent Conversations Cache + Brain Dir Watcher ──
let recentListCache = { ts: 0, brainDir: '', items: [], inflight: null };
let brainDirWatcher = null;

function ensureBrainDirWatcher(brainDir) {
  if (brainDirWatcher || !brainDir) return;
  try {
    brainDirWatcher = watch(brainDir, () => {
      // Invalidate recent list cache whenever a new conversation directory appears.
      recentListCache.ts = 0;
    });
    brainDirWatcher.on('error', () => {
      try { brainDirWatcher.close(); } catch {}
      brainDirWatcher = null;
    });
  } catch {
    brainDirWatcher = null;
  }
}

async function listRecentConversations(brainDir, { force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    recentListCache.brainDir === brainDir &&
    recentListCache.ts > 0 &&
    now - recentListCache.ts < RECENT_LIST_TTL_MS
  ) {
    return recentListCache.items;
  }
  if (recentListCache.inflight) return recentListCache.inflight;
  if (!brainDir) return [];

  ensureBrainDirWatcher(brainDir);

  recentListCache.inflight = (async () => {
    let entries;
    try {
      entries = await readdir(brainDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirIds = [];
    for (const entry of entries) {
      if (entry.isDirectory() && ID_RE.test(entry.name)) {
        dirIds.push(entry.name);
      }
    }

    const candidates = [];
    for (let i = 0; i < dirIds.length; i += STAT_BATCH_SIZE) {
      const batch = dirIds.slice(i, i + STAT_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const st = await stat(transcriptPath(brainDir, id));
            if (st.size > 0) return { id, st };
          } catch {
            // Ignore dirs without transcript.jsonl
          }
          return null;
        }),
      );
      for (const r of results) {
        if (r) candidates.push(r);
      }
    }

    candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const top12 = candidates.slice(0, 12);
    const items = (
      await Promise.all(top12.map((c) => readLightweightSummary(brainDir, c.id, c.st)))
    ).filter(Boolean);

    recentListCache = { ts: Date.now(), brainDir, items, inflight: null };
    return items;
  })();

  try {
    return await recentListCache.inflight;
  } finally {
    recentListCache.inflight = null;
  }
}

// ── File Watcher Registry for Long-Polling (/api/metrics) ──
const logWatchers = new Map(); // logsDir -> { watcher, listeners: Set<fn>, debounceTimer, idleTimer }

function waitForTranscriptChange(filePath, waitMs) {
  return new Promise((resolve) => {
    const logsDir = dirname(filePath);
    let settled = false;
    let timeoutId = null;

    const finish = (changed) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      const entry = logWatchers.get(logsDir);
      if (entry) {
        entry.listeners.delete(onChange);
        if (entry.listeners.size === 0 && !entry.idleTimer) {
          entry.idleTimer = setTimeout(() => {
            const cur = logWatchers.get(logsDir);
            if (cur && cur.listeners.size === 0) {
              try { cur.watcher.close(); } catch {}
              logWatchers.delete(logsDir);
            }
          }, 30_000);
        }
      }
      resolve(changed);
    };

    const onChange = () => finish(true);

    let entry = logWatchers.get(logsDir);
    if (!entry) {
      try {
        const listeners = new Set();
        const watcher = watch(logsDir, (_eventType, filename) => {
          if (filename && filename !== 'transcript.jsonl') return;
          const cur = logWatchers.get(logsDir);
          if (!cur) return;
          if (cur.debounceTimer) clearTimeout(cur.debounceTimer);
          cur.debounceTimer = setTimeout(() => {
            cur.debounceTimer = null;
            for (const fn of [...cur.listeners]) fn();
          }, 60);
        });
        watcher.on('error', () => {
          const cur = logWatchers.get(logsDir);
          if (cur) {
            for (const fn of [...cur.listeners]) fn();
            try { cur.watcher.close(); } catch {}
            logWatchers.delete(logsDir);
          }
        });
        entry = { watcher, listeners, debounceTimer: null, idleTimer: null };
        logWatchers.set(logsDir, entry);
      } catch {
        // Fallback to simple bounded sleep if logsDir doesn't exist yet.
        timeoutId = setTimeout(() => finish(false), Math.min(waitMs, 1500));
        return;
      }
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.listeners.add(onChange);
    timeoutId = setTimeout(() => finish(false), waitMs);
  });
}

// ── Static Asset Memory Cache (mtimeMs-validated hot reload) ──
const staticCache = new Map();

async function readStaticCached(filename) {
  const fullPath = join(__dirname, filename);
  const st = await stat(fullPath);
  const cached = staticCache.get(filename);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.content;
  }
  const content = await readFile(fullPath, 'utf-8');
  staticCache.set(filename, { mtimeMs: st.mtimeMs, size: st.size, content });
  return content;
}

// ── Sidecar HTTP Server ──
const { SidecarApp, Response } = await loadSidecarSdk();
const app = new SidecarApp();

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

app.page('/', () => readStaticCached('index.html'));

for (const [route, [filename, contentType]] of Object.entries(STATIC_FILES)) {
  app.api(
    route,
    async () =>
      new Response(await readStaticCached(filename), {
        contentType,
        headers: { 'Cache-Control': 'no-store' },
      }),
    'GET',
  );
}

app.api(
  '/api/recent',
  async (query) => {
    const brainDir = getBrainDir();
    if (!brainDir) {
      return { ok: false, error: '未找到 Antigravity 会话日志目录 (brain/)。', recent: [] };
    }
    const force = query.force === '1' || query.force === 'true';
    const recent = await listRecentConversations(brainDir, { force });
    return { ok: true, recent };
  },
  'GET',
);

app.api(
  '/api/metrics',
  async (query) => {
    const brainDir = getBrainDir();
    if (!brainDir) {
      return { ok: false, error: '未找到 Antigravity 会话日志目录 (brain/)。' };
    }

    const requested =
      typeof query.conversationId === 'string' && ID_RE.test(query.conversationId)
        ? query.conversationId
        : '';
    const hostDefault =
      typeof app.config.conversationId === 'string' && ID_RE.test(app.config.conversationId)
        ? app.config.conversationId
        : '';

    let targetId = requested || hostDefault;
    if (!targetId) {
      const recent = await listRecentConversations(brainDir);
      targetId = recent[0]?.id ?? '';
    }
    if (!targetId) {
      return { ok: true, empty: true, longPoll: true };
    }

    let metrics = await parseTranscriptIncremental(brainDir, targetId);
    if (!metrics) {
      return {
        ok: true,
        empty: true,
        conversationId: targetId,
        longPoll: true,
      };
    }

    const clientEtag = typeof query.etag === 'string' ? query.etag : '';
    const waitMsRaw = Number(query.waitMs) || 0;
    const waitMs = Math.max(0, Math.min(12_000, waitMsRaw));

    if (clientEtag && clientEtag === metrics.etagKey && waitMs > 0) {
      await waitForTranscriptChange(transcriptPath(brainDir, targetId), waitMs);
      // Always re-evaluate after wait (fast O(1) stat + dynamic status timeout check; delta-reads only if file grew).
      const refreshed = await parseTranscriptIncremental(brainDir, targetId);
      if (refreshed) metrics = refreshed;
    }

    if (clientEtag && clientEtag === metrics.etagKey) {
      return {
        ok: true,
        unchanged: true,
        etag: metrics.etagKey,
        conversationId: targetId,
        longPoll: true,
      };
    }

    return {
      ok: true,
      etag: metrics.etagKey,
      pinnedConversationId: hostDefault || null,
      longPoll: true,
      ...metrics,
    };
  },
  'GET',
);

await app.run();
