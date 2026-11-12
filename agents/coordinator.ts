import type { Bill, ComposeSDK, Receipt, RunEvent } from '@compose-market/sdk';
import { config } from '../config.js';
import type { Coordinator, Listing } from '../schema.js';
import { extractMetaFromReceiptPayload } from '../payment.js';
import type { MissingConnectorRequirement, MissingInputRequirement } from '../server.js';
import { pinBufferToIpfs } from './media.js';

type Block = Listing['nodes'][number];
type Link = Listing['edges'][number];

export interface WorkflowAttachment {
  type: 'image' | 'audio' | 'video' | 'pdf' | 'file' | 'text' | 'json';
  url: string;
  mimeType?: string;
  name?: string;
  size?: number;
  cid?: string;
  text?: string;
}

export interface WorkflowBillItem {
  category: 'coordinator' | 'model' | 'connector' | 'agent';
  kind: string;
  name: string;
  subject?: string;
  stepId?: string;
  receiptId?: string;
  txHash?: string;
  amountWei: string;
}

export interface ExecutedWorkflowStep {
  id: string;
  label: string;
  kind: 'model' | 'connector' | 'agent';
  entryId: string | null;
  billWei: string;
  output: string;
  provider?: string;
  stepInput: unknown;
  invokedTool: string;
  inferenceRunIds: string[];
  startedAt: number;
  endedAt: number;
}

export interface WorkflowResult {
  output: string;
  steps: ExecutedWorkflowStep[];
  bills: WorkflowBillItem[];
  coordinatorBillWei: bigint;
  coordinatorProviders: string[];
  coordinatorRunIds: string[];
  totalComposeBillWei: bigint;
  stepOutputs: Record<string, string>;
}

const CONTROL_TOOLS = new Set([
  'models_find',
  'model_select',
  'connectors_find',
  'connector_select',
  'agent_find',
  'agent_select',
  'query_catalog',
  'query_backpack',
  'propose_connector',
  'scratchpad',
  'history_query',
  'plan_clarify',
  'plan_approval',
  'plan_reassign',
  'completion_decision',
  'reparation_decision',
]);

export function canonicalConnectorBindingId(entry: Block['data']['entry']): string | null {
  if (!entry?.id) return null;
  const raw = entry.id.trim().replace(/^connector:/i, '');
  if (!raw) return null;
  if (raw.startsWith('account:') || raw.startsWith('onchain:') || raw.startsWith('mcp:')) {
    return raw;
  }
  if (entry.groups?.includes('onchain')) return `onchain:${raw}`;
  return `mcp:${raw}`;
}

export function decomposeWorkflowWaves(
  nodes: Block[],
  edges: Link[],
): {
  waves: Block[][];
  orderedNodes: Block[];
  incomingByNode: Map<string, string[]>;
} {
  if (nodes.length === 0) {
    return { waves: [], orderedNodes: [], incomingByNode: new Map() };
  }

  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const inDegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  const incomingByNode = new Map(nodes.map(node => [node.id, [] as string[]]));

  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incomingByNode.get(edge.target)!.push(edge.source);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const waves: Block[][] = [];
  const orderedNodes: Block[] = [];
  let ready = nodes.filter(node => (inDegree.get(node.id) ?? 0) === 0);

  while (ready.length > 0) {
    waves.push(ready);
    const nextReady: Block[] = [];
    for (const current of ready) {
      orderedNodes.push(current);
      for (const nextId of outgoing.get(current.id) ?? []) {
        const updated = (inDegree.get(nextId) ?? 1) - 1;
        inDegree.set(nextId, updated);
        if (updated === 0) {
          const nextNode = nodeMap.get(nextId);
          if (nextNode) nextReady.push(nextNode);
        }
      }
    }
    ready = nextReady;
  }

  if (orderedNodes.length !== nodes.length) {
    throw Object.assign(new Error('Workflow contains a cycle and cannot be executed as a DAG.'), {
      statusCode: 400,
    });
  }

  return { waves, orderedNodes, incomingByNode };
}

export function formatWorkflowAttachments(attachments: WorkflowAttachment[]): string {
  if (attachments.length === 0) return '';
  const blocks = attachments.map((att, idx) => {
    const label = att.name ? `${att.name} (${att.type})` : `${att.type} #${idx + 1}`;
    const header = `- [${label}] ${att.url}${att.mimeType ? ` (${att.mimeType})` : ''}`;
    return att.text?.trim()
      ? `${header}\n\`\`\`\n${att.text.trim().slice(0, 16_000)}\n\`\`\``
      : header;
  });
  return `Attached inputs:\n${blocks.join('\n')}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapToolOutput(value: unknown, depth = 0): unknown {
  if (depth > 7 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        return unwrapToolOutput(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  const rec = asRecord(value);
  if (!rec) return value;
  if (rec.__compose_tool_result === 'compacted_json' && 'value' in rec) {
    return unwrapToolOutput(rec.value, depth + 1);
  }
  if (rec.__compose_tool_result === 'truncated_text' && typeof rec.text === 'string') {
    return unwrapToolOutput(rec.text, depth + 1);
  }
  const kwargs = asRecord(rec.kwargs);
  if (kwargs?.content !== undefined) {
    return unwrapToolOutput(kwargs.content, depth + 1);
  }
  if ('tool_call_id' in rec || 'lc_namespace' in rec || rec.role === 'tool') {
    return unwrapToolOutput(rec.content, depth + 1);
  }
  return rec;
}

function extractReadableFromRecord(rec: Record<string, unknown>, depth = 0): string | null {
  if (depth > 4) return null;
  for (const field of [
    'output',
    'text',
    'markdown',
    'content',
    'summary',
    'result',
    'response',
    'message',
  ]) {
    const val = rec[field];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  if (Array.isArray(rec.content)) {
    const chunks = rec.content
      .map(item => {
        if (typeof item === 'string') return item.trim();
        const r = asRecord(item);
        return typeof r?.text === 'string' ? r.text.trim() : '';
      })
      .filter(Boolean);
    if (chunks.length > 0) return chunks.join('\n\n');
  }
  const urlCandidate = [rec.url, rec.permalink, rec.html_url, rec.webViewLink, rec.link].find(
    v => typeof v === 'string' && /^https?:\/\//i.test(v.trim()),
  ) as string | undefined;

  for (const nestedKey of ['data', 'result', 'output', 'response']) {
    const nested = asRecord(rec[nestedKey]);
    if (nested) {
      const inner = extractReadableFromRecord(nested, depth + 1);
      if (inner) {
        return urlCandidate && !inner.includes(urlCandidate)
          ? `${inner}\n\n${urlCandidate}`
          : inner;
      }
    }
  }
  if (urlCandidate) {
    return `Published: ${urlCandidate.trim()}`;
  }
  if (rec.successful === true || rec.success === true) {
    const idVal =
      (typeof rec.id === 'string' && rec.id) ||
      (typeof asRecord(rec.data)?.id === 'string' && (asRecord(rec.data)?.id as string)) ||
      '';
    return idVal ? `Action completed (ID: ${idVal}).` : 'External connector action completed.';
  }
  return null;
}
