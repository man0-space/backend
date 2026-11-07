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

function frontierBucketRank(item: EntryItem): number {
  const groups = item.groups ?? [];
  for (let i = 0; i < FRONTIER_TYPE_ORDER.length; i += 1) {
    if (groups.includes(FRONTIER_TYPE_ORDER[i]!)) return i;
  }
  return FRONTIER_TYPE_ORDER.length;
}

function sortModelEntries(entries: EntryItem[]): EntryItem[] {
  const familyCounts = new Map<string, number>();
  for (const item of entries) {
    const fam = item.family || 'other';
    familyCounts.set(fam, (familyCounts.get(fam) ?? 0) + 1);
  }

  const frontier: EntryItem[] = [];
  const latest: EntryItem[] = [];
  const rest: EntryItem[] = [];

  for (const item of entries) {
    if (item.isFrontier) frontier.push(item);
    else if (item.isLatest) latest.push(item);
    else rest.push(item);
  }

  const byFrontierType = (a: EntryItem, b: EntryItem) =>
    frontierBucketRank(a) - frontierBucketRank(b);

  frontier.sort(byFrontierType);
  latest.sort(byFrontierType);
  rest.sort(
    (a, b) =>
      (familyCounts.get(b.family || 'other') ?? 0) -
      (familyCounts.get(a.family || 'other') ?? 0),
  );

  return [...frontier, ...latest, ...rest];
}

async function fetchModelIndexOverlay(): Promise<Map<string, ModelIndexRow>> {
  const healthRes = await sdk.fetch(`${MODELS_INDEX_ORIGIN}/health`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!healthRes.ok) {
    throw Object.assign(new Error('The model catalog index health check failed.'), {
      statusCode: 502,
    });
  }
  const health = (await healthRes.json()) as ModelIndexHealth;
  if (typeof health.version !== 'string' || !health.version) {
    throw Object.assign(new Error('Invalid model catalog index version.'), { statusCode: 502 });
  }

  const indexUrl = new URL(`${MODELS_INDEX_ORIGIN}/index`);
  indexUrl.searchParams.set('version', health.version);
  const indexRes = await sdk.fetch(indexUrl, { signal: AbortSignal.timeout(20000) });
  if (!indexRes.ok) {
    throw Object.assign(new Error('The model catalog index is unavailable.'), { statusCode: 502 });
  }
  const indexBody = (await indexRes.json()) as { data?: ModelIndexRow[] };
  if (!Array.isArray(indexBody.data)) {
    throw Object.assign(new Error('Invalid model catalog index response.'), { statusCode: 502 });
  }

  const map = new Map<string, ModelIndexRow>();
  for (const row of indexBody.data) {
    if (!row.modelId) continue;
    const key = row.modelId.trim().toLowerCase();
    const existing = map.get(key);
    map.set(key, {
      modelId: row.modelId,
      provider: row.provider ?? existing?.provider,
      family: row.family ?? existing?.family,
      isFrontier: Boolean(row.isFrontier || existing?.isFrontier),
      isLatest: Boolean(row.isLatest || existing?.isLatest),
    });
  }
  return map;
}

async function fetchModelCatalog(): Promise<EntryItem[]> {
  const [listRes, indexOverlay] = await Promise.all([
    sdk.models.listAll(),
    fetchModelIndexOverlay(),
  ]);

  const models = (Array.isArray(listRes?.data) ? listRes.data : []) as SdkCatalogModel[];
  if (models.length === 0) {
    throw Object.assign(new Error('Invalid model catalog response.'), { statusCode: 502 });
  }

  const entries: EntryItem[] = [];
  for (const model of models) {
    if (!model.modelId) continue;
    const overlay = indexOverlay.get(model.modelId.trim().toLowerCase());
    const rawTypes = (
      Array.isArray(model.type) ? model.type : model.type ? [model.type] : []
    )
      .map(value => (typeof value === 'string' ? normalizeSlug(value) : ''))
      .filter(Boolean);

    const primaryBuckets: string[] = [];
    const otherTypes: string[] = [];
    for (const t of rawTypes) {
      const mapped = PRIMARY_TYPE_TO_GROUP[t];
      if (mapped) {
        if (!primaryBuckets.includes(mapped)) primaryBuckets.push(mapped);
      } else if (!otherTypes.includes(t)) {
        otherTypes.push(t);
      }
    }

    const groups = primaryBuckets.length > 0 ? primaryBuckets : ['others'];
    const subgroups: string[] = [];

    if (groups.includes('others')) {
      for (const t of otherTypes.length > 0 ? otherTypes : ['custom']) {
        subgroups.push(`others/${t}`);
      }
    }

    for (const bucket of primaryBuckets) {
      for (const op of model.operations ?? []) {
        if (!op?.operation) continue;
        const opSlug = normalizeSlug(op.operation);
        if (opSlug) subgroups.push(`${bucket}/${opSlug}`);
      }
    }

    const family = (model.family || overlay?.family || model.provider || 'other')
      .trim()
      .toLowerCase();
    const modality = rawTypes[0];

    const item = toEntry({
      id: model.modelId,
      name: model.name || model.modelId,
      description: model.description ?? '',
      kind: 'model',
      groups,
      subgroups,
      modality,
      family,
      isFrontier: Boolean(model.isFrontier || overlay?.isFrontier),
      isLatest: Boolean(model.isLatest || overlay?.isLatest),
      input: model.input,
      output: model.output,
      type: model.type ?? undefined,
      operations: model.operations,
    });
    if (item) entries.push(item);
  }

  const deduped = [...new Map(entries.map(item => [item.id, item])).values()];
  return sortModelEntries(deduped);
}
