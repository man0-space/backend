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
