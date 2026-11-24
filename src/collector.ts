import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TimeRange = 'today' | '7d' | '30d' | 'all';
export type SourceFilter = 'all' | 'desktop' | 'cli' | 'ide';

export interface ModelRate {
  input: number; // USD per 1M uncached input tokens
  cache: number; // USD per 1M cache read tokens
  output: number; // USD per 1M output tokens
}

export interface DailyPoint {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  steps: number;
}

export interface ModelStat {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  steps: number;
  share: number;
}

export interface ProjectStat {
  projectId: string;
  projectName: string;
  conversations: number;
  promptCount: number;
  steps: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  share: number;
}

export interface ConversationStat {
  id: string;
  title: string;
  source: 'desktop' | 'cli' | 'ide';
  projectId: string;
  projectName: string;
  isSubagent: boolean;
  primaryModel: string;
  lastActive: string;
  promptCount: number;
  avgPromptUsd: number;
  steps: number;
  currentContextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  inputUsd: number;
  cacheUsd: number;
  outputUsd: number;
  estimatedUsd: number;
}

export interface PromptTurnStat {
  turnIndex: number;
  promptPreview: string;
  createdAt: string;
  steps: number;
  models: string[];
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputUsd: number;
  cacheUsd: number;
  outputUsd: number;
  estimatedUsd: number;
}

export interface RtkStats {
  available: boolean;
  totalCommands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPct: number;
}

export interface TokenDashboardData {
  range: TimeRange;
  source: SourceFilter;
  generatedAt: string;
  sourcesFound: string[];
  totals: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheHitRate: number;
    estimatedUsd: number;
    promptCount: number;
    avgPromptUsd: number;
    steps: number;
    conversations: number;
  };
  daily: DailyPoint[];
  projects: ProjectStat[];
  models: ModelStat[];
  conversations: ConversationStat[];
  rtk: RtkStats;
}

const SOURCE_DIRS: Array<{ key: 'desktop' | 'cli' | 'ide'; dir: string }> = [
  { key: 'desktop', dir: 'antigravity' },
  { key: 'cli', dir: 'antigravity-cli' },
  { key: 'ide', dir: 'antigravity-ide' },
];

const MODEL_RATES: Array<{ match: RegExp; rate: ModelRate }> = [
  { match: /claude-opus-5/i, rate: { input: 4.0, cache: 0.2, output: 20.0 } },
  { match: /claude-opus-4/i, rate: { input: 15.0, cache: 1.5, output: 75.0 } },
  { match: /claude-sonnet/i, rate: { input: 3.0, cache: 0.3, output: 15.0 } },
  { match: /claude-haiku/i, rate: { input: 0.8, cache: 0.08, output: 4.0 } },
  { match: /gemini-4-neon/i, rate: { input: 3.0, cache: 0.15, output: 15.0 } },
  { match: /gemini-4-argon/i, rate: { input: 3.0, cache: 0.15, output: 15.0 } },
  { match: /gemini-4-(carbon|hydrogen)/i, rate: { input: 1.25, cache: 0.1, output: 6.0 } },
  { match: /flash/i, rate: { input: 0.75, cache: 0.075, output: 3.75 } },
  { match: /gemini-3(\.\d+)?-pro/i, rate: { input: 2.0, cache: 0.2, output: 12.0 } },
  { match: /gpt-5/i, rate: { input: 2.5, cache: 0.25, output: 10.0 } },
];

const DEFAULT_RATE: ModelRate = { input: 2.5, cache: 0.15, output: 12.0 };

export function getModelRate(model: string): ModelRate {
  for (const entry of MODEL_RATES) {
    if (entry.match.test(model)) return entry.rate;
  }
  return DEFAULT_RATE;
}

function roundUsd(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function getCutoffMs(range: TimeRange): number {
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === '7d') return Date.now() - 7 * 86_400_000;
  if (range === '30d') return Date.now() - 30 * 86_400_000;
  return 0;
}

function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cleanPromptSnippet(raw: string, maxLen = 72): string {
  const stripped = raw
    .replace(/<USER_REQUEST>|<\/USER_REQUEST>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped;
}

function loadProjectNames(): Map<string, string> {
  const map = new Map<string, string>();
  const projDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (!fs.existsSync(projDir)) return map;
  try {
    for (const file of fs.readdirSync(projDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf8')) as {
          id?: string;
          name?: string;
        };
        if (obj.id && obj.name) map.set(obj.id, obj.name);
      } catch {
        // skip malformed project json
      }
    }
  } catch {
    // ignore
  }
  return map;
}

function parseWorkspaceName(workspaceUris: string): string {
  if (!workspaceUris || workspaceUris === '[]') return '';
  try {
    const arr = JSON.parse(workspaceUris) as string[];
    const first = arr[0];
    if (!first) return '';
    const cleaned = first.replace(/^file:\/\//, '').replace(/\/+$/, '');
    const base = path.basename(cleaned);
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    return '';
  }
}

interface ConvMeta {
  title: string;
  preview: string;
  projectId: string;
  workspaceName: string;
  parentId: string;
  agentName: string;
}

function loadConversationMeta(baseDir: string): Map<string, ConvMeta> {
  const metaMap = new Map<string, ConvMeta>();
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return metaMap;
  try {
    const out = execFileSync(
      'sqlite3',
      [
        '-readonly',
        '-json',
        dbPath,
        'SELECT conversation_id, title, preview, workspace_uris, project_id, parent_conversation_id, agent_name FROM conversation_summaries',
      ],
      { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = JSON.parse(out || '[]') as Array<Record<string, string>>;
    for (const r of rows) {
      if (!r.conversation_id) continue;
      metaMap.set(r.conversation_id, {
        title: (r.title || '').trim(),
        preview: (r.preview || '').trim(),
        projectId: (r.project_id || '').trim(),
        workspaceName: parseWorkspaceName(r.workspace_uris || ''),
        parentId: (r.parent_conversation_id || '').trim(),
        agentName: (r.agent_name || '').trim(),
      });
    }
  } catch {
    // Graceful fallback if sqlite3 is unavailable
  }
  return metaMap;
}

function collectRtkStats(): RtkStats {
  const empty: RtkStats = {
    available: false,
    totalCommands: 0,
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
  };
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'rtk'), 'rtk'];
  for (const bin of candidates) {
    try {
      if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
      const out = execFileSync(bin, ['gain', '--format', 'json'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(out);
      const summary = parsed.summary ?? parsed;
      const totalCommands = Number(summary.total_commands ?? summary.commands ?? 0);
      const inputTokens = Number(summary.total_input ?? summary.input_tokens ?? 0);
      const outputTokens = Number(summary.total_output ?? summary.output_tokens ?? 0);
      const savedTokens = Number(summary.total_saved ?? summary.saved_tokens ?? Math.max(0, inputTokens - outputTokens));
      const savingsPct = Number(
        summary.avg_savings_pct ??
          summary.savings_pct ??
          (inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0),
      );
      return {
        available: true,
        totalCommands,
        inputTokens,
        outputTokens,
        savedTokens,
        savingsPct: Math.round(savingsPct * 10) / 10,
      };
    } catch {
      // Try next candidate
    }
  }
  return empty;
}

export function collectConversationTurns(
  convId: string,
  source: 'desktop' | 'cli' | 'ide' = 'desktop',
): PromptTurnStat[] {
  const srcEntry = SOURCE_DIRS.find((s) => s.key === source) || SOURCE_DIRS[0];
  const transcriptPath = path.join(
    os.homedir(),
    '.gemini',
    srcEntry.dir,
    'brain',
    convId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (!fs.existsSync(transcriptPath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const turns: PromptTurnStat[] = [];
  let current: {
    turnIndex: number;
    promptPreview: string;
    createdAt: string;
    steps: number;
    models: Set<string>;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    inputUsd: number;
    cacheUsd: number;
    outputUsd: number;
  } | null = null;

  const flush = () => {
    if (!current || current.steps === 0) return;
    turns.push({
      turnIndex: current.turnIndex,
      promptPreview: current.promptPreview || `第 ${current.turnIndex} 轮提示词`,
      createdAt: current.createdAt,
      steps: current.steps,
      models: [...current.models],
      inputTokens: current.inputTokens,
      cacheReadTokens: current.cacheReadTokens,
      outputTokens: current.outputTokens,
      totalTokens: current.inputTokens + current.cacheReadTokens + current.outputTokens,
      inputUsd: roundUsd(current.inputUsd),
      cacheUsd: roundUsd(current.cacheUsd),
      outputUsd: roundUsd(current.outputUsd),
      estimatedUsd: roundUsd(current.inputUsd + current.cacheUsd + current.outputUsd),
    });
  };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (!line.includes('USER_INPUT') && !line.includes('PLANNER_RESPONSE')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === 'USER_INPUT') {
      flush();
      const content = typeof obj.content === 'string' ? obj.content : '';
      const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
      current = {
        turnIndex: turns.length + 1,
        promptPreview: cleanPromptSnippet(content, 100),
        createdAt,
        steps: 0,
        models: new Set(),
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        inputUsd: 0,
        cacheUsd: 0,
        outputUsd: 0,
      };
      continue;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      const inp = Number(obj.input_tokens || 0);
      const cache = Number(obj.cache_read_tokens || 0);
      const out = Number(obj.output_tokens || 0);
      if (inp === 0 && cache === 0 && out === 0) continue;

      if (!current) {
        current = {
          turnIndex: turns.length + 1,
          promptPreview: '（系统 / 子代理初始任务）',
          createdAt: typeof obj.created_at === 'string' ? obj.created_at : '',
          steps: 0,
          models: new Set(),
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          inputUsd: 0,
          cacheUsd: 0,
          outputUsd: 0,
        };
      }
      const modelName = typeof obj.model === 'string' && obj.model ? obj.model : 'unknown';
      const rate = getModelRate(modelName);
      current.steps += 1;
      current.models.add(modelName);
      current.inputTokens += inp;
      current.cacheReadTokens += cache;
      current.outputTokens += out;
      current.inputUsd += (inp * rate.input) / 1_000_000;
      current.cacheUsd += (cache * rate.cache) / 1_000_000;
      current.outputUsd += (out * rate.output) / 1_000_000;
    }
  }
  flush();
  return turns;
}

export function collectTokenStats(
  range: TimeRange = '7d',
  sourceFilter: SourceFilter = 'all',
): TokenDashboardData {
  const geminiRoot = path.join(os.homedir(), '.gemini');
  const cutoffMs = getCutoffMs(range);
  const projectNames = loadProjectNames();

  const sourcesFound: string[] = [];
  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  let totalUsd = 0;
  let totalSteps = 0;
  let totalPrompts = 0;

  const dailyMap = new Map<string, DailyPoint>();
  const modelMap = new Map<
    string,
    { input: number; cache: number; output: number; usd: number; steps: number }
  >();
  const projectMap = new Map<
    string,
    {
      name: string;
      conversations: number;
      promptCount: number;
      steps: number;
      input: number;
      cache: number;
      output: number;
      usd: number;
    }
  >();
  const conversations: ConversationStat[] = [];

  for (const src of SOURCE_DIRS) {
    const baseDir = path.join(geminiRoot, src.dir);
    const brainDir = path.join(baseDir, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    sourcesFound.push(src.key);
    if (sourceFilter !== 'all' && sourceFilter !== src.key) continue;

    const metaMap = loadConversationMeta(baseDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      if (cutoffMs > 0) {
        try {
          const stat = fs.statSync(transcriptPath);
          if (stat.mtimeMs < cutoffMs) continue;
        } catch {
          continue;
        }
      }

      let raw: string;
      try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
      } catch {
        continue;
      }

      let cInput = 0;
      let cCache = 0;
      let cOutput = 0;
      let cInputUsd = 0;
      let cCacheUsd = 0;
      let cOutputUsd = 0;
      let cSteps = 0;
      let cPrompts = 0;
      let cLastActive = '';
      let cLastContext = 0;
      let firstUserPrompt = '';
      const cModelCounts = new Map<string, number>();

      for (const line of raw.split('\n')) {
        if (!line) continue;
        const isUser = line.includes('USER_INPUT');
        const isPlanner = line.includes('PLANNER_RESPONSE');
        if (!isUser && !isPlanner) continue;

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
        const withinRange =
          cutoffMs === 0 || !createdAt || Number.isNaN(Date.parse(createdAt)) || Date.parse(createdAt) >= cutoffMs;

        if (obj.type === 'USER_INPUT') {
          if (!firstUserPrompt && typeof obj.content === 'string') {
            firstUserPrompt = cleanPromptSnippet(obj.content, 60);
          }
          if (withinRange) cPrompts += 1;
          continue;
        }

        if (obj.type !== 'PLANNER_RESPONSE' || !withinRange) continue;

        const inp = Number(obj.input_tokens || 0);
        const cache = Number(obj.cache_read_tokens || 0);
        const out = Number(obj.output_tokens || 0);
        if (inp === 0 && cache === 0 && out === 0) continue;

        const modelName = typeof obj.model === 'string' && obj.model ? obj.model : 'unknown';
        const rate = getModelRate(modelName);
        const stepInUsd = (inp * rate.input) / 1_000_000;
        const stepCacheUsd = (cache * rate.cache) / 1_000_000;
        const stepOutUsd = (out * rate.output) / 1_000_000;
        const stepUsd = stepInUsd + stepCacheUsd + stepOutUsd;

        cInput += inp;
        cCache += cache;
        cOutput += out;
        cInputUsd += stepInUsd;
        cCacheUsd += stepCacheUsd;
        cOutputUsd += stepOutUsd;
        cSteps += 1;
        cModelCounts.set(modelName, (cModelCounts.get(modelName) || 0) + 1);
        if (!cLastActive || createdAt >= cLastActive) {
          cLastActive = createdAt;
          cLastContext = inp + cache;
        }

        totalInput += inp;
        totalCache += cache;
        totalOutput += out;
        totalUsd += stepUsd;
        totalSteps += 1;

        if (createdAt) {
          const dateKey = toLocalDateKey(createdAt);
          let day = dailyMap.get(dateKey);
          if (!day) {
            day = { date: dateKey, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedUsd: 0, steps: 0 };
            dailyMap.set(dateKey, day);
          }
          day.inputTokens += inp;
          day.cacheReadTokens += cache;
          day.outputTokens += out;
          day.estimatedUsd = roundUsd(day.estimatedUsd + stepUsd);
          day.steps += 1;
        }

        let m = modelMap.get(modelName);
        if (!m) {
          m = { input: 0, cache: 0, output: 0, usd: 0, steps: 0 };
          modelMap.set(modelName, m);
        }
        m.input += inp;
        m.cache += cache;
        m.output += out;
        m.usd += stepUsd;
        m.steps += 1;
      }

      if (cSteps > 0) {
        const meta = metaMap.get(convId);
        const parentMeta = meta?.parentId ? metaMap.get(meta.parentId) : undefined;
        const isSubagent = Boolean(meta?.parentId);

        // Resolve clean human-readable title (never bare hex UUID if avoidable)
        let title = meta?.title || meta?.preview || '';
        if (!title && isSubagent) {
          const parentTitle = parentMeta?.title || parentMeta?.preview || '';
          const role = meta?.agentName ? `子代理·${meta.agentName}` : '子代理';
          title = parentTitle
            ? `[${role}] ${parentTitle}`
            : firstUserPrompt
              ? `[${role}] ${firstUserPrompt}`
              : `[${role}] 后台任务`;
        }
        if (!title) {
          title = firstUserPrompt || `未命名对话 (${convId.slice(0, 6)})`;
        }

        // Resolve Project ID & human-readable Project Name
        const effectiveProjectId =
          meta?.projectId ||
          parentMeta?.projectId ||
          (src.key === 'cli' ? 'default-cli-project' : '__unassigned__');
        const effectiveProjectName =
          projectNames.get(effectiveProjectId) ||
          meta?.workspaceName ||
          parentMeta?.workspaceName ||
          (effectiveProjectId === 'default-cli-project' ? 'CLI 默认项目' : '无项目 / 临时对话');

        const promptCount = Math.max(1, cPrompts);
        totalPrompts += promptCount;

        const cTotal = cInput + cCache + cOutput;
        const cPromptTotal = cInput + cCache;
        const cUsd = roundUsd(cInputUsd + cCacheUsd + cOutputUsd);

        let primaryModel = 'unknown';
        let bestCount = -1;
        for (const [mName, cnt] of cModelCounts.entries()) {
          if (cnt > bestCount) {
            bestCount = cnt;
            primaryModel = mName;
          }
        }

        let proj = projectMap.get(effectiveProjectId);
        if (!proj) {
          proj = {
            name: effectiveProjectName,
            conversations: 0,
            promptCount: 0,
            steps: 0,
            input: 0,
            cache: 0,
            output: 0,
            usd: 0,
          };
          projectMap.set(effectiveProjectId, proj);
        }
        proj.conversations += 1;
        proj.promptCount += promptCount;
        proj.steps += cSteps;
        proj.input += cInput;
        proj.cache += cCache;
        proj.output += cOutput;
        proj.usd += cUsd;

        conversations.push({
          id: convId,
          title,
          source: src.key,
          projectId: effectiveProjectId,
          projectName: effectiveProjectName,
          isSubagent,
          primaryModel,
          lastActive: cLastActive,
          promptCount,
          avgPromptUsd: roundUsd(cUsd / promptCount),
          steps: cSteps,
          currentContextTokens: cLastContext,
          inputTokens: cInput,
          cacheReadTokens: cCache,
          outputTokens: cOutput,
          totalTokens: cTotal,
          cacheHitRate: cPromptTotal > 0 ? Math.round((cCache / cPromptTotal) * 1000) / 10 : 0,
          inputUsd: roundUsd(cInputUsd),
          cacheUsd: roundUsd(cCacheUsd),
          outputUsd: roundUsd(cOutputUsd),
          estimatedUsd: cUsd,
        });
      }
    }
  }

  const grandTotal = totalInput + totalCache + totalOutput;
  const promptTotal = totalInput + totalCache;

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-31);

  const projects: ProjectStat[] = [...projectMap.entries()]
    .map(([projectId, p]) => {
      const total = p.input + p.cache + p.output;
      return {
        projectId,
        projectName: p.name,
        conversations: p.conversations,
        promptCount: p.promptCount,
        steps: p.steps,
        inputTokens: p.input,
        cacheReadTokens: p.cache,
        outputTokens: p.output,
        totalTokens: total,
        estimatedUsd: roundUsd(p.usd),
        share: totalUsd > 0 ? Math.round((p.usd / totalUsd) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd);

  const models: ModelStat[] = [...modelMap.entries()]
    .map(([model, m]) => {
      const total = m.input + m.cache + m.output;
      return {
        model,
        inputTokens: m.input,
        cacheReadTokens: m.cache,
        outputTokens: m.output,
        totalTokens: total,
        estimatedUsd: roundUsd(m.usd),
        steps: m.steps,
        share: grandTotal > 0 ? Math.round((total / grandTotal) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd);

  conversations.sort((a, b) => b.lastActive.localeCompare(a.lastActive));

  return {
    range,
    source: sourceFilter,
    generatedAt: new Date().toISOString(),
    sourcesFound,
    totals: {
      inputTokens: totalInput,
      cacheReadTokens: totalCache,
      outputTokens: totalOutput,
      totalTokens: grandTotal,
      cacheHitRate: promptTotal > 0 ? Math.round((totalCache / promptTotal) * 1000) / 10 : 0,
      estimatedUsd: roundUsd(totalUsd),
      promptCount: totalPrompts,
      avgPromptUsd: totalPrompts > 0 ? roundUsd(totalUsd / totalPrompts) : 0,
      steps: totalSteps,
      conversations: conversations.length,
    },
    daily,
    projects,
    models,
    conversations: conversations.slice(0, 120),
    rtk: collectRtkStats(),
  };
}
