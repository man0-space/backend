import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { z } from 'zod';
import { config } from '../config.js';
import { catalog, sdk } from '../catalog.js';
import { MAX_TASK_TAGS, TASK_CATEGORIES, resolveCanonicalTasks } from '../options.js';
import { generateBanner, type MediaLogoHint } from './media.js';
import * as coordinators from '../databases/coordinators.js';
import { entry, type Coordinator, type Flow, type block, type link } from '../schema.js';

export const VIBE_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const NEBIUS_CHAT_URL = 'https://api.studio.nebius.com/v1/chat/completions';
export const COMPOSE_ROUTES_QUERY_URL = 'https://routes.compose.market/query';
export const COMPOSE_MODELS_ORIGIN = 'https://models.compose.market';
export const COMPOSE_CONNECTORS_ORIGIN = 'https://connectors.compose.market';
export const COMPOSE_AGENTS_ORIGIN = 'https://agents.compose.market';

type CatalogEntry = z.infer<typeof entry>;
type FlowBlock = z.infer<typeof block>;
type FlowLink = z.infer<typeof link>;
type Direction = 'right' | 'left' | 'up' | 'down';

export type VibePatch =
  | { op: 'set_title'; name: string }
  | { op: 'set_description'; brief: string }
  | { op: 'set_categories'; tasks: string[] }
  | { op: 'set_coordinator'; coordinator: Coordinator | null }
  | { op: 'set_banner'; banner: string }
  | { op: 'add_step'; node: FlowBlock; edge?: FlowLink }
  | { op: 'update_step'; stepId: string; label?: string; note?: string; entry?: CatalogEntry }
  | { op: 'connect_steps'; edge: FlowLink }
  | { op: 'remove_step'; stepId: string }
  | { op: 'arrange_canvas'; positions: Record<string, { x: number; y: number }> };

export type VibeStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'patch'; patch: VibePatch }
  | { type: 'banner_start' }
  | { type: 'workflow_ready'; text: string; flow: Flow }
  | { type: 'done'; text: string; flow: Flow }
  | { type: 'error'; error: string };

interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface VibeLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface VibeDeps {
  fetchImpl?: typeof fetch;
  catalogLoader?: (role: string) => Promise<CatalogEntry[]>;
  bannerGenerator?: (input: {
    title?: string;
    description?: string;
    logos?: MediaLogoHint[];
  }) => Promise<{
    imageUrl: string;
    cid: string;
  }>;
  coordinatorsLoader?: (userAddress: string) => Promise<Coordinator[]>;
  logger?: VibeLogger;
}

const STEP_DX = 360;
const STEP_DY = 220;

const FRONTIER_MODALITIES = new Set([
  'text-generation',
  'image-generation',
  'video-generation',
  'music-generation',
]);

const MODALITY_TO_GROUP: Record<string, string> = {
  'text-generation': 'text',
  'image-generation': 'image',
  'video-generation': 'video',
  'music-generation': 'music',
  embeddings: 'embeddings',
};

function getCategoriesLibraryContext(): string {
  return [
    `# man0 Workflow Categories Library`,
    `Every workflow selects between 1 and ${MAX_TASK_TAGS} canonical task tags from the groups below:`,
    ...TASK_CATEGORIES.map(
      group =>
        `## ${group.label} (${group.desc})\n` +
        group.tags.map(tag => `- "${tag.id}": ${tag.desc}`).join('\n'),
    ),
    `Rules:`,
    `- Pick only exact tag IDs from the list above (maximum ${MAX_TASK_TAGS}).`,
    `- Use "DeFi Execution" whenever NEAR Intents, cross-chain swaps, or on-chain connectors are involved.`,
    `- Use "Research" or "Market Intelligence" for synthesis, web/MCP data gathering, or market analysis.`,
    `- Use "Code Generation", "Code Review", or "Security Audit" for engineering workflows.`,
  ].join('\n');
}

function getDagLibraryContext(): string {
  return [
    `# man0 Directed Acyclic Graph (DAG) Architecture Library`,
    `1. Acyclicity: Every workflow is a strict DAG. Never create a cycle (A -> B -> A).`,
    `2. Semantic Catalog Discovery (Cloudflare Workers):`,
    `   - Use query_catalog(query) for cross-domain route hints across models, connectors, and agents.`,
    `   - Use models_find(query, modality?) to semantically search models.compose.market — always prefer isFrontier: true (or isLatest: true) models for text reasoning, creative writing, code, image, video, and music steps; use top high-score specialized models for speech/ASR or embeddings.`,
    `   - Use connectors_find(query) to semantically search connectors.compose.market across Accounts ("account:<slug>"), verified MCP servers ("<slug>"), onchain protocols ("onchain:<slug>"), and "near-intents".`,
    `   - Use agent_find(query) when the workflow delegates to a registered specialist agent.`,
    `3. Step Handoff Contracts ("note"):`,
    `   - Every step's "note" is its execution prompt/instruction receiving upstream step outputs.`,
    `   - Write concrete, actionable instructions specifying what data to extract, transform, or execute and what structured output to pass downstream.`,
    `4. Multi-Step Canvas Wiring:`,
    `   - Give each add_step a short symbolic stepId (e.g. "step_1", "step_2", "step_3", "step_4") so you can add ALL steps of the workflow in a single batch and reference upstream steps via anchorId!`,
    `   - Sequential pipeline: pass anchorId="<previous_stepId>" and direction="right" (connectFromAnchor=true).`,
    `   - Parallel fan-out waves: place parallel sibling branches with direction="down" or direction="up" from the first branch step and connect each from the shared upstream anchor via anchorId or connect_steps, then fan-in to a downstream synthesis step.`,
    `5. Workflow Overview (Natural User-Facing Copy):`,
    `   - Always call set_title, set_description, and set_categories.`,
    `   - Title: Write a clean, natural, user-facing title (2-5 words, e.g. "Voice Notes to Fiction Stories", "Competitor Launch Digest"). NEVER use arrows (→ / ->), colons with step lists, "Pipeline", "DAG", or technical jargon.`,
    `   - Description: Write 1-2 natural, engaging user-facing sentences in plain English explaining what the user puts in and what they get out. NEVER use arrows (→ / ->), bullet dumps, model IDs, or jargon like "frontier LLM", "DAG", or "MCP".`,
    `   - Workflow banner art (featuring the title and step logos) is generated automatically in the background once your overview and steps are set.`,
    `6. Coordinator Persona:`,
    `   - If the creator has saved Coordinator Personas (via list_coordinators) and asks for autonomous coordination or multi-branch supervision, attach one via set_coordinator; otherwise leave coordinator unset unless requested.`,
  ].join('\n');
}

const VIBE_SYSTEM_PROMPT = `You are Vibe, the workflow architect inside man0 Studio.
Your job is to design, refine, and wire complete, executable multi-step workflows on the man0 Canvas and populate the Workflow Overview side panel in real time.

Operating Rules:
1. Before choosing categories or designing a workflow, call read_categories_library and read_dag_library, plus all needed discovery calls (models_find, connectors_find, agent_find, or query_catalog) in parallel so you discover real entries for EVERY step in the user's request.
2. NEVER invent fake model, connector, or agent IDs, and NEVER stop after adding only the first step — build EVERY step required to fulfill the entire prompt end-to-end.
3. When selecting models from models_find, ALWAYS prioritize entries marked isFrontier: true (or isLatest: true when no frontier model exists for specialized modalities like speech transcription or embeddings).
4. Populate BOTH the Workflow Overview (set_title, set_description, set_categories) AND all Canvas steps (add_step with symbolic stepId + anchorId so every step is added and connected).
5. Write normal, natural, user-facing titles and descriptions for end users — NEVER use robotic arrows (→ / ->), colons with step lists, "Pipeline", "DAG", model IDs, or internal jargon like "frontier LLM" or "MCP", and never mention model hosting providers.
6. Keep your final chat summary natural and concise (2-3 sentences).`;

const VIBE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_categories_library',
      description: 'Read canonical man0 workflow task categories and selection rules.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_dag_library',
      description:
        'Read man0 workflow DAG architecture patterns, worker discovery rules, directional Canvas layout rules, and step handoff conventions.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_catalog',
      description:
        'Cross-domain semantic route lookup. Routes distilled task topics to models_find, connectors_find, or agent_find.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Distilled capability or tool topic, e.g. "speech transcription", "notion", "near intents swap".',
          },
          kind: {
            type: 'string',
            enum: ['model', 'connector', 'agent'],
            description: 'Optional domain hint; if set, also runs the matching domain worker search directly.',
          },
          limit: {
            type: 'number',
            description: 'Max candidates to return (1-8, default 6).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'models_find',
      description:
        'Semantic model search prioritized by isFrontier and isLatest.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Model capability query, e.g. "frontier creative story writing", "speech to text transcription", "book cover illustration".',
          },
          modality: {
            type: 'string',
            enum: [
              'text-generation',
              'image-generation',
              'video-generation',
              'music-generation',
              'speech',
              'embeddings',
            ],
            description: 'Optional modality filter.',
          },
          limit: {
            type: 'number',
            description: 'Max models to return (1-8, default 6).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connectors_find',
      description:
        'Semantic connector search via connectors.compose.market across Accounts (account:<slug>), verified MCP servers (<slug>), onchain protocols (onchain:<slug>), and near-intents.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Connector or integration query, e.g. "notion", "github", "slack", "near intents swap", "coingecko".',
          },
          limit: {
            type: 'number',
            description: 'Max connectors to return (1-8, default 6).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_find',
      description:
        'Semantic specialist agent search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Agent expertise query.',
          },
          role: {
            type: 'string',
            enum: ['executor', 'coordinator'],
            description: 'Optional agent role filter (default "executor").',
          },
          limit: {
            type: 'number',
            description: 'Max agents to return (1-6, default 5).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_connector',
      description: 'Inspect available tools/actions and auth requirements of a specific connector entry ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact connector entry ID from connectors_find.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_coordinators',
      description: 'List the signed-in creator’s saved Coordinator Personas.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_title',
      description: 'Set a clean, natural, user-facing workflow title in the Studio Overview panel.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Natural user-facing workflow title (2-5 words, e.g. "Voice Notes to Fiction Stories"). Never use arrows (→), colons with step lists, or "Pipeline".',
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_description',
      description: 'Set a natural, user-facing workflow description in the Studio Overview panel.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Plain, engaging user-facing summary (1-2 sentences) describing what the workflow does for the user. Never use arrows (→), model IDs, or technical jargon.',
          },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_categories',
      description: 'Set 1 to 3 canonical task categories in the Studio Overview panel.',
      parameters: {
        type: 'object',
        properties: {
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: '1 to 3 canonical category names from read_categories_library.',
          },
        },
        required: ['categories'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_coordinator',
      description: 'Attach one of the creator’s saved Coordinator Personas by ID, or pass null to clear.',
      parameters: {
        type: 'object',
        properties: {
          coordinatorId: {
            type: ['string', 'null'],
            description: 'Saved Coordinator Persona ID from list_coordinators, or null.',
          },
        },
        required: ['coordinatorId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_banner',
      description:
        'Generate or regenerate a branded man0 workflow banner image using the workflow title and description.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_step',
      description:
        'Add a step node onto the Canvas with a verified catalog entry and directional wire. Pass a symbolic stepId (e.g. "step_1", "step_2") so multiple add_step calls in the same turn can chain via anchorId.',
      parameters: {
        type: 'object',
        properties: {
          stepId: {
            type: 'string',
            description: 'Optional symbolic alias (e.g. "step_1", "transcribe", "save_notion") to reference in anchorId or connect_steps within the same turn.',
          },
          label: { type: 'string', description: 'Short human-readable step title (2-4 words).' },
          kind: { type: 'string', enum: ['model', 'connector', 'agent'] },
          entryId: {
            type: 'string',
            description: 'Exact catalog entry id returned by models_find, connectors_find, or agent_find.',
          },
          note: {
            type: 'string',
            description: 'Detailed execution instructions / handoff prompt for this step.',
          },
          anchorId: {
            type: 'string',
            description: 'Upstream step ID or symbolic stepId to position relative to and connect from.',
          },
          direction: {
            type: 'string',
            enum: ['right', 'left', 'up', 'down'],
            description: 'Placement direction relative to anchorId (default "right").',
          },
          connectFromAnchor: {
            type: 'boolean',
            description: 'If true (default), creates a directed wire from anchorId (or previous step) into this step.',
          },
        },
        required: ['label', 'kind', 'entryId', 'note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_step',
      description: 'Update an existing Canvas step’s label, note, or assigned catalog entry.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          label: { type: 'string' },
          note: { type: 'string' },
          kind: { type: 'string', enum: ['model', 'connector', 'agent'] },
          entryId: { type: 'string' },
        },
        required: ['stepId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_steps',
      description: 'Connect sourceId -> targetId on the Canvas (must preserve DAG acyclicity).',
      parameters: {
        type: 'object',
        properties: {
          sourceId: { type: 'string' },
          targetId: { type: 'string' },
        },
        required: ['sourceId', 'targetId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_step',
      description: 'Remove a step and its incident edges from the Canvas.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
        },
        required: ['stepId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'arrange_canvas',
      description: 'Arrange all Canvas steps into clean left-to-right topological DAG waves.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
] as const;

function makeWireEdge(source: string, target: string): FlowLink {
  return {
    id: `wire-${source}-${target}`,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    type: 'wire',
  };
}

function wouldCreateCycle(nodes: FlowBlock[], edges: FlowLink[], source: string, target: string): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
  }
  adj.get(source)?.push(target);

  const visited = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of adj.get(cur) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

function computeDirectionalPosition(
  nodes: FlowBlock[],
  anchorId?: string,
  direction: Direction = 'right',
): { x: number; y: number } {
  const anchor = anchorId ? nodes.find(n => n.id === anchorId) : nodes[nodes.length - 1];
  let x = 100;
  let y = 140;
  if (anchor) {
    switch (direction) {
      case 'right':
        x = anchor.position.x + STEP_DX;
        y = anchor.position.y;
        break;
      case 'left':
        x = Math.max(20, anchor.position.x - STEP_DX);
        y = anchor.position.y;
        break;
      case 'down':
        x = anchor.position.x;
        y = anchor.position.y + STEP_DY;
        break;
      case 'up':
        x = anchor.position.x;
        y = anchor.position.y - STEP_DY;
        break;
    }
  }

  const dy = direction === 'up' ? -STEP_DY : STEP_DY;
  while (
    nodes.some(
      n => Math.abs(n.position.x - x) < STEP_DX * 0.75 && Math.abs(n.position.y - y) < STEP_DY * 0.75,
    )
  ) {
    y += dy;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function computeWaveLayout(nodes: FlowBlock[], edges: FlowLink[]): Record<string, { x: number; y: number }> {
  const inDeg = new Map<string, number>(nodes.map(n => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    if (adj.has(e.source) && inDeg.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }
  }

  const waveOf = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) {
      waveOf.set(n.id, 0);
      queue.push(n.id);
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curWave = waveOf.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      waveOf.set(next, Math.max(waveOf.get(next) ?? 0, curWave + 1));
      const d = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  const byWave = new Map<number, FlowBlock[]>();
  for (const n of nodes) {
    const w = waveOf.get(n.id) ?? 0;
    const list = byWave.get(w) ?? [];
    list.push(n);
    byWave.set(w, list);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [wave, waveNodes] of [...byWave.entries()].sort(([a], [b]) => a - b)) {
    const offsetY = -((waveNodes.length - 1) * STEP_DY) / 2;
    waveNodes.forEach((n, idx) => {
      positions[n.id] = {
        x: Math.round(100 + wave * STEP_DX),
        y: Math.round(180 + offsetY + idx * STEP_DY),
      };
    });
  }
  return positions;
}

function normalizeConnectorEntryId(raw: string): string {
  const trimmed = raw.trim();
  if (/^mcp:/i.test(trimmed)) return trimmed.slice(4).trim();
  if (/^account:/i.test(trimmed)) return `account:${trimmed.slice(8).trim().toLowerCase()}`;
  if (/^onchain:/i.test(trimmed)) return `onchain:${trimmed.slice(8).trim().toLowerCase()}`;
  return trimmed;
}

function isNearIntentsQuery(query: string): boolean {
  return /\b(near\s*intents?|1click|cross[-\s]?chain|swap|bridge|defi|usdc|token\s+swap)\b/i.test(query);
}

function inferRequestedModality(query: string, explicitModality?: string): string | undefined {
  if (explicitModality && explicitModality.trim()) return explicitModality.trim().toLowerCase();
  const q = query.toLowerCase();
  if (/\b(transcrib|speech[-\s]?to[-\s]?text|asr|voice\s+note|audio\s+to\s+text|whisper|dictat)\b/.test(q)) {
    return 'speech';
  }
  if (/\b(embed|embedding|vector\s+index)\b/.test(q)) {
    return 'embeddings';
  }
  if (/\b(cover\s+art|book\s+cover|illustration|generate\s+image|image\s+generation|text[-\s]?to[-\s]?image|poster|artwork|thumbnail|visual)\b/.test(q)) {
    return 'image-generation';
  }
  if (/\b(generate\s+video|video\s+generation|text[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video|animation\s+clip)\b/.test(q)) {
    return 'video-generation';
  }
  if (/\b(generate\s+music|music\s+generation|song\s+generation|soundtrack|text[-\s]?to[-\s]?audio)\b/.test(q)) {
    return 'music-generation';
  }
  return undefined;
}

function buildModelCatalogEntryFromWorkerRow(
  row: Record<string, unknown>,
  existing?: CatalogEntry,
): CatalogEntry | null {
  if (existing) return existing;
  const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : '';
  if (!modelId) return null;
  const rawTypes = Array.isArray(row.type)
    ? row.type.filter((t): t is string => typeof t === 'string').map(t => t.trim().toLowerCase())
    : typeof row.type === 'string'
      ? [row.type.trim().toLowerCase()]
      : [];
  const modality = rawTypes[0];
  const primaryGroup = MODALITY_TO_GROUP[modality] ?? 'others';
  const subgroups = primaryGroup === 'others' ? [`others/${modality}`] : undefined;
  const family =
    typeof row.family === 'string' && row.family.trim()
      ? row.family.trim().toLowerCase()
      : undefined;
  const parsed = entry.safeParse({
    id: modelId,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : modelId,
    description: typeof row.description === 'string' ? row.description.slice(0, 10000) : '',
    kind: 'model',
    groups: [primaryGroup],
    ...(subgroups ? { subgroups } : {}),
    modality,
    ...(family ? { family } : {}),
    ...(row.isFrontier === true ? { isFrontier: true } : {}),
    ...(row.isLatest === true ? { isLatest: true } : {}),
  });
  return parsed.success ? parsed.data : null;
}

async function searchModelsWorker(
  query: string,
  options: { modality?: string; limit: number },
  loadCatalog: (role: string) => Promise<CatalogEntry[]>,
  discoveredEntries: Map<string, CatalogEntry>,
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const inferredModality = inferRequestedModality(query, options.modality);
  const catalogEntries = await loadCatalog('model').catch(() => [] as CatalogEntry[]);
  const catalogById = new Map(catalogEntries.map(item => [item.id.toLowerCase(), item]));

  const searchUrl = new URL(`${COMPOSE_MODELS_ORIGIN}/search`);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('limit', String(Math.max(20, options.limit * 4)));
  if (inferredModality && FRONTIER_MODALITIES.has(inferredModality)) {
    searchUrl.searchParams.set('modality', inferredModality);
  }

  const frontierUrl = new URL(`${COMPOSE_MODELS_ORIGIN}/models`);
  frontierUrl.searchParams.set('frontier', '1');
  frontierUrl.searchParams.set('limit', '50');

  const [searchRes, frontierRes] = await Promise.all([
    fetchImpl(searchUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null),
    fetchImpl(frontierUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null),
  ]);

  const searchBody = searchRes?.ok
    ? ((await searchRes.json().catch(() => ({}))) as {
      data?: Array<Record<string, unknown>>;
      results?: Array<Record<string, unknown>>;
    })
    : {};
  const frontierBody = frontierRes?.ok
    ? ((await frontierRes.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> })
    : {};

  const rawSearchRows = Array.isArray(searchBody.data)
    ? searchBody.data
    : Array.isArray(searchBody.results)
      ? searchBody.results
      : [];
  const rawFrontierRows = Array.isArray(frontierBody.data) ? frontierBody.data : [];

  // Determine dominant modality if not explicitly known
  let targetModality = inferredModality;
  if (!targetModality && rawSearchRows.length > 0) {
    const topRow = rawSearchRows[0]!;
    const topTypes = Array.isArray(topRow.type)
      ? topRow.type.filter((t): t is string => typeof t === 'string')
      : typeof topRow.type === 'string'
        ? [topRow.type]
        : [];
    targetModality = topTypes[0]?.toLowerCase() || 'text-generation';
  }
  if (!targetModality) targetModality = 'text-generation';

  interface Candidate {
    entry: CatalogEntry;
    score: number;
    isFrontier: boolean;
    isLatest: boolean;
    exactNameMatch: boolean;
  }

  const byModelId = new Map<string, Candidate>();
  const qNorm = query.trim().toLowerCase();

  const upsertCandidate = (row: Record<string, unknown>, baseScore: number) => {
    if (row.available === false) return;
    const rawId = typeof row.modelId === 'string' ? row.modelId.trim() : typeof row.id === 'string' ? row.id.trim() : '';
    if (!rawId) return;
    const existingCatalog = catalogById.get(rawId.toLowerCase());
    const catEntry = buildModelCatalogEntryFromWorkerRow(row, existingCatalog);
    if (!catEntry) return;

    const isFrontier = Boolean(row.isFrontier || catEntry.isFrontier);
    const isLatest = Boolean(row.isLatest || catEntry.isLatest);
    const enriched: CatalogEntry = {
      ...catEntry,
      ...(isFrontier ? { isFrontier: true } : {}),
      ...(isLatest ? { isLatest: true } : {}),
    };
    discoveredEntries.set(`model:${enriched.id.toLowerCase()}`, enriched);

    const exactNameMatch =
      qNorm.length >= 3 &&
      (enriched.id.toLowerCase() === qNorm ||
        enriched.name.toLowerCase() === qNorm ||
        qNorm.includes(enriched.id.toLowerCase()));

    const prev = byModelId.get(enriched.id.toLowerCase());
    if (!prev || baseScore > prev.score || (isFrontier && !prev.isFrontier)) {
      byModelId.set(enriched.id.toLowerCase(), {
        entry: enriched,
        score: Math.max(prev?.score ?? 0, baseScore),
        isFrontier: Boolean(isFrontier || prev?.isFrontier),
        isLatest: Boolean(isLatest || prev?.isLatest),
        exactNameMatch: Boolean(exactNameMatch || prev?.exactNameMatch),
      });
    }
  };

  for (const row of rawSearchRows) {
    const s = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0.5;
    upsertCandidate(row, s);
  }

  // For modalities covered by Frontier models (text, image, video, music), guarantee Frontier models
  // for that exact modality are included and prioritized above generic/obscure non-frontier finetunes.
  if (FRONTIER_MODALITIES.has(targetModality)) {
    const targetGroup = MODALITY_TO_GROUP[targetModality];
    for (const row of rawFrontierRows) {
      const rowTypes = Array.isArray(row.type)
        ? row.type.filter((t): t is string => typeof t === 'string').map(t => t.toLowerCase())
        : [];
      if (rowTypes.includes(targetModality)) {
        upsertCandidate(row, 0.72);
      }
    }
    // Also fallback to catalogLoader's own frontier entries for that group (e.g. in offline/mocked tests)
    for (const item of catalogEntries) {
      if (item.isFrontier && (!targetGroup || item.groups?.includes(targetGroup) || !item.groups)) {
        discoveredEntries.set(`model:${item.id.toLowerCase()}`, item);
        if (!byModelId.has(item.id.toLowerCase())) {
          byModelId.set(item.id.toLowerCase(), {
            entry: item,
            score: 0.7,
            isFrontier: true,
            isLatest: Boolean(item.isLatest),
            exactNameMatch: qNorm.includes(item.id.toLowerCase()),
          });
        }
      }
    }
  } else if (byModelId.size === 0) {
    // Fallback to catalogEntries lexical match only if worker was unreachable
    for (const item of catalogEntries) {
      const text = `${item.id} ${item.name} ${item.description} ${item.modality ?? ''}`.toLowerCase();
      if (qNorm.split(/\s+/).some(term => term.length >= 2 && text.includes(term))) {
        discoveredEntries.set(`model:${item.id.toLowerCase()}`, item);
        byModelId.set(item.id.toLowerCase(), {
          entry: item,
          score: 0.5,
          isFrontier: Boolean(item.isFrontier),
          isLatest: Boolean(item.isLatest),
          exactNameMatch: item.id.toLowerCase() === qNorm,
        });
      }
    }
  }

  const ranked = [...byModelId.values()].sort((a, b) => {
    if (a.exactNameMatch !== b.exactNameMatch) return a.exactNameMatch ? -1 : 1;
    if (a.isFrontier !== b.isFrontier) return a.isFrontier ? -1 : 1;
    if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
    return b.score - a.score;
  });

  // Diversify top frontier picks across families when scores are tied so the agent sees top options
  const diversified: Candidate[] = [];
  const seenFrontierFamily = new Set<string>();
  const deferredSameFamily: Candidate[] = [];
  for (const cand of ranked) {
    const fam = cand.entry.family || '';
    if (cand.isFrontier && !cand.exactNameMatch && fam && seenFrontierFamily.has(fam)) {
      deferredSameFamily.push(cand);
    } else {
      if (cand.isFrontier && fam) seenFrontierFamily.add(fam);
      diversified.push(cand);
    }
  }
  const finalList = [...diversified, ...deferredSameFamily].slice(0, options.limit);

  return finalList.map(({ entry: item, score, isFrontier, isLatest }) => ({
    id: item.id,
    name: item.name,
    kind: 'model',
    ...(item.family ? { family: item.family } : {}),
    ...(item.modality ? { modality: item.modality } : {}),
    ...(item.groups?.length ? { groups: item.groups } : {}),
    isFrontier,
    isLatest,
    score: Number(score.toFixed(3)),
    description: item.description.slice(0, 180),
  }));
}

async function searchConnectorsWorker(
  query: string,
  limit: number,
  loadCatalog: (role: string) => Promise<CatalogEntry[]>,
  discoveredEntries: Map<string, CatalogEntry>,
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const catalogEntries = await loadCatalog('connector').catch(() => [] as CatalogEntry[]);
  const catalogById = new Map(catalogEntries.map(item => [item.id.toLowerCase(), item]));

  const out: Array<{ entry: CatalogEntry; score: number; authType: string }> = [];
  const seen = new Set<string>();

  const pushCandidate = (catEntry: CatalogEntry, score: number, authType: string) => {
    const key = catEntry.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    discoveredEntries.set(`connector:${key}`, catEntry);
    out.push({ entry: catEntry, score, authType });
  };

  if (isNearIntentsQuery(query)) {
    const intentsEntry =
      catalogById.get('near-intents') ??
      entry.parse({
        id: 'near-intents',
        name: 'NEAR Intents',
        description:
          'Cross-chain token quotes, swaps, and multi-chain settlements across all NEAR Intents networks.',
        kind: 'connector',
        groups: ['onchain'],
      });
    pushCandidate(intentsEntry, 0.99, 'session');
  }

  const workerUrl = new URL(`${COMPOSE_CONNECTORS_ORIGIN}/`);
  workerUrl.searchParams.set('q', query);
  workerUrl.searchParams.set('limit', String(Math.max(8, limit * 2)));

  const res = await fetchImpl(workerUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (res?.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      accounts?: { toolkits?: Array<Record<string, unknown>> };
      onchain?: { connectors?: Array<Record<string, unknown>> };
      mcps?: { servers?: Array<Record<string, unknown>> };
    };

    const qWords = new Set(query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    for (const item of catalogEntries) {
      if (item.id.startsWith('account:') && !item.id.endsWith('_mcp')) {
        const baseSlug = item.id.slice(8).toLowerCase();
        if (baseSlug.length >= 3 && qWords.has(baseSlug)) {
          pushCandidate(item, 0.98, 'composio_oauth');
        }
      }
    }

    for (const tk of body.accounts?.toolkits ?? []) {
      const slug = typeof tk.slug === 'string' ? tk.slug.trim().toLowerCase() : '';
      if (!slug) continue;
      if (slug.endsWith('_mcp')) {
        const canonical = catalogById.get(`account:${slug.slice(0, -4)}`);
        if (canonical) pushCandidate(canonical, 0.98, 'composio_oauth');
      }
      const id = `account:${slug}`;
      const catEntry =
        catalogById.get(id) ??
        entry.parse({
          id,
          name: typeof tk.name === 'string' && tk.name.trim() ? tk.name.trim() : slug,
          description: typeof tk.description === 'string' ? tk.description.slice(0, 10000) : '',
          kind: 'connector',
          groups: ['accounts'],
          ...(typeof tk.logo === 'string' && /^https?:\/\//i.test(tk.logo) ? { logo: tk.logo } : {}),
        });
      const qLowerClean = query.trim().toLowerCase();
      const isMcpWrapperToolkit = slug.endsWith('_mcp');
      const score = isMcpWrapperToolkit
        ? 0.72
        : slug === qLowerClean
          ? 0.98
          : qLowerClean.includes(slug)
            ? 0.95
            : 0.86;
      pushCandidate(catEntry, score, 'composio_oauth');
    }

    for (const oc of body.onchain?.connectors ?? []) {
      const rawId = typeof oc.id === 'string' ? oc.id.trim().toLowerCase() : '';
      if (!rawId) continue;
      const id = `onchain:${rawId}`;
      const catEntry =
        catalogById.get(id) ??
        entry.parse({
          id,
          name: typeof oc.name === 'string' && oc.name.trim() ? oc.name.trim() : rawId,
          description: typeof oc.description === 'string' ? oc.description.slice(0, 10000) : '',
          kind: 'connector',
          groups: ['onchain'],
        });
      pushCandidate(catEntry, 0.88, 'onchain');
    }

    const servers = body.mcps?.servers ?? [];
    servers.forEach((srv, idx) => {
      const slug = typeof srv.slug === 'string' ? srv.slug.trim() : '';
      if (!slug) return;
      const catEntry =
        catalogById.get(slug.toLowerCase()) ??
        entry.parse({
          id: slug,
          name: typeof srv.name === 'string' && srv.name.trim() ? srv.name.trim() : slug,
          description: typeof srv.description === 'string' ? srv.description.slice(0, 10000) : '',
          kind: 'connector',
          groups: ['mcps'],
        });
      const srvScore =
        typeof srv.score === 'number' && Number.isFinite(srv.score)
          ? srv.score
          : Math.max(0.4, 0.84 - idx * 0.04);
      const authType = srv.status === 'credential_gated' ? 'mcp_credentials' : 'mcp_live';
      pushCandidate(catEntry, srvScore, authType);
    });
  }

  if (out.length === 0) {
    const qLower = query.trim().toLowerCase();
    for (const item of catalogEntries) {
      const hay = `${item.id} ${item.name} ${item.description}`.toLowerCase();
      if (qLower.split(/\s+/).some(t => t.length >= 2 && hay.includes(t))) {
        pushCandidate(item, item.id.toLowerCase().includes(qLower) ? 0.8 : 0.5, 'catalog');
      }
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(({ entry: item, score, authType }) => ({
    id: item.id,
    name: item.name,
    kind: 'connector',
    authType,
    ...(item.groups?.length ? { groups: item.groups } : {}),
    score: Number(score.toFixed(3)),
    description: item.description.slice(0, 180),
  }));
}

async function searchAgentsWorker(
  query: string,
  role: 'executor' | 'coordinator',
  limit: number,
  loadCatalog: (role: string) => Promise<CatalogEntry[]>,
  discoveredEntries: Map<string, CatalogEntry>,
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const catalogEntries = await loadCatalog('agent').catch(() => [] as CatalogEntry[]);
  const catalogById = new Map(catalogEntries.map(item => [item.id.toLowerCase(), item]));

  const agentUrl = new URL(`${COMPOSE_AGENTS_ORIGIN}/agents/search`);
  agentUrl.searchParams.set('q', query);
  agentUrl.searchParams.set('limit', String(limit));
  agentUrl.searchParams.set('role', role);

  const res = await fetchImpl(agentUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  const out: Array<Record<string, unknown>> = [];
  if (res?.ok) {
    const body = (await res.json().catch(() => ({}))) as { agents?: Array<Record<string, unknown>> };
    for (const hit of body.agents ?? []) {
      const wallet = typeof hit.walletAddress === 'string' ? hit.walletAddress.trim() : '';
      if (!wallet) continue;
      const catEntry =
        catalogById.get(wallet.toLowerCase()) ??
        entry.parse({
          id: wallet,
          name: typeof hit.name === 'string' && hit.name.trim() ? hit.name.trim() : wallet,
          description: typeof hit.description === 'string' ? hit.description.slice(0, 10000) : '',
          kind: 'agent',
          ...(typeof hit.avatarUrl === 'string' && /^https?:\/\//i.test(hit.avatarUrl)
            ? { logo: hit.avatarUrl }
            : {}),
        });
      discoveredEntries.set(`agent:${wallet.toLowerCase()}`, catEntry);
      out.push({
        id: catEntry.id,
        name: catEntry.name,
        kind: 'agent',
        role: typeof hit.role === 'string' ? hit.role : role,
        skills: Array.isArray(hit.skills) ? hit.skills.slice(0, 5) : [],
        score: typeof hit.score === 'number' ? Number(hit.score.toFixed(3)) : undefined,
        description: catEntry.description.slice(0, 180),
      });
    }
  }

  return out.slice(0, limit);
}

async function queryCatalogRoutes(
  query: string,
  kindFilter: 'model' | 'connector' | 'agent' | undefined,
  limit: number,
  loadCatalog: (role: string) => Promise<CatalogEntry[]>,
  discoveredEntries: Map<string, CatalogEntry>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  // If caller explicitly specified kind, run the dedicated worker semantic search directly
  // so the agent immediately gets ranked, frontier-prioritized domain entries!
  if (kindFilter === 'model') {
    const entries = await searchModelsWorker(query, { limit }, loadCatalog, discoveredEntries, fetchImpl);
    return { ok: true, domain: 'models', count: entries.length, entries };
  }
  if (kindFilter === 'connector') {
    const entries = await searchConnectorsWorker(query, limit, loadCatalog, discoveredEntries, fetchImpl);
    return { ok: true, domain: 'connectors', count: entries.length, entries };
  }
  if (kindFilter === 'agent') {
    const entries = await searchAgentsWorker(query, 'executor', limit, loadCatalog, discoveredEntries, fetchImpl);
    return { ok: true, domain: 'agents', count: entries.length, entries };
  }

  // Otherwise hit the real routes.compose.market/query cross-domain Vectorize + Voyage rerank router
  const res = await fetchImpl(COMPOSE_ROUTES_QUERY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ query }),
  }).catch(() => null);

  if (res?.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      matches?: Array<Record<string, unknown>>;
      results?: Array<Record<string, unknown>>;
      next?: string[];
    };
    if (Array.isArray(body.matches) && body.matches.length > 0) {
      const matches = body.matches.map(m => {
        const domain = typeof m.domain === 'string' ? m.domain : 'models';
        const rawRef = typeof m.ref === 'string' ? m.ref : '';
        const entryId = domain === 'connectors' ? normalizeConnectorEntryId(rawRef) : rawRef;
        const rawNext = typeof m.nextTool === 'string' ? m.nextTool : '';
        const nextTool =
          rawNext === 'models_call' || domain === 'models'
            ? 'models_find'
            : rawNext === 'swarm_find' || domain === 'agents'
              ? 'agent_find'
              : 'connectors_find';
        return {
          domain,
          entryId,
          label: m.label,
          score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : 0,
          nextTool,
          ...(typeof m.evidence === 'string' ? { evidence: m.evidence.slice(0, 200) } : {}),
        };
      });
      const topDomain = matches[0]?.domain;
      let domainEntries: Array<Record<string, unknown>> = [];
      if (topDomain === 'models') {
        domainEntries = await searchModelsWorker(
          query,
          { limit },
          loadCatalog,
          discoveredEntries,
          fetchImpl,
        );
      } else if (topDomain === 'connectors') {
        domainEntries = await searchConnectorsWorker(
          query,
          limit,
          loadCatalog,
          discoveredEntries,
          fetchImpl,
        );
      } else if (topDomain === 'agents') {
        domainEntries = await searchAgentsWorker(
          query,
          'executor',
          limit,
          loadCatalog,
          discoveredEntries,
          fetchImpl,
        );
      }
      return {
        ok: true,
        query,
        routedDomain: topDomain,
        ...(domainEntries.length > 0 ? { entries: domainEntries } : {}),
        routeHints: matches.slice(0, 4),
        guidance:
          'Prefer entries from `entries` (already ranked by isFrontier > isLatest > semantic score).',
      };
    }
  }

  // Fallback: run models_find + connectors_find in parallel
  const [models, connectors] = await Promise.all([
    searchModelsWorker(query, { limit: Math.ceil(limit / 2) }, loadCatalog, discoveredEntries, fetchImpl),
    searchConnectorsWorker(query, Math.ceil(limit / 2), loadCatalog, discoveredEntries, fetchImpl),
  ]);
  const combined = [...connectors, ...models].slice(0, limit);
  return { ok: true, count: combined.length, entries: combined };
}

async function resolveCatalogEntryForStep(
  stepKind: 'model' | 'connector' | 'agent',
  rawEntryId: string,
  loadCatalog: (role: string) => Promise<CatalogEntry[]>,
  discoveredEntries: Map<string, CatalogEntry>,
  fetchImpl: typeof fetch,
): Promise<CatalogEntry | undefined> {
  const trimmed = rawEntryId.trim();
  if (!trimmed) return undefined;

  const candidateIds: string[] = [trimmed];
  if (stepKind === 'connector') {
    const norm = normalizeConnectorEntryId(trimmed);
    if (!candidateIds.includes(norm)) candidateIds.push(norm);
    if (!norm.includes(':')) {
      candidateIds.push(`account:${norm.toLowerCase()}`);
      candidateIds.push(`onchain:${norm.toLowerCase()}`);
    }
  } else if (stepKind === 'model' && trimmed.includes(':')) {
    const afterColon = trimmed.slice(trimmed.indexOf(':') + 1).trim();
    if (afterColon) candidateIds.push(afterColon);
  }

  for (const cid of candidateIds) {
    const hit = discoveredEntries.get(`${stepKind}:${cid.toLowerCase()}`);
    if (hit) return hit;
  }

  const entries = await loadCatalog(stepKind).catch(() => [] as CatalogEntry[]);
  for (const cid of candidateIds) {
    const exact =
      entries.find(e => e.id === cid) ??
      entries.find(e => e.id.toLowerCase() === cid.toLowerCase()) ??
      entries.find(e => e.name.toLowerCase() === cid.toLowerCase());
    if (exact) return exact;
  }

  // Live worker lookup fallback if not yet in cached catalog
  if (stepKind === 'model') {
    const targetId = candidateIds[candidateIds.length - 1]!;
    const lookupUrl = new URL(`${COMPOSE_MODELS_ORIGIN}/lookup`);
    lookupUrl.searchParams.set('modelId', targetId);
    const res = await fetchImpl(lookupUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    }).catch(() => null);
    if (res?.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        found?: boolean;
        model?: Record<string, unknown>;
      };
      if (body.found && body.model) {
        const built = buildModelCatalogEntryFromWorkerRow(body.model);
        if (built) {
          discoveredEntries.set(`model:${built.id.toLowerCase()}`, built);
          return built;
        }
      }
    }
  } else if (stepKind === 'connector') {
    const found = await searchConnectorsWorker(trimmed, 4, loadCatalog, discoveredEntries, fetchImpl);
    for (const cid of candidateIds) {
      const hit = discoveredEntries.get(`connector:${cid.toLowerCase()}`);
      if (hit) return hit;
    }
    if (found[0] && typeof found[0].id === 'string') {
      const topId = found[0].id.toLowerCase();
      const norm = normalizeConnectorEntryId(trimmed).toLowerCase();
      if (topId === norm || topId === `account:${norm}` || topId === `onchain:${norm}`) {
        return discoveredEntries.get(`connector:${topId}`);
      }
    }
  }

  return undefined;
}

async function streamNebiusTurn(
  messages: Array<Record<string, unknown>>,
  onDelta: (delta: string) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: StreamToolCall[] }> {
  const response = await fetchImpl(NEBIUS_CHAT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.nebiusApiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: VIBE_MODEL,
      messages,
      tools: VIBE_TOOLS,
      tool_choice: 'auto',
      temperature: 0.35,
      max_tokens: 4096,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Vibe Nemotron request failed (${response.status}): ${errText.slice(0, 240)}`),
      { statusCode: 502 },
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCallsByIndex = new Map<number, StreamToolCall>();

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const existing = toolCallsByIndex.get(idx) ?? {
          id: tc.id || `call_${idx}_${randomUUID().slice(0, 6)}`,
          name: '',
          arguments: '',
        };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        toolCallsByIndex.set(idx, existing);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      processLine(rawLine);
    }
  }
  if (buffer.trim()) {
    processLine(buffer);
  }

  return {
    content,
    toolCalls: [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter(call => call.name.length > 0),
  };
}

export function createVibeStream(
  input: {
    prompt: string;
    flow: Flow;
    userAddress: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  },
  deps: VibeDeps = {},
): PassThrough {
  const stream = new PassThrough();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const loadCatalog = deps.catalogLoader ?? (role => catalog(role));
  const makeBanner = deps.bannerGenerator ?? (args => generateBanner(args, { fetchImpl }));
  const loadCoordinators = deps.coordinatorsLoader ?? (addr => coordinators.list(addr));
  const log = deps.logger;

  const emit = (event: VibeStreamEvent) => {
    if (!stream.destroyed) {
      stream.write(`${JSON.stringify(event)}\n`);
    }
  };

  void (async () => {
    try {
      const hadInitialBanner = Boolean(input.flow.banner);
      const working: Flow = {
        ...input.flow,
        nodes: input.flow.nodes.map(n => ({ ...n, position: { ...n.position }, data: { ...n.data } })),
        edges: input.flow.edges.map(e => ({ ...e })),
        tasks: input.flow.tasks ? [...input.flow.tasks] : undefined,
      };

      const discoveredEntries = new Map<string, CatalogEntry>();
      const stepAliases = new Map<string, string>();
      for (const existingNode of working.nodes) {
        stepAliases.set(existingNode.id, existingNode.id);
        stepAliases.set(existingNode.data.label.trim().toLowerCase(), existingNode.id);
      }
      let lastAddedNodeId: string | undefined = working.nodes[working.nodes.length - 1]?.id;

      const resolveNodeRef = (ref?: string): string | undefined => {
        if (!ref || !ref.trim()) return undefined;
        const clean = ref.trim();
        const aliased = stepAliases.get(clean) ?? stepAliases.get(clean.toLowerCase());
        if (aliased && working.nodes.some(n => n.id === aliased)) return aliased;
        const exact = working.nodes.find(
          n => n.id === clean || n.data.label.trim().toLowerCase() === clean.toLowerCase(),
        );
        return exact?.id;
      };

      const applyPatch = (patch: VibePatch) => {
        working.modified = new Date().toISOString();
        emit({ type: 'patch', patch });
      };

      const extractBannerLogosFromNodes = (nodes: FlowBlock[]): MediaLogoHint[] => {
        const seen = new Set<string>();
        const logos: MediaLogoHint[] = [];
        const FAMILY_BRAND_LABELS: Record<string, string> = {
          claude: 'Claude',
          anthropic: 'Claude',
          openai: 'OpenAI',
          gpt: 'OpenAI',
          gemini: 'Gemini',
          google: 'Gemini',
          deepseek: 'DeepSeek',
          qwen: 'Qwen',
          flux: 'FLUX',
          bfl: 'FLUX',
          deepgram: 'Deepgram',
          nova: 'Deepgram',
          llama: 'Meta Llama',
          meta: 'Meta Llama',
          mistral: 'Mistral',
          kimi: 'Kimi',
          moonshot: 'Kimi',
          grok: 'Grok',
          xai: 'Grok',
          elevenlabs: 'ElevenLabs',
          minimax: 'MiniMax',
        };
        const pushLogo = (name: string, url?: string) => {
          const clean = name.trim();
          if (!clean) return;
          const key = clean.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          logos.push({ name: clean, ...(url ? { url } : {}) });
        };

        for (const node of nodes) {
          const ent = node.data.entry;
          if (!ent) continue;
          if (node.data.kind === 'connector') {
            if (ent.id === 'near-intents') {
              pushLogo('NEAR Protocol', ent.logo);
            } else {
              const cleanConnBrand = ent.name.replace(/\s+(mcp|server)$/i, '').trim() || ent.name;
              pushLogo(cleanConnBrand, ent.logo);
            }
          } else if (node.data.kind === 'model') {
            const famKey = (ent.family || ent.id.split(/[-:/]/)[0] || '').toLowerCase();
            const brand =
              FAMILY_BRAND_LABELS[famKey] ||
              Object.entries(FAMILY_BRAND_LABELS).find(([k]) => ent.id.toLowerCase().includes(k))?.[1] ||
              (ent.family ? ent.family.charAt(0).toUpperCase() + ent.family.slice(1) : ent.name);
            pushLogo(brand, ent.logo);
          } else if (node.data.kind === 'agent') {
            pushLogo(ent.name, ent.logo);
          }
        }
        return logos.slice(0, 6);
      };

      let bannerPromise: Promise<string | null> | null = null;
      const startBannerGeneration = (opts?: {
        title?: string;
        description?: string;
        force?: boolean;
      }): Promise<string | null> => {
        if (bannerPromise && !opts?.force) return bannerPromise;
        const resolvedTitle =
          (opts?.title ?? working.name ?? '').trim().replace(/^unknown(?:\s*#\d+)?$/i, '').trim() ||
          'man0 Workflow';
        const resolvedDescription =
          (opts?.description ?? working.brief ?? '').trim() || input.prompt.trim();
        const logos = extractBannerLogosFromNodes(working.nodes);

        emit({ type: 'banner_start' });
        const job = (async () => {
          try {
            const generated = await makeBanner({
              title: resolvedTitle,
              description: resolvedDescription,
              ...(logos.length > 0 ? { logos } : {}),
            });
            working.banner = generated.imageUrl;
            applyPatch({ op: 'set_banner', banner: generated.imageUrl });
            log?.info(
              { workflowId: working.id, imageUrl: generated.imageUrl, logos: logos.map(l => l.name) },
              'vibe banner generated',
            );
            return generated.imageUrl;
          } catch (bannerErr) {
            log?.warn(
              {
                workflowId: working.id,
                err: bannerErr instanceof Error ? bannerErr.message : String(bannerErr),
              },
              'vibe banner generation warning',
            );
            return null;
          }
        })();
        bannerPromise = job;
        return job;
      };

      const flowSummary = {
        id: working.id,
        name: working.name,
        brief: working.brief ?? '',
        tasks: working.tasks ?? [],
        hasBanner: Boolean(working.banner),
        coordinator: working.coordinator
          ? { id: working.coordinator.id, name: working.coordinator.name, model: working.coordinator.model }
          : null,
        steps: working.nodes.map(n => ({
          id: n.id,
          label: n.data.label,
          kind: n.data.kind,
          entryId: n.data.entry?.id ?? null,
          position: n.position,
          notePreview: n.data.note.slice(0, 140),
        })),
        edges: working.edges.map(e => ({ source: e.source, target: e.target })),
      };

      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: VIBE_SYSTEM_PROMPT },
        ...(input.history ?? []).slice(-6).map(m => ({ role: m.role, content: m.content })),
        {
          role: 'user',
          content: `Current Studio Workflow State:\n${JSON.stringify(flowSummary)}\n\nCreator Request:\n${input.prompt}`,
        },
      ];

      emit({ type: 'status', text: 'Planning workflow architecture...' });

      let finalAssistantText = '';
      const maxTurns = 16;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        const { content, toolCalls } = await streamNebiusTurn(
          messages,
          delta => emit({ type: 'delta', text: delta }),
          fetchImpl,
          input.signal,
        );

        if (content.trim()) {
          finalAssistantText = content.trim();
        }

        log?.info(
          {
            workflowId: working.id,
            turn: turn + 1,
            toolCalls: toolCalls.map(tc => tc.name),
          },
          'vibe turn received',
        );

        if (toolCalls.length === 0) {
          break;
        }

        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments || '{}',
            },
          })),
        });

        let siblingTitleHint: string | undefined;
        for (const candidateCall of toolCalls) {
          if (candidateCall.name === 'set_title' && candidateCall.arguments) {
            try {
              const parsedTitleArgs = JSON.parse(candidateCall.arguments) as Record<string, unknown>;
              if (typeof parsedTitleArgs.title === 'string' && parsedTitleArgs.title.trim()) {
                siblingTitleHint = parsedTitleArgs.title.trim().slice(0, 200);
              }
            } catch {
              // Ignore malformed sibling args here; handled in main loop
            }
          }
        }

        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          let parseErr: string | null = null;
          try {
            args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
          } catch (err) {
            parseErr = err instanceof Error ? err.message : 'Malformed JSON arguments';
            args = {};
          }

          let toolResult: Record<string, unknown>;
          if (parseErr) {
            log?.warn({ workflowId: working.id, tool: call.name, parseErr }, 'vibe malformed tool args');
            toolResult = {
              ok: false,
              error: `Malformed JSON tool arguments (${parseErr}). Retry ${call.name} with valid JSON.`,
            };
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(toolResult),
            });
            continue;
          }

          try {
            switch (call.name) {
              case 'read_categories_library': {
                emit({ type: 'status', text: 'Reading categories library...' });
                toolResult = { ok: true, library: getCategoriesLibraryContext() };
                break;
              }
              case 'read_dag_library': {
                emit({ type: 'status', text: 'Reading DAG architecture library...' });
                toolResult = { ok: true, library: getDagLibraryContext() };
                break;
              }
              case 'query_catalog': {
                const q = String(args.query ?? '').trim() || 'reasoning';
                const kindArg =
                  args.kind === 'model' || args.kind === 'connector' || args.kind === 'agent'
                    ? args.kind
                    : undefined;
                const lim = Math.min(8, Math.max(1, Number(args.limit ?? 6) || 6));
                emit({ type: 'status', text: `Routing "${q}" across catalog...` });
                toolResult = await queryCatalogRoutes(
                  q,
                  kindArg,
                  lim,
                  loadCatalog,
                  discoveredEntries,
                  fetchImpl,
                );
                break;
              }
              case 'models_find': {
                const q = String(args.query ?? '').trim() || 'frontier reasoning';
                const modality = typeof args.modality === 'string' ? args.modality : undefined;
                const lim = Math.min(8, Math.max(1, Number(args.limit ?? 6) || 6));
                emit({ type: 'status', text: `Searching models for "${q}"...` });
                const matches = await searchModelsWorker(
                  q,
                  { modality, limit: lim },
                  loadCatalog,
                  discoveredEntries,
                  fetchImpl,
                );
                toolResult = {
                  ok: true,
                  count: matches.length,
                  models: matches,
                  guidance: 'Prefer isFrontier: true (or isLatest: true) entries when calling add_step.',
                };
                break;
              }
              case 'connectors_find': {
                const q = String(args.query ?? '').trim();
                const lim = Math.min(8, Math.max(1, Number(args.limit ?? 6) || 6));
                emit({ type: 'status', text: `Searching connectors for "${q}"...` });
                const matches = await searchConnectorsWorker(
                  q,
                  lim,
                  loadCatalog,
                  discoveredEntries,
                  fetchImpl,
                );
                toolResult = { ok: true, count: matches.length, connectors: matches };
                break;
              }
              case 'agent_find': {
                const q = String(args.query ?? '').trim();
                const roleArg = args.role === 'coordinator' ? 'coordinator' : 'executor';
                const lim = Math.min(6, Math.max(1, Number(args.limit ?? 5) || 5));
                emit({ type: 'status', text: `Searching specialist agents for "${q}"...` });
                const matches = await searchAgentsWorker(
                  q,
                  roleArg,
                  lim,
                  loadCatalog,
                  discoveredEntries,
                  fetchImpl,
                );
                toolResult = { ok: true, count: matches.length, agents: matches };
                break;
              }
              case 'inspect_connector': {
                const targetId = normalizeConnectorEntryId(String(args.id ?? ''));
                emit({ type: 'status', text: `Inspecting connector ${targetId}...` });
                if (targetId === 'near-intents') {
                  toolResult = {
                    ok: true,
                    id: 'near-intents',
                    authRequired: false,
                    capabilities:
                      'Cross-chain 1Click swaps, deposits, and quotes across NEAR, EVM, Solana, Bitcoin, TON, Stellar, and Tron.',
                  };
                } else if (targetId.startsWith('account:')) {
                  const toolkit = targetId.slice('account:'.length);
                  const actionsRes = await sdk.connectors.accounts.toolkits
                    .actions(toolkit, { limit: 12 })
                    .catch(() => ({ toolkit, actions: [] }));
                  toolResult = {
                    ok: true,
                    id: targetId,
                    type: 'account',
                    toolkit,
                    actions: actionsRes.actions.slice(0, 10).map(a => ({
                      slug: a.slug,
                      name: a.name,
                      description: a.description?.slice(0, 120),
                    })),
                  };
                } else if (targetId.startsWith('onchain:')) {
                  const slug = targetId.slice('onchain:'.length);
                  const card = await sdk.connectors.onchain.get(slug).catch(() => null);
                  toolResult = card
                    ? {
                      ok: true,
                      id: targetId,
                      type: 'onchain',
                      chains: card.chains ?? [],
                      tools: (card.tools ?? []).slice(0, 10).map(t => ({
                        name: t.name,
                        description: t.description?.slice(0, 120),
                      })),
                    }
                    : { ok: false, error: `Connector "${targetId}" not found.` };
                } else {
                  const slug = targetId.replace(/^mcp:/, '');
                  const card = await sdk.connectors.mcps.get(slug).catch(() => null);
                  toolResult = card
                    ? {
                      ok: true,
                      id: slug,
                      type: 'mcp',
                      requiresCredentials: Boolean(card.requiresCredentials),
                      credentials: (card.credentials ?? []).map(c => c.varName),
                      tools: (card.tools ?? []).slice(0, 10).map(t => ({
                        name: t.name,
                        description: t.description?.slice(0, 120),
                      })),
                    }
                    : { ok: false, error: `Connector "${targetId}" not found.` };
                }
                break;
              }
              case 'list_coordinators': {
                emit({ type: 'status', text: 'Checking saved Coordinator Personas...' });
                const list = await loadCoordinators(input.userAddress);
                toolResult = {
                  ok: true,
                  coordinators: list.map(c => ({
                    id: c.id,
                    name: c.name,
                    model: c.model,
                    personality: c.personality.slice(0, 160),
                    walletAddress: c.walletAddress,
                  })),
                };
                break;
              }
              case 'set_title': {
                const title = String(args.title ?? '').trim().slice(0, 200);
                if (!title) {
                  toolResult = { ok: false, error: 'Title cannot be empty.' };
                  break;
                }
                working.name = title;
                applyPatch({ op: 'set_title', name: title });
                toolResult = { ok: true, title };
                break;
              }
              case 'set_description': {
                const description = String(args.description ?? '').trim().slice(0, 8000);
                working.brief = description;
                applyPatch({ op: 'set_description', brief: description });
                toolResult = { ok: true, descriptionLength: description.length };
                break;
              }
              case 'set_categories': {
                const rawCats = Array.isArray(args.categories)
                  ? args.categories.map(c => String(c))
                  : [];
                const canonical = resolveCanonicalTasks(rawCats);
                if (canonical.length === 0) {
                  toolResult = {
                    ok: false,
                    error: `Choose 1-${MAX_TASK_TAGS} valid categories from read_categories_library.`,
                  };
                  break;
                }
                working.tasks = canonical;
                applyPatch({ op: 'set_categories', tasks: canonical });
                toolResult = { ok: true, categories: canonical };
                break;
              }
              case 'set_coordinator': {
                const cid = args.coordinatorId === null ? null : String(args.coordinatorId ?? '').trim();
                if (!cid) {
                  working.coordinator = null;
                  applyPatch({ op: 'set_coordinator', coordinator: null });
                  toolResult = { ok: true, coordinator: null };
                  break;
                }
                const list = await loadCoordinators(input.userAddress);
                const found = list.find(c => c.id === cid || c.walletAddress === cid);
                if (!found) {
                  toolResult = { ok: false, error: `Coordinator "${cid}" not found.` };
                  break;
                }
                working.coordinator = found;
                applyPatch({ op: 'set_coordinator', coordinator: found });
                toolResult = { ok: true, coordinator: { id: found.id, name: found.name } };
                break;
              }
              case 'generate_banner': {
                const bannerTitle = String(args.title ?? siblingTitleHint ?? working.name ?? '').trim();
                const bannerDesc =
                  String(args.description ?? working.brief ?? '').trim() || input.prompt.trim();
                if (bannerPromise && !hadInitialBanner) {
                  toolResult = { ok: true, status: 'generating_in_parallel' };
                  break;
                }
                void startBannerGeneration({
                  title: bannerTitle,
                  description: bannerDesc,
                  force: true,
                });
                toolResult = { ok: true, status: 'generating_in_parallel' };
                break;
              }
              case 'add_step': {
                const stepKind =
                  args.kind === 'connector' || args.kind === 'agent' ? args.kind : 'model';
                const requestedId = String(args.entryId ?? '').trim();
                const symbolicStepId =
                  typeof args.stepId === 'string' && args.stepId.trim() ? args.stepId.trim() : undefined;
                const label = String(args.label ?? '').trim().slice(0, 120) || 'Workflow Step';
                const note = String(args.note ?? '').trim().slice(0, 12000);
                const rawAnchor =
                  typeof args.anchorId === 'string' && args.anchorId.trim() ? args.anchorId.trim() : undefined;
                const direction: Direction =
                  args.direction === 'left' || args.direction === 'up' || args.direction === 'down'
                    ? args.direction
                    : 'right';

                const matched = await resolveCatalogEntryForStep(
                  stepKind,
                  requestedId,
                  loadCatalog,
                  discoveredEntries,
                  fetchImpl,
                );

                if (!matched) {
                  log?.warn(
                    { workflowId: working.id, stepKind, requestedId, label },
                    'vibe add_step entry not found',
                  );
                  const finderName =
                    stepKind === 'model'
                      ? 'models_find'
                      : stepKind === 'connector'
                        ? 'connectors_find'
                        : 'agent_find';
                  toolResult = {
                    ok: false,
                    error: `Entry "${requestedId}" not found in ${stepKind} catalog. Call ${finderName} first and pass an exact id.`,
                  };
                  break;
                }

                // Resolve anchorId via symbolic alias / UUID / label, or default to chaining right
                // from the previous added step when connectFromAnchor is not explicitly false.
                const explicitAnchorNodeId = resolveNodeRef(rawAnchor);
                const autoChainFromPrev =
                  !rawAnchor && args.connectFromAnchor !== false && lastAddedNodeId
                    ? lastAddedNodeId
                    : undefined;
                const effectiveAnchorId = explicitAnchorNodeId ?? autoChainFromPrev;
                const connectFromAnchor =
                  args.connectFromAnchor === undefined
                    ? Boolean(effectiveAnchorId)
                    : Boolean(args.connectFromAnchor);

                emit({ type: 'status', text: `Adding step "${label}"...` });
                const position = computeDirectionalPosition(working.nodes, effectiveAnchorId, direction);
                const newNodeId = randomUUID();
                const newNode: FlowBlock = {
                  id: newNodeId,
                  type: 'step',
                  position,
                  data: {
                    label,
                    kind: stepKind,
                    entry: matched,
                    note,
                  },
                };
                working.nodes.push(newNode);
                lastAddedNodeId = newNodeId;

                stepAliases.set(newNodeId, newNodeId);
                stepAliases.set(label.toLowerCase(), newNodeId);
                if (symbolicStepId) {
                  stepAliases.set(symbolicStepId, newNodeId);
                  stepAliases.set(symbolicStepId.toLowerCase(), newNodeId);
                }

                let addedEdge: FlowLink | undefined;
                if (
                  connectFromAnchor &&
                  effectiveAnchorId &&
                  working.nodes.some(n => n.id === effectiveAnchorId) &&
                  !working.edges.some(e => e.source === effectiveAnchorId && e.target === newNodeId) &&
                  !wouldCreateCycle(working.nodes, working.edges, effectiveAnchorId, newNodeId)
                ) {
                  addedEdge = makeWireEdge(effectiveAnchorId, newNodeId);
                  working.edges.push(addedEdge);
                }

                applyPatch({ op: 'add_step', node: newNode, ...(addedEdge ? { edge: addedEdge } : {}) });
                log?.info(
                  {
                    workflowId: working.id,
                    stepId: newNodeId,
                    alias: symbolicStepId ?? null,
                    label,
                    kind: stepKind,
                    entryId: matched.id,
                    connectedFrom: addedEdge?.source ?? null,
                  },
                  'vibe step added',
                );
                toolResult = {
                  ok: true,
                  stepId: newNodeId,
                  ...(symbolicStepId ? { alias: symbolicStepId } : {}),
                  entryId: matched.id,
                  position,
                  connectedFrom: addedEdge?.source ?? null,
                };
                break;
              }
              case 'update_step': {
                const resolvedStepId = resolveNodeRef(String(args.stepId ?? ''));
                const target = resolvedStepId ? working.nodes.find(n => n.id === resolvedStepId) : undefined;
                if (!target) {
                  toolResult = { ok: false, error: `Step "${String(args.stepId ?? '')}" not found.` };
                  break;
                }
                let nextEntry: CatalogEntry | undefined;
                if (typeof args.entryId === 'string' && args.entryId.trim()) {
                  const roleToLoad =
                    args.kind === 'model' || args.kind === 'connector' || args.kind === 'agent'
                      ? args.kind
                      : target.data.kind;
                  const found = await resolveCatalogEntryForStep(
                    roleToLoad,
                    args.entryId,
                    loadCatalog,
                    discoveredEntries,
                    fetchImpl,
                  );
                  if (!found) {
                    toolResult = { ok: false, error: `Entry "${args.entryId}" not found in ${roleToLoad} catalog.` };
                    break;
                  }
                  target.data.kind = roleToLoad;
                  target.data.entry = found;
                  nextEntry = found;
                }
                const nextLabel =
                  typeof args.label === 'string' && args.label.trim()
                    ? args.label.trim().slice(0, 120)
                    : undefined;
                const nextNote = typeof args.note === 'string' ? args.note.slice(0, 12000) : undefined;
                if (nextLabel) {
                  target.data.label = nextLabel;
                  stepAliases.set(nextLabel.toLowerCase(), target.id);
                }
                if (nextNote !== undefined) target.data.note = nextNote;

                applyPatch({
                  op: 'update_step',
                  stepId: target.id,
                  ...(nextLabel ? { label: nextLabel } : {}),
                  ...(nextNote !== undefined ? { note: nextNote } : {}),
                  ...(nextEntry ? { entry: nextEntry } : {}),
                });
                toolResult = { ok: true, stepId: target.id };
                break;
              }
              case 'connect_steps': {
                const sourceId = resolveNodeRef(String(args.sourceId ?? ''));
                const targetId = resolveNodeRef(String(args.targetId ?? ''));
                if (!sourceId || !targetId) {
                  toolResult = { ok: false, error: 'Both sourceId and targetId must exist on the Canvas.' };
                  break;
                }
                if (working.edges.some(e => e.source === sourceId && e.target === targetId)) {
                  toolResult = { ok: true, alreadyConnected: true };
                  break;
                }
                if (wouldCreateCycle(working.nodes, working.edges, sourceId, targetId)) {
                  toolResult = { ok: false, error: 'Connection rejected: workflows must remain acyclic (DAG).' };
                  break;
                }
                const edge = makeWireEdge(sourceId, targetId);
                working.edges.push(edge);
                applyPatch({ op: 'connect_steps', edge });
                toolResult = { ok: true, edgeId: edge.id };
                break;
              }
              case 'remove_step': {
                const stepId = resolveNodeRef(String(args.stepId ?? ''));
                if (!stepId) {
                  toolResult = { ok: false, error: `Step "${String(args.stepId ?? '')}" not found.` };
                  break;
                }
                working.nodes = working.nodes.filter(n => n.id !== stepId);
                working.edges = working.edges.filter(e => e.source !== stepId && e.target !== stepId);
                if (lastAddedNodeId === stepId) {
                  lastAddedNodeId = working.nodes[working.nodes.length - 1]?.id;
                }
                applyPatch({ op: 'remove_step', stepId });
                toolResult = { ok: true, removed: stepId };
                break;
              }
              case 'arrange_canvas': {
                emit({ type: 'status', text: 'Arranging DAG waves on Canvas...' });
                const positions = computeWaveLayout(working.nodes, working.edges);
                for (const n of working.nodes) {
                  if (positions[n.id]) {
                    n.position = positions[n.id]!;
                  }
                }
                applyPatch({ op: 'arrange_canvas', positions });
                toolResult = { ok: true, arrangedCount: Object.keys(positions).length };
                break;
              }
              default:
                toolResult = { ok: false, error: `Unknown tool "${call.name}".` };
            }
          } catch (toolErr) {
            log?.error(
              {
                workflowId: working.id,
                tool: call.name,
                err: toolErr instanceof Error ? toolErr.message : String(toolErr),
              },
              'vibe tool execution error',
            );
            toolResult = {
              ok: false,
              error: toolErr instanceof Error ? toolErr.message : 'Tool execution failed.',
            };
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
        }

        // Start background banner generation as soon as title, description, and steps are populated
        // so it already includes the exact workflow title AND step brand logos without blocking!
        const hasRealTitle = Boolean(
          working.name.trim() && !/^unknown(?:\s*#\d+)?$/i.test(working.name.trim()),
        );
        if (
          !hadInitialBanner &&
          !working.banner &&
          !bannerPromise &&
          hasRealTitle &&
          Boolean(working.brief?.trim()) &&
          working.nodes.length > 0
        ) {
          void startBannerGeneration();
        }
      }

      // Guarantee background banner generation from Vibe's title + description + step logos
      if (!hadInitialBanner && !working.banner && !bannerPromise) {
        void startBannerGeneration({
          title: working.name,
          description: working.brief || input.prompt,
        });
      }

      const summaryText =
        finalAssistantText ||
        `Configured "${working.name}" with ${working.nodes.length} step${working.nodes.length === 1 ? '' : 's'}.`;

      // Unblock Studio immediately so the user switches to Canvas right away while banner finishes in the background!
      emit({
        type: 'workflow_ready',
        text: summaryText,
        flow: working,
      });

      if (bannerPromise) {
        await bannerPromise;
      }

      log?.info(
        {
          workflowId: working.id,
          name: working.name,
          nodeCount: working.nodes.length,
          edgeCount: working.edges.length,
          hasBanner: Boolean(working.banner),
        },
        'vibe stream completed',
      );

      emit({
        type: 'done',
        text: summaryText,
        flow: working,
      });
    } catch (err) {
      log?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'vibe stream fatal error',
      );
      emit({
        type: 'error',
        error: err instanceof Error ? err.message : 'Vibe agent failed to complete.',
      });
    } finally {
      if (!stream.destroyed) {
        stream.end();
      }
    }
  })();

  return stream;
}
