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
