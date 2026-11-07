import {
  ComposeSDK,
  type AccountToolkit,
  type McpServerSummary,
  type Model,
} from '@compose-market/sdk';
import { z } from 'zod';
import { config } from './config.js';
import { kind, entry } from './schema.js';
import { cached, cacheDel } from './databases/cache.js';

type EntryItem = z.infer<typeof entry>;
type Role = z.infer<typeof kind>;

type SdkCatalogModel = Model & {
  family?: string;
  isFrontier?: boolean;
  isLatest?: boolean;
};

interface ModelIndexHealth {
  models?: number;
  version?: string;
}

interface ModelIndexRow {
  modelId?: string;
  provider?: string;
  family?: string;
  isFrontier?: boolean;
  isLatest?: boolean;
}

const sdk = new ComposeSDK({ baseUrl: config.composeApiUrl, retry: { maxRetries: 0 } });

const MODELS_INDEX_ORIGIN = 'https://models.compose.market';
const CACHE_PREFIX = 'catalog';
const PAGE_LIMIT = 200;
const MCP_CONCURRENCY = 8;

const PRIMARY_TYPE_TO_GROUP: Record<string, string> = {
  'text-generation': 'text',
  'image-generation': 'image',
  'video-generation': 'video',
  'music-generation': 'music',
  embeddings: 'embeddings',
};

const FRONTIER_TYPE_ORDER = ['text', 'image', 'video', 'music'] as const;

const nearIntentsConnector = entry.parse({
  id: 'near-intents',
  name: 'NEAR Intents',
  description:
    'Cross-chain token quotes, swaps, and multi-chain settlements across all NEAR Intents networks.',
  kind: 'connector',
  groups: ['onchain'],
});

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function sanitizeStringList(raw: unknown, maxLen: number, maxItems: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .map(item => (typeof item === 'string' ? item.trim().slice(0, maxLen) : ''))
    .filter(Boolean)
    .slice(0, maxItems);
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function sanitizeLogo(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1024 || !/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

function toEntry(input: {
  id: unknown;
  name: unknown;
  description?: unknown;
  kind: Role;
  groups?: unknown;
  subgroups?: unknown;
  modality?: unknown;
  family?: unknown;
  isFrontier?: unknown;
  isLatest?: unknown;
  logo?: unknown;
  input?: unknown;
  output?: unknown;
  type?: unknown;
  operations?: unknown;
}): EntryItem | null {
  const id = typeof input.id === 'string' ? input.id.trim().slice(0, 512) : '';
  if (!id) return null;
  const nameRaw = typeof input.name === 'string' ? input.name.trim() : '';
  const name = (nameRaw || id).slice(0, 200);
  const description =
    typeof input.description === 'string' ? input.description.slice(0, 10000) : '';
  const groups = sanitizeStringList(input.groups, 80, 16);
  const subgroups = sanitizeStringList(input.subgroups, 120, 24);
  const modality =
    typeof input.modality === 'string' && input.modality.trim()
      ? input.modality.trim().toLowerCase().slice(0, 80)
      : undefined;
  const family =
    typeof input.family === 'string' && input.family.trim()
      ? input.family.trim().toLowerCase().slice(0, 80)
      : undefined;
  const isFrontier = input.isFrontier === true ? true : undefined;
  const isLatest = input.isLatest === true ? true : undefined;
  const logo = sanitizeLogo(input.logo);

  const baseCandidate = {
    id,
    name,
    description,
    kind: input.kind,
    ...(groups ? { groups } : {}),
    ...(subgroups ? { subgroups } : {}),
    ...(modality ? { modality } : {}),
    ...(family ? { family } : {}),
    ...(isFrontier ? { isFrontier } : {}),
    ...(isLatest ? { isLatest } : {}),
    ...(logo ? { logo } : {}),
    ...(Array.isArray(input.input) ? { input: input.input } : {}),
    ...(Array.isArray(input.output) ? { output: input.output } : {}),
    ...(typeof input.type === 'string' || Array.isArray(input.type) ? { type: input.type } : {}),
    ...(Array.isArray(input.operations) ? { operations: input.operations } : {}),
  };

  const parsed = entry.safeParse(baseCandidate);
  if (parsed.success) return parsed.data;

  const { operations: _ops, ...withoutOps } = baseCandidate;
  const fallback = entry.safeParse(withoutOps);
  return fallback.success ? fallback.data : null;
}
