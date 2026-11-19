/*
 * Session Monitor Frontend — DSH-style telemetry & control panel.
 * Optimized with visibility-aware long-polling, decoupled /api/recent fetching,
 * cached DOM references, and granular partial re-rendering.
 */
(() => {
  const POLL_FALLBACK_ACTIVE_MS = 1200;
  const POLL_FALLBACK_IDLE_BASE_MS = 2200;
  const POLL_FALLBACK_IDLE_MAX_MS = 6000;
  const LONG_POLL_ACTIVE_WAIT_MS = 3500;
  const LONG_POLL_IDLE_WAIT_MS = 10000;
  const RECENT_REFRESH_INTERVAL_MS = 25000;
  const RECENT_FOCUS_COOLDOWN_MS = 3000;
  const CAP_STORAGE_KEY = 'agy_session_monitor_cap_v1';

  const $ = (id) => document.getElementById(id);

  // Cache DOM references once to avoid repeated lookups per frame.
  const dom = {
    statusPill: $('status-pill'),
    statusText: $('status-text'),
    modelBadge: $('model-badge'),
    convSelect: $('conv-select'),
    capSelect: $('cap-select'),
    qpCtx: $('qp-ctx'),
    qpCache: $('qp-cache'),
    qpSpeed: $('qp-speed'),
    emptyState: $('empty-state'),
    dashboard: $('dashboard'),
    ctxRing: $('ctx-ring'),
    ctxPctText: $('ctx-pct-text'),
    ctxUsed: $('ctx-used'),
    ctxCap: $('ctx-cap'),
    ctxDelta: $('ctx-delta'),
    compactBadge: $('compact-badge'),
    ctxCompactLine: $('ctx-compact-line'),
    segCache: $('seg-cache'),
    segUncached: $('seg-uncached'),
    segOutput: $('seg-output'),
    legCache: $('leg-cache'),
    legUncached: $('leg-uncached'),
    legOutput: $('leg-output'),
    cacheHitVal: $('cache-hit-val'),
    cacheBar: $('cache-bar'),
    cacheStateBadge: $('cache-state-badge'),
    cacheWarmVal: $('cache-warm-val'),
    cacheCumVal: $('cache-cum-val'),
    cacheTotalRead: $('cache-total-read'),
    cacheMissInfo: $('cache-miss-info'),
    speedBar: $('speed-bar'),
    speedVal: $('speed-val'),
    speedDurBadge: $('speed-dur-badge'),
    speedAvgVal: $('speed-avg-val'),
    speedPeakVal: $('speed-peak-val'),
    totalOutVal: $('total-out-val'),
    turnStepVal: $('turn-step-val'),
    trendSvg: $('trend-svg'),
    chartFoot: $('chart-foot'),
    stepTbody: $('step-tbody'),
    copyCompactBtn: $('copy-compact-btn'),
  };

  // Fallback for browsers where CSS `attr(value type(<number>))` isn't active yet.
  const supportsTypedAttr =
    typeof CSS !== 'undefined' &&
    CSS.supports &&
    CSS.supports('width: attr(value type(<number>))');

  function setRingValue(numVal, valueText) {
    const clamped = Math.max(0, Math.min(100, Number(numVal) || 0));
    const formatted = clamped.toFixed(1);
    dom.ctxRing.setAttribute('value', formatted);
    if (valueText) dom.ctxRing.setAttribute('aria-valuetext', valueText);
    if (!supportsTypedAttr) {
      dom.ctxRing.style.setProperty('--value', formatted);
    }
  }
  if (!supportsTypedAttr && dom.ctxRing) {
    new MutationObserver(() => {
      dom.ctxRing.style.setProperty('--value', dom.ctxRing.getAttribute('value') || '0');
    }).observe(dom.ctxRing, { attributes: true, attributeFilter: ['value'] });
  }

  // Sync host iframe theme variables (--background luminance) onto :root[data-theme].
  function syncHostScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, transparent)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const alpha = nums.length >= 4 ? nums[3] : 1;
    if (alpha === 0) return;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncHostScheme();
  new MutationObserver(syncHostScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (mql?.addEventListener) {
    mql.addEventListener('change', () => {
      if (state.data) {
        state.lastChartSig = '';
        renderChart(state.data.steps || []);
      }
    });
  }

  const params = new URLSearchParams(location.search);
  const hostConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const savedCap = Number(localStorage.getItem(CAP_STORAGE_KEY));
  const validCaps = [128000, 200000, 1000000, 2000000];
  const state = {
    selectedConvId: '', // '' means follow host conversation (or latest active)
    capacity: validCaps.includes(savedCap) ? savedCap : 1_000_000,
    chartMode: 'tps',
    etag: '',
    data: null,
    supportsRecentApi: true,
    lastRecentFetchAt: 0,
    idleUnchangedStreak: 0,
    lastChartSig: '',
    lastTableSig: '',
    activeConvId: '',
  };

  dom.capSelect.value = String(state.capacity);

  // Only re-render the Context Card & quick context pill when changing window benchmark.
  dom.capSelect.addEventListener('change', () => {
    state.capacity = Number(dom.capSelect.value) || 1_000_000;
    try { localStorage.setItem(CAP_STORAGE_KEY, String(state.capacity)); } catch {}
    if (state.data?.current) {
      renderContextCard(state.data.current, state.data.summary);
    }
  });

  dom.convSelect.addEventListener('change', () => {
    state.selectedConvId = dom.convSelect.value;
    state.etag = '';
    state.lastChartSig = '';
    state.lastTableSig = '';
    state.idleUnchangedStreak = 0;
    pollNow(true);
  });

  // Refresh recent list on demand when user opens the conversation dropdown.
  const onDropdownInteract = () => {
    if (Date.now() - state.lastRecentFetchAt >= RECENT_FOCUS_COOLDOWN_MS) {
      fetchRecentList(true);
    }
  };
  dom.convSelect.addEventListener('focus', onDropdownInteract);
  dom.convSelect.addEventListener('mousedown', onDropdownInteract);

  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => {
      state.chartMode = btn.dataset.chart || 'tps';
      for (const b of document.querySelectorAll('.seg-btn')) {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (state.data) {
        state.lastChartSig = '';
        renderChart(state.data.steps || []);
      }
    });
  }

  dom.copyCompactBtn.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText('/compact');
      const prev = btn.innerHTML;
      btn.textContent = '已复制 /compact';
      setTimeout(() => { btn.innerHTML = prev; }, 1400);
    } catch {}
  });

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function fmtSignedTok(n) {
    const v = Number(n) || 0;
    if (v === 0) return '±0';
    return `${v > 0 ? '+' : '-'}${fmtTok(Math.abs(v))}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function doFetch(url, options) {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    return fn(url, options);
  }

  async function fetchRecentList(force = false) {
    if (!state.supportsRecentApi || document.hidden) return;
    state.lastRecentFetchAt = Date.now();
    try {
      const url = force ? '/api/recent?force=1' : '/api/recent';
      const res = await doFetch(url, { method: 'GET' });
      if (res.status === 404) {
        // Older backend still running before restart; fall back to recent bundled in /api/metrics.
        state.supportsRecentApi = false;
        return;
      }
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok && Array.isArray(json.recent)) {
        updateConvSelect(json.recent, state.activeConvId);
      }
    } catch {
      // Transient error ignored; next cycle will retry.
    }
  }

  async function fetchMetrics(immediate, signal) {
    const targetConv = state.selectedConvId || hostConvId();
    const q = new URLSearchParams();
    if (targetConv) q.set('conversationId', targetConv);
    if (state.etag) q.set('etag', state.etag);
    if (!immediate && state.etag) {
      const waitMs =
        state.data?.status === 'working' ? LONG_POLL_ACTIVE_WAIT_MS : LONG_POLL_IDLE_WAIT_MS;
      q.set('waitMs', String(waitMs));
    }
    const res = await doFetch(`/api/metrics?${q.toString()}`, { method: 'GET', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function updateConvSelect(recent, activeId) {
    const pinned = hostConvId();
    const prevVal = state.selectedConvId;
    const opts = [];
    opts.push(
      `<option value="">${pinned ? '跟随当前窗口会话' : '自动跟随最新活跃会话'}</option>`,
    );
    for (const item of recent || []) {
      const mark = item.id === activeId && !prevVal ? ' · 当前' : '';
      const label = `${item.title || item.id.slice(0, 8)} (${fmtTok(item.contextTokens)})${mark}`;
      opts.push(
        `<option value="${esc(item.id)}"${item.id === prevVal ? ' selected' : ''}>${esc(label)}</option>`,
      );
    }
    const html = opts.join('');
    if (dom.convSelect.dataset.sig !== html) {
      dom.convSelect.innerHTML = html;
      dom.convSelect.dataset.sig = html;
      dom.convSelect.value = prevVal;
    }
  }

  function renderContextCard(cur, sum) {
    const cap = state.capacity;
    const used = cur.contextTokens;
    const pct = (used / cap) * 100;
    const pctStr = `${pct.toFixed(1)}%`;

    dom.qpCtx.textContent = `${pctStr} · ${fmtTok(used)}`;

    setRingValue(pct, `${pctStr} (${fmtTok(used)} / ${fmtTok(cap)})`);
    dom.ctxRing.dataset.level = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : 'ok';
    dom.ctxPctText.textContent = pctStr;
    dom.ctxUsed.textContent = fmtTok(used);
    dom.ctxCap.textContent = fmtTok(cap);
    dom.ctxDelta.textContent = `较上步 ${fmtSignedTok(cur.contextDelta)} · 峰值 ${fmtTok(sum.peakContextTokens)}`;

    if (sum.compactions > 0) {
      dom.compactBadge.className = 'badge badge-good';
      dom.compactBadge.textContent = `已压缩 ${sum.compactions} 次`;
    } else if (pct >= 85) {
      dom.compactBadge.className = 'badge badge-danger';
      dom.compactBadge.textContent = '接近容量上限';
    } else if (pct >= 65) {
      dom.compactBadge.className = 'badge badge-warn';
      dom.compactBadge.textContent = '占用较高';
    } else {
      dom.compactBadge.className = 'badge badge-neutral';
      dom.compactBadge.textContent = '容量充裕';
    }

    const remainCap = cap - used;
    dom.ctxCompactLine.textContent =
      remainCap >= 0
        ? `剩余可用 ${fmtTok(remainCap)} (${Math.max(0, 100 - pct).toFixed(1)}%)`
        : `已超出所选基准 ${fmtTok(-remainCap)}`;

    const totalTurnTokens = Math.max(1, cur.cacheRead + cur.uncachedInput + cur.outputTokens);
    dom.segCache.style.width = `${((cur.cacheRead / totalTurnTokens) * 100).toFixed(1)}%`;
    dom.segUncached.style.width = `${((cur.uncachedInput / totalTurnTokens) * 100).toFixed(1)}%`;
    dom.segOutput.style.width = `${((cur.outputTokens / totalTurnTokens) * 100).toFixed(1)}%`;
    dom.legCache.textContent = fmtTok(cur.cacheRead);
    dom.legUncached.textContent = fmtTok(cur.uncachedInput);
    dom.legOutput.textContent = fmtTok(cur.outputTokens);
  }

  function renderDashboard(d) {
    const cur = d.current;
    const sum = d.summary;

    // Header strip
    dom.statusPill.dataset.state = d.status || 'idle';
    dom.statusText.textContent = d.statusDetail || '就绪';
    dom.modelBadge.textContent = d.model || 'Gemini';
    dom.modelBadge.title = `会话: ${d.title}\n模型: ${d.model}`;

    if (!cur) {
      dom.emptyState.hidden = false;
      dom.dashboard.hidden = true;
      dom.qpCtx.textContent = '0%';
      dom.qpCache.textContent = '—';
      dom.qpSpeed.textContent = '—';
      return;
    }

    dom.emptyState.hidden = true;
    dom.dashboard.hidden = false;

    // 1. Context Ring Card + top context quick pill
    renderContextCard(cur, sum);

    // Quick pills (cache & speed)
    dom.qpCache.textContent = cur.hitRate !== null ? `${cur.hitRate.toFixed(1)}%` : '—';
    dom.qpSpeed.textContent =
      cur.tps !== null ? `${cur.tps.toFixed(1)} tok/s` : d.status === 'working' ? '推理中…' : '—';

    // 2. Prefix Cache Hit Rate Card
    const hitVal = cur.hitRate;
    dom.cacheHitVal.textContent = hitVal !== null ? `${hitVal.toFixed(1)}%` : '—';
    dom.cacheBar.value = hitVal !== null ? hitVal : 0;
    dom.cacheBar.dataset.level = hitVal === null ? 'ok' : hitVal >= 75 ? 'ok' : hitVal >= 40 ? 'warn' : 'low';

    if (cur.seq === 1 && cur.cacheRead === 0) {
      dom.cacheStateBadge.className = 'badge badge-neutral';
      dom.cacheStateBadge.textContent = '首步冷启动';
    } else if (hitVal !== null && hitVal >= 85) {
      dom.cacheStateBadge.className = 'badge badge-good';
      dom.cacheStateBadge.textContent = '高命中复用';
    } else if (hitVal !== null && hitVal >= 50) {
      dom.cacheStateBadge.className = 'badge badge-warn';
      dom.cacheStateBadge.textContent = '部分命中';
    } else {
      dom.cacheStateBadge.className = 'badge badge-danger';
      dom.cacheStateBadge.textContent = '前缀未命中';
    }

    dom.cacheWarmVal.textContent = sum.warmHitRate !== null ? `${sum.warmHitRate.toFixed(1)}%` : '首步后统计';
    dom.cacheCumVal.textContent = sum.cumulativeHitRate !== null ? `${sum.cumulativeHitRate.toFixed(1)}%` : '—';
    dom.cacheTotalRead.textContent = fmtTok(sum.totalCacheRead);
    dom.cacheMissInfo.textContent = `${fmtTok(sum.totalUncachedInput)} / ${sum.cacheResets}次`;

    // 3. Speed (tok/s) Card
    if (d.status === 'working' && cur.tps === null) {
      dom.speedBar.removeAttribute('value');
    } else {
      dom.speedBar.value = Math.min(200, cur.tps || 0);
    }
    dom.speedVal.textContent = cur.tps !== null ? cur.tps.toFixed(1) : '—';
    dom.speedDurBadge.textContent = cur.durationSec !== null ? `单步耗时 ${cur.durationSec.toFixed(1)}s` : '耗时统计中';
    dom.speedAvgVal.textContent = sum.avgTps !== null ? `${sum.avgTps.toFixed(1)} tok/s` : '—';
    dom.speedPeakVal.textContent = sum.peakTps !== null ? `${sum.peakTps.toFixed(1)} tok/s` : '—';
    dom.totalOutVal.textContent = fmtTok(sum.totalOutput);
    dom.turnStepVal.textContent = `${sum.userTurns} 轮 / ${sum.plannerSteps} 步`;

    const steps = d.steps || [];
    renderChart(steps);
    renderTable(steps);
  }

  function stepsSignature(steps) {
    if (!steps.length) return '0';
    const last = steps[steps.length - 1];
    return `${steps.length}:${last.seq}:${last.contextTokens}:${last.hitRate}:${last.tps}:${last.durationSec}`;
  }

  function renderChart(steps) {
    const mode = state.chartMode;
    const sig = `${mode}|${stepsSignature(steps)}`;
    if (sig === state.lastChartSig) return;
    state.lastChartSig = sig;

    if (!steps.length) {
      dom.trendSvg.innerHTML = '';
      dom.chartFoot.textContent = '';
      return;
    }

    const pts = steps.slice(-28);
    const W = 400;
    const H = 96;
    const padX = 10;
    const padY = 12;

    const vals = pts.map((s) => {
      if (mode === 'context') return s.contextTokens || 0;
      if (mode === 'cache') return s.hitRate ?? 0;
      return s.tps ?? 0;
    });

    const maxVal = Math.max(1, ...vals, mode === 'cache' ? 100 : 1);
    const colorVar =
      mode === 'cache' ? 'var(--sm-emerald)' : mode === 'context' ? 'var(--sm-purple)' : 'var(--sm-accent)';

    const coords = vals.map((v, idx) => {
      const x = pts.length === 1 ? W / 2 : padX + (idx / (pts.length - 1)) * (W - padX * 2);
      const y = H - padY - (v / maxVal) * (H - padY * 2);
      return { x, y, v, step: pts[idx] };
    });

    const barWidth = Math.max(4, Math.min(16, (W - padX * 2) / Math.max(pts.length * 1.6, 2)));
    const bars = coords
      .map((c) => {
        const bh = Math.max(2, H - padY - c.y);
        const label =
          mode === 'context'
            ? `#${c.step.seq}: ${fmtTok(c.v)}`
            : mode === 'cache'
              ? `#${c.step.seq}: ${c.v.toFixed(1)}%`
              : `#${c.step.seq}: ${c.v.toFixed(1)} tok/s`;
        return `<rect x="${(c.x - barWidth / 2).toFixed(1)}" y="${c.y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${colorVar}" fill-opacity="0.28"><title>${esc(label)}</title></rect>`;
      })
      .join('');

    let line = '';
    if (coords.length > 1) {
      const dPath = coords
        .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
        .join(' ');
      line = `<path d="${dPath}" fill="none" stroke="${colorVar}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const dots = coords
      .map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.6" fill="${colorVar}"/>`)
      .join('');

    dom.trendSvg.innerHTML = `
      <line x1="${padX}" y1="${H - padY}" x2="${W - padX}" y2="${H - padY}" stroke="currentColor" stroke-opacity="0.1"/>
      ${bars}
      ${line}
      ${dots}
    `;

    const firstSeq = pts[0].seq;
    const lastSeq = pts[pts.length - 1].seq;
    const maxLabel = mode === 'context' ? fmtTok(maxVal) : mode === 'cache' ? '100%' : `${maxVal.toFixed(1)} tok/s`;
    dom.chartFoot.innerHTML = `<span>步 #${firstSeq} → #${lastSeq}</span><span>峰值标尺: ${esc(maxLabel)}</span>`;
  }

  function renderTable(steps) {
    const sig = stepsSignature(steps);
    if (sig === state.lastTableSig) return;
    state.lastTableSig = sig;

    const rows = [...steps].reverse().slice(0, 25).map((s) => {
      let flags = '';
      if (s.compacted) flags += `<span class="step-flag badge-good" title="上下文压缩">压缩</span>`;
      if (s.cacheReset) flags += `<span class="step-flag badge-warn" title="前缀缓存重置">重置</span>`;
      const hitText = s.hitRate !== null ? `${s.hitRate.toFixed(1)}%` : '—';
      const durText = s.durationSec !== null ? `${s.durationSec.toFixed(1)}s` : '—';
      const tpsText = s.tps !== null ? `${s.tps.toFixed(1)}` : '—';
      return `
        <tr>
          <td class="mono-cell">${s.seq}</td>
          <td class="mono-cell">${fmtTok(s.contextTokens)}${flags}</td>
          <td class="mono-cell">${hitText}</td>
          <td class="mono-cell">${fmtTok(s.outputTokens)}</td>
          <td class="mono-cell">${durText}</td>
          <td class="mono-cell"><strong>${tpsText}</strong></td>
          <td title="${esc(s.toolLabel)}">${esc(s.toolLabel)}</td>
        </tr>
      `;
    });
    dom.stepTbody.innerHTML = rows.join('');
  }

  let timer = null;
  let activeAbort = null;
  let pollGen = 0;

  function stopPolling() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
  }

  async function pollNow(immediate = false) {
    stopPolling();
    if (document.hidden) return;

    const myGen = ++pollGen;
    const ctrl = new AbortController();
    activeAbort = ctrl;

    let nextDelay = POLL_FALLBACK_IDLE_BASE_MS;
    try {
      const res = await fetchMetrics(immediate, ctrl.signal);
      if (myGen !== pollGen) return;

      if (res.ok) {
        if (res.conversationId) state.activeConvId = res.conversationId;
        if (Array.isArray(res.recent)) {
          // Legacy backend compatibility: consume bundled recent list when present.
          updateConvSelect(res.recent, state.activeConvId);
        }

        if (!res.unchanged) {
          state.etag = res.etag || '';
          state.idleUnchangedStreak = 0;
          if (res.empty) {
            state.data = null;
            state.lastChartSig = '';
            state.lastTableSig = '';
            dom.statusPill.dataset.state = 'idle';
            dom.statusText.textContent = '等待首条消息';
            dom.emptyState.hidden = false;
            dom.dashboard.hidden = true;
          } else {
            state.data = res;
            renderDashboard(res);
          }
        } else {
          state.idleUnchangedStreak++;
        }

        // Periodically refresh dropdown list in background (low frequency) when using decoupled endpoint.
        if (
          state.supportsRecentApi &&
          Date.now() - state.lastRecentFetchAt >= RECENT_REFRESH_INTERVAL_MS
        ) {
          fetchRecentList(false);
        }

        if (res.longPoll) {
          // Server already waited via fs.watch; tiny breathing gap before next long-poll.
          nextDelay = res.unchanged ? 250 : 120;
        } else if (state.data?.status === 'working') {
          nextDelay = POLL_FALLBACK_ACTIVE_MS;
        } else {
          // Adaptive idle backoff for legacy non-long-poll backend.
          const step = Math.min(3, state.idleUnchangedStreak);
          nextDelay = Math.min(POLL_FALLBACK_IDLE_MAX_MS, POLL_FALLBACK_IDLE_BASE_MS + step * 1200);
        }
      } else {
        dom.statusPill.dataset.state = 'error';
        dom.statusText.textContent = res.error || '读取失败';
        nextDelay = 3000;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || myGen !== pollGen) return;
      dom.statusPill.dataset.state = 'error';
      dom.statusText.textContent = '面板重连中…';
      nextDelay = 3000;
    } finally {
      if (activeAbort === ctrl) activeAbort = null;
    }

    if (!document.hidden && myGen === pollGen) {
      timer = setTimeout(() => pollNow(false), nextDelay);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      pollNow(true);
      if (Date.now() - state.lastRecentFetchAt >= RECENT_REFRESH_INTERVAL_MS) {
        fetchRecentList(false);
      }
    }
  });

  // Initial load: fetch metrics immediately + populate recent conversation dropdown in parallel.
  pollNow(true);
  fetchRecentList(false);
})();
