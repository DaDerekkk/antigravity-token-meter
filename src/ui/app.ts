import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import type {
  ConversationStat,
  PromptTurnStat,
  SourceFilter,
  TimeRange,
  TokenDashboardData,
} from '../collector.js';

const app = new App({ name: 'Token Meter', version: '0.3.0' }, {});

type SortKey = 'latest' | 'cost' | 'tokens';

interface PlanConfig {
  id: string;
  label: string;
  monthlyUsd: number;
}

const PLANS: PlanConfig[] = [
  { id: 'ultra20', label: 'Ultra 20x ($199.99/mo)', monthlyUsd: 199.99 },
  { id: 'ultra5', label: 'Ultra 5x ($99.99/mo)', monthlyUsd: 99.99 },
  { id: 'ultra250', label: 'Ultra ($249.99/mo)', monthlyUsd: 249.99 },
  { id: 'pro', label: 'Pro ($19.99/mo)', monthlyUsd: 19.99 },
];

const USD_TO_CNY = 7.25;

let currentRange: TimeRange = '7d';
let currentSource: SourceFilter = 'all';
let currentProjectId = 'all';
let currentSort: SortKey = 'latest';
let currentPlanId = 'ultra20';
let searchQuery = '';
let expandedConvIds = new Set<string>();
const turnsCache = new Map<string, PromptTurnStat[]>();
const turnsLoading = new Set<string>();
let currentData: TokenDashboardData | null = null;
let isLoading = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function getPlan(): PlanConfig {
  return PLANS.find((p) => p.id === currentPlanId) || PLANS[0];
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtFull(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtUsd(v: number): string {
  if (v >= 100) return `$${v.toFixed(1)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.005) return `$${v.toFixed(3)}`;
  if (v === 0) return '$0.00';
  return '<$0.005';
}

function fmtCny(usd: number): string {
  const cny = usd * USD_TO_CNY;
  if (cny >= 100) return `¥${cny.toFixed(0)}`;
  if (cny >= 1) return `¥${cny.toFixed(1)}`;
  if (cny >= 0.01) return `¥${cny.toFixed(2)}`;
  return '<¥0.01';
}

function fmtUltraShare(usd: number, plan: PlanConfig): string {
  const pct = (usd / plan.monthlyUsd) * 100;
  if (pct >= 100) return `${(usd / plan.monthlyUsd).toFixed(2)}x 月费`;
  if (pct >= 1) return `${pct.toFixed(1)}% 月费`;
  if (pct >= 0.05) return `${pct.toFixed(2)}% 月费`;
  return '<0.05% 月费';
}

function fmtUltraDays(usd: number, plan: PlanConfig): string {
  const dailyCost = plan.monthlyUsd / 30;
  const days = usd / dailyCost;
  if (days >= 1) return `${days.toFixed(1)} 天额度`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)} 小时额度`;
  return `${Math.max(1, Math.round(hours * 60))} 分钟额度`;
}

function fmtTimeShort(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setLoading(loading: boolean) {
  isLoading = loading;
  const btn = $<HTMLButtonElement>('btn-refresh');
  if (btn) {
    btn.disabled = loading;
    btn.textContent = loading ? '刷新中…' : '刷新';
  }
}

function updateActiveControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === currentRange);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === currentSource);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === currentSort);
  });
}

function renderProjects(data: TokenDashboardData) {
  const el = $('projects-list');
  const clearBtn = $('btn-clear-project');
  if (!el) return;

  if (clearBtn) {
    clearBtn.style.display = currentProjectId === 'all' ? 'none' : 'inline-block';
  }

  if (!data.projects.length) {
    el.innerHTML = '<div class="empty">暂无项目数据</div>';
    return;
  }

  const plan = getPlan();
  el.innerHTML = data.projects
    .map((p) => {
      const selected = currentProjectId === p.projectId;
      const avgPrompt = p.promptCount > 0 ? p.estimatedUsd / p.promptCount : 0;
      return `
        <div class="proj-card ${selected ? 'selected' : ''}" data-project-id="${esc(p.projectId)}">
          <div class="proj-top">
            <span class="proj-name" title="${esc(p.projectName)}">${esc(p.projectName)}</span>
            <span class="proj-cost">${fmtUsd(p.estimatedUsd)} <span class="cost-cny">${fmtCny(p.estimatedUsd)}</span></span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${Math.max(2, p.share)}%"></div>
          </div>
          <div class="proj-meta">
            <span>${p.conversations} 对话 · ${p.promptCount} 次提问 · 均次 ${fmtUsd(avgPrompt)}</span>
            <span class="cost-ultra">${fmtUltraShare(p.estimatedUsd, plan)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  el.querySelectorAll<HTMLDivElement>('.proj-card').forEach((card) => {
    card.addEventListener('click', () => {
      const pid = card.dataset.projectId || 'all';
      currentProjectId = currentProjectId === pid ? 'all' : pid;
      if (currentData) {
        renderProjects(currentData);
        renderConversations(currentData);
      }
    });
  });
}

function getFilteredConversations(data: TokenDashboardData): ConversationStat[] {
  const q = searchQuery.trim().toLowerCase();
  let list = data.conversations;
  if (currentProjectId !== 'all') {
    list = list.filter((c) => c.projectId === currentProjectId);
  }
  if (q) {
    list = list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.projectName.toLowerCase().includes(q) ||
        c.primaryModel.toLowerCase().includes(q),
    );
  }
  const sorted = [...list];
  if (currentSort === 'cost') {
    sorted.sort((a, b) => b.estimatedUsd - a.estimatedUsd);
  } else if (currentSort === 'tokens') {
    sorted.sort((a, b) => b.totalTokens - a.totalTokens);
  } else {
    sorted.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  }
  return sorted;
}

async function loadConversationTurns(conv: ConversationStat) {
  if (turnsCache.has(conv.id) || turnsLoading.has(conv.id)) return;
  turnsLoading.add(conv.id);
  if (currentData) renderConversations(currentData);
  try {
    const res = await app.callServerTool({
      name: 'get_conversation_turns',
      arguments: { id: conv.id, source: conv.source },
    });
    const sc = res.structuredContent as { turns?: PromptTurnStat[] } | undefined;
    turnsCache.set(conv.id, sc?.turns ?? []);
  } catch {
    turnsCache.set(conv.id, []);
  } finally {
    turnsLoading.delete(conv.id);
    if (currentData) renderConversations(currentData);
  }
}

function renderTurnsHtml(conv: ConversationStat, plan: PlanConfig): string {
  if (turnsLoading.has(conv.id)) {
    return '<div class="turns-loading">正在解析每次提示词费用…</div>';
  }
  const turns = turnsCache.get(conv.id);
  if (!turns) {
    return '<div class="turns-loading">加载中…</div>';
  }
  if (!turns.length) {
    return '<div class="turns-loading">无逐轮提示词记录</div>';
  }

  return `
    <div class="turns-head">每次提示词明细（共 ${turns.length} 轮）</div>
    <div class="turns-list">
      ${turns
        .map(
          (t) => `
          <div class="turn-row">
            <div class="turn-main">
              <div class="turn-prompt"><span class="turn-idx">#${t.turnIndex}</span> ${esc(t.promptPreview)}</div>
              <div class="turn-sub">
                <span>${fmtTimeShort(t.createdAt)}</span>
                <span>${t.steps} 步</span>
                <span>总 ${fmt(t.totalTokens)} (输入 ${fmt(t.inputTokens)} · 缓存 ${fmt(t.cacheReadTokens)} · 输出 ${fmt(t.outputTokens)})</span>
              </div>
            </div>
            <div class="turn-cost">
              <div class="turn-usd">${fmtUsd(t.estimatedUsd)} <span class="cost-cny">${fmtCny(t.estimatedUsd)}</span></div>
              <div class="turn-ultra">${fmtUltraShare(t.estimatedUsd, plan)}</div>
            </div>
          </div>
        `,
        )
        .join('')}
    </div>
  `;
}

function renderConversations(data: TokenDashboardData) {
  const el = $('conv-list');
  const countEl = $('conv-count');
  if (!el) return;

  const plan = getPlan();
  const list = getFilteredConversations(data);
  const activeProj =
    currentProjectId === 'all'
      ? ''
      : ` · 项目：${data.projects.find((p) => p.projectId === currentProjectId)?.projectName || currentProjectId}`;
  if (countEl) countEl.textContent = `共 ${list.length} 个对话${activeProj}`;

  if (!list.length) {
    el.innerHTML = '<div class="empty">当前筛选条件下没有对话记录</div>';
    return;
  }

  el.innerHTML = list
    .map((c) => {
      const expanded = expandedConvIds.has(c.id);
      const ultraShare = fmtUltraShare(c.estimatedUsd, plan);
      const ultraDays = fmtUltraDays(c.estimatedUsd, plan);
      return `
        <div class="conv-item ${expanded ? 'expanded' : ''}" data-conv-id="${esc(c.id)}">
          <div class="conv-row">
            <div class="conv-main">
              <div class="conv-title" title="${esc(c.title)}">${esc(c.title)}</div>
              <div class="conv-sub">
                <span class="badge badge-proj" title="所属项目">${esc(c.projectName)}</span>
                <span class="badge">${esc(c.source)}</span>
                <span class="badge badge-model">${esc(c.primaryModel)}</span>
                <span>${fmtTimeShort(c.lastActive)}</span>
              </div>
              <div class="conv-metrics">
                <span><b>${c.promptCount}</b> 次提示词 (均次 <b>${fmtUsd(c.avgPromptUsd)}</b> / ${fmtCny(c.avgPromptUsd)})</span>
                <span>当前上下文 <b>${fmt(c.currentContextTokens)}</b></span>
                <span>累计 <b>${fmt(c.totalTokens)}</b> · 缓存 <b>${c.cacheHitRate}%</b></span>
              </div>
            </div>
            <div class="conv-cost">
              <div class="cost-usd">${fmtUsd(c.estimatedUsd)} <span class="cost-cny">${fmtCny(c.estimatedUsd)}</span></div>
              <div class="cost-ultra">${ultraShare} · 约 ${ultraDays}</div>
            </div>
          </div>
          ${
            expanded
              ? `
            <div class="conv-detail">
              <div class="detail-grid">
                <div><span class="d-label">未缓存输入</span><span>${fmtFull(c.inputTokens)} · ${fmtUsd(c.inputUsd)}</span></div>
                <div><span class="d-label">缓存读取</span><span>${fmtFull(c.cacheReadTokens)} · ${fmtUsd(c.cacheUsd)}</span></div>
                <div><span class="d-label">模型输出</span><span>${fmtFull(c.outputTokens)} · ${fmtUsd(c.outputUsd)}</span></div>
                <div><span class="d-label">总步数</span><span>${c.steps} 步</span></div>
              </div>
              ${renderTurnsHtml(c, plan)}
            </div>
          `
              : ''
          }
        </div>
      `;
    })
    .join('');

  el.querySelectorAll<HTMLDivElement>('.conv-row').forEach((row) => {
    row.addEventListener('click', () => {
      const parent = row.closest<HTMLDivElement>('.conv-item');
      const id = parent?.dataset.convId;
      if (!id || !currentData) return;
      if (expandedConvIds.has(id)) {
        expandedConvIds.delete(id);
        renderConversations(currentData);
      } else {
        expandedConvIds.add(id);
        const conv = currentData.conversations.find((x) => x.id === id);
        renderConversations(currentData);
        if (conv) void loadConversationTurns(conv);
      }
    });
  });
}

function renderDailyChart(data: TokenDashboardData) {
  const container = $('daily-chart');
  const readout = $('chart-readout');
  if (!container) return;

  if (!data.daily.length) {
    container.innerHTML = '<div class="empty">当前时间段无数据</div>';
    if (readout) readout.textContent = '';
    return;
  }

  const maxTotal = Math.max(
    ...data.daily.map((d) => d.inputTokens + d.cacheReadTokens + d.outputTokens),
    1,
  );
  const width = 640;
  const height = 150;
  const padTop = 10;
  const padBottom = 24;
  const chartH = height - padTop - padBottom;
  const n = data.daily.length;
  const gap = Math.max(2, Math.min(8, Math.floor(140 / n)));
  const barW = Math.max(4, (width - gap * (n + 1)) / n);

  const bars = data.daily
    .map((d, i) => {
      const total = d.inputTokens + d.cacheReadTokens + d.outputTokens;
      const x = gap + i * (barW + gap);
      const hTotal = (total / maxTotal) * chartH;
      const hCache = total > 0 ? (d.cacheReadTokens / total) * hTotal : 0;
      const hInput = total > 0 ? (d.inputTokens / total) * hTotal : 0;
      const hOut = Math.max(0, hTotal - hCache - hInput);

      const yCache = padTop + chartH - hCache;
      const yInput = yCache - hInput;
      const yOut = yInput - hOut;

      const labelStep = n > 14 ? Math.ceil(n / 7) : n > 7 ? 2 : 1;
      const showLabel = i % labelStep === 0 || i === n - 1;
      const shortDate = d.date.slice(5);

      return `
        <g class="bar-group" data-idx="${i}">
          <rect x="${x.toFixed(1)}" y="${padTop}" width="${barW.toFixed(1)}" height="${chartH}" fill="transparent" />
          ${hCache > 0.5 ? `<rect x="${x.toFixed(1)}" y="${yCache.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCache.toFixed(1)}" rx="1.5" class="seg-cache" />` : ''}
          ${hInput > 0.5 ? `<rect x="${x.toFixed(1)}" y="${yInput.toFixed(1)}" width="${barW.toFixed(1)}" height="${hInput.toFixed(1)}" rx="1.5" class="seg-input" />` : ''}
          ${hOut > 0.5 ? `<rect x="${x.toFixed(1)}" y="${yOut.toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" rx="1.5" class="seg-output" />` : ''}
          ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="axis-label">${shortDate}</text>` : ''}
        </g>
      `;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
      <line x1="0" y1="${padTop + chartH}" x2="${width}" y2="${padTop + chartH}" class="axis-line" />
      ${bars}
    </svg>
  `;

  const setReadout = (idx: number) => {
    if (!readout) return;
    const d = data.daily[idx];
    if (!d) return;
    const tot = d.inputTokens + d.cacheReadTokens + d.outputTokens;
    readout.textContent = `${d.date} · ${fmtUsd(d.estimatedUsd)} (${fmtCny(d.estimatedUsd)}) · 总计 ${fmt(tot)} (缓存 ${fmt(d.cacheReadTokens)} · 输入 ${fmt(d.inputTokens)} · 输出 ${fmt(d.outputTokens)})`;
  };

  setReadout(data.daily.length - 1);
  container.querySelectorAll<SVGGElement>('.bar-group').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      setReadout(Number(g.dataset.idx));
    });
  });
}

function renderModels(data: TokenDashboardData) {
  const el = $('models-list');
  if (!el) return;
  if (!data.models.length) {
    el.innerHTML = '<div class="empty">无模型数据</div>';
    return;
  }
  const totalUsd = data.totals.estimatedUsd || 1;
  el.innerHTML = data.models
    .map((m) => {
      const costPct = Math.round((m.estimatedUsd / totalUsd) * 1000) / 10;
      return `
        <div class="model-row">
          <div class="model-head">
            <span class="model-name" title="${esc(m.model)}">${esc(m.model)}</span>
            <span class="model-meta"><b>${fmtUsd(m.estimatedUsd)}</b> (${costPct}%) · ${fmt(m.totalTokens)}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${Math.max(1.5, costPct)}%"></div>
          </div>
          <div class="model-sub">
            <span>Input ${fmt(m.inputTokens)}</span>
            <span>Cache ${fmt(m.cacheReadTokens)}</span>
            <span>Out ${fmt(m.outputTokens)}</span>
            <span>${m.steps} 步</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function render(data: TokenDashboardData) {
  currentData = data;
  currentRange = data.range;
  currentSource = data.source;
  if (currentProjectId !== 'all' && !data.projects.some((p) => p.projectId === currentProjectId)) {
    currentProjectId = 'all';
  }
  updateActiveControls();

  const t = data.totals;
  const plan = getPlan();
  const setText = (id: string, val: string, title?: string) => {
    const el = $(id);
    if (!el) return;
    el.textContent = val;
    if (title) el.title = title;
  };

  setText('kpi-cost', fmtUsd(t.estimatedUsd), `折合 API 费用 ${fmtUsd(t.estimatedUsd)}`);
  setText('kpi-cost-sub', `约 ${fmtCny(t.estimatedUsd)} · ${t.conversations} 对话`);

  setText('kpi-avg-prompt', fmtUsd(t.avgPromptUsd), `平均每次提示词费用`);
  setText('kpi-avg-prompt-sub', `约 ${fmtCny(t.avgPromptUsd)}/次 · 共 ${t.promptCount} 次提问`);

  const multiple = t.estimatedUsd / plan.monthlyUsd;
  setText(
    'kpi-ultra',
    multiple >= 1 ? `${multiple.toFixed(2)}x` : `${(multiple * 100).toFixed(1)}%`,
    `对比 ${plan.label}`,
  );
  setText(
    'kpi-ultra-sub',
    `对比 ${plan.label.split(' ')[0]} 月费 · 约 ${fmtUltraDays(t.estimatedUsd, plan)}`,
  );

  setText('kpi-total', fmt(t.totalTokens), `${fmtFull(t.totalTokens)} tokens`);
  setText(
    'kpi-total-sub',
    `缓存命中 ${t.cacheHitRate}% · RTK 省 ${data.rtk.available ? fmt(data.rtk.savedTokens) : '—'}`,
  );

  const ts = new Date(data.generatedAt);
  setText('footer-updated', `更新于 ${ts.toLocaleTimeString()}`);

  renderProjects(data);
  renderConversations(data);
  renderDailyChart(data);
  renderModels(data);
}

async function fetchStats(range: TimeRange, source: SourceFilter) {
  if (isLoading) return;
  setLoading(true);
  turnsCache.clear();
  try {
    const result = await app.callServerTool({
      name: 'get_token_stats',
      arguments: { range, source },
    });
    const payload = result.structuredContent as unknown as TokenDashboardData | undefined;
    if (payload) render(payload);
  } catch (err) {
    const readout = $('chart-readout');
    if (readout) readout.textContent = `错误: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    setLoading(false);
  }
}

function bindControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range as TimeRange;
      if (range === currentRange) return;
      currentRange = range;
      updateActiveControls();
      void fetchStats(currentRange, currentSource);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = btn.dataset.source as SourceFilter;
      if (source === currentSource) return;
      currentSource = source;
      updateActiveControls();
      void fetchStats(currentRange, currentSource);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sort = btn.dataset.sort as SortKey;
      if (sort === currentSort) return;
      currentSort = sort;
      updateActiveControls();
      if (currentData) renderConversations(currentData);
    });
  });

  $('btn-clear-project')?.addEventListener('click', () => {
    currentProjectId = 'all';
    if (currentData) {
      renderProjects(currentData);
      renderConversations(currentData);
    }
  });

  const planSelect = $<HTMLSelectElement>('plan-select');
  if (planSelect) {
    planSelect.innerHTML = PLANS.map(
      (p) => `<option value="${p.id}" ${p.id === currentPlanId ? 'selected' : ''}>${p.label}</option>`,
    ).join('');
    planSelect.addEventListener('change', () => {
      currentPlanId = planSelect.value;
      if (currentData) render(currentData);
    });
  }

  const searchInput = $<HTMLInputElement>('conv-search');
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    if (currentData) renderConversations(currentData);
  });

  $('btn-refresh')?.addEventListener('click', () => {
    void fetchStats(currentRange, currentSource);
  });
}

function applyThemeFromContext(ctx: ReturnType<App['getHostContext']>) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.dataset.theme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

app.ontoolinput = () => {
  setLoading(true);
};

app.ontoolresult = (result) => {
  setLoading(false);
  const payload = result.structuredContent as unknown as TokenDashboardData | undefined;
  if (payload) render(payload);
};

app.onhostcontextchanged = (ctx) => {
  applyThemeFromContext(ctx);
};

bindControls();

async function init() {
  await app.connect();
  applyThemeFromContext(app.getHostContext());
  setTimeout(() => {
    if (!currentData && !isLoading) {
      void fetchStats(currentRange, currentSource);
    }
  }, 400);
}

void init();
