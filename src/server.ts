import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  collectConversationTurns,
  collectTokenStats,
  type SourceFilter,
  type TimeRange,
} from './collector.js';

const APP_URI = 'ui://token-meter/app.html';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readAppHtml(): string {
  const htmlPath = process.env.TOKEN_METER_APP_HTML || path.join(__dirname, 'app.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const server = new McpServer({
  name: 'token-meter',
  version: '0.3.0',
});

server.registerResource(
  'token-meter-app',
  APP_URI,
  {
    title: 'Token Meter Dashboard',
    description: 'Interactive local token usage dashboard for Antigravity',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: readAppHtml(),
      },
    ],
  }),
);

const querySchema = {
  range: z.enum(['today', '7d', '30d', 'all']).optional().describe('Time range filter (default: 7d)'),
  source: z.enum(['all', 'desktop', 'cli', 'ide']).optional().describe('Antigravity surface filter (default: all)'),
};

server.registerTool(
  'open_token_meter',
  {
    title: 'Token Meter',
    description:
      'Open the interactive Token Meter dashboard showing local Antigravity token usage by project, conversation, and individual prompt turn.',
    inputSchema: querySchema,
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Token Meter' },
          { type: 'global', title: 'Token Meter' },
        ],
      },
    },
  },
  async (args) => {
    const range = (args?.range ?? '7d') as TimeRange;
    const source = (args?.source ?? 'all') as SourceFilter;
    const data = collectTokenStats(range, source);
    const t = data.totals;
    const summary = [
      `Token Meter (${range}, source: ${source}):`,
      `Est. API Cost $${t.estimatedUsd.toFixed(2)} (${t.promptCount} prompts, avg $${t.avgPromptUsd.toFixed(2)}/prompt) |`,
      `Total ${formatCompact(t.totalTokens)} tokens across ${data.projects.length} projects & ${t.conversations} conversations.`,
    ].join(' ');
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: data as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  'get_token_stats',
  {
    title: 'Get Token Stats',
    description: 'App-only tool for refreshing and filtering Token Meter statistics.',
    inputSchema: querySchema,
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args) => {
    const range = (args?.range ?? '7d') as TimeRange;
    const source = (args?.source ?? 'all') as SourceFilter;
    const data = collectTokenStats(range, source);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: data as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  'get_conversation_turns',
  {
    title: 'Get Conversation Turns',
    description: 'App-only tool that returns per-prompt turn token usage and cost breakdown for a single conversation.',
    inputSchema: {
      id: z.string().min(1).describe('Conversation ID'),
      source: z.enum(['desktop', 'cli', 'ide']).optional().describe('Conversation source surface'),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args) => {
    const turns = collectConversationTurns(args.id, args.source ?? 'desktop');
    return {
      content: [{ type: 'text', text: `${turns.length} turns` }],
      structuredContent: { id: args.id, turns } as unknown as Record<string, unknown>,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
