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

function extractProviderFromReceipt(receipt: Receipt): string | undefined {
  const fromSubject = (subject?: string): string | undefined => {
    if (!subject || !subject.includes(':')) return undefined;
    const prefix = subject.split(':')[0]!.trim().toLowerCase();
    return prefix && !['agent', 'workflow', 'connector'].includes(prefix) ? prefix : undefined;
  };
  const direct = fromSubject(receipt.subject);
  if (direct) return direct;
  for (const bill of receipt.bills ?? []) {
    if (bill.kind === 'model') {
      if (bill.source?.trim()) return bill.source.trim().toLowerCase();
      const matched = fromSubject(bill.subject ?? bill.model);
      if (matched) return matched;
    }
  }
  return undefined;
}

function parsePositiveBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

function matchesStepSubject(
  entry: Block['data']['entry'] | undefined,
  kind: Block['data']['kind'],
  subjectStr: string,
): boolean {
  const rawEntryId = entry?.id?.trim().toLowerCase() ?? '';
  const subj = subjectStr.trim().toLowerCase();
  if (!rawEntryId || !subj) return false;
  if (kind === 'model') {
    const entryTail = rawEntryId.split(':').pop() ?? rawEntryId;
    const subjTail = subj.split(':').pop() ?? subj;
    return (
      subj === rawEntryId ||
      subj.endsWith(`:${rawEntryId}`) ||
      rawEntryId.endsWith(`:${subj}`) ||
      (entryTail.length >= 3 && entryTail === subjTail)
    );
  }
  if (kind === 'connector') {
    const canonical = canonicalConnectorBindingId(entry)?.toLowerCase() ?? rawEntryId;
    const slug = canonical.split(':').pop() ?? canonical;
    return (
      subj === canonical ||
      subj === rawEntryId ||
      subj.startsWith(`${canonical}:`) ||
      (slug.length >= 2 &&
        (subj === slug || subj.endsWith(`:${slug}`) || subj.includes(`:${slug}:`)))
    );
  }
  const wallet = rawEntryId.replace(/^agent:/, '');
  const subjWallet = subj.replace(/^agent:/, '');
  return Boolean(wallet && wallet === subjWallet);
}

function extractBillItemsFromReceipt(
  receipt: Receipt,
  coordinator: Coordinator,
  orderedNodes: Block[] = [],
  stepToolCallIds?: Map<string, Set<string>>,
  ignoreBillsTree = false,
): WorkflowBillItem[] {
  const items: WorkflowBillItem[] = [];
  const coordLower = coordinator.walletAddress.toLowerCase();
  const receiptId = typeof receipt.id === 'string' && receipt.id.trim() ? receipt.id.trim() : undefined;
  const txHash =
    (typeof receipt.txHash === 'string' && receipt.txHash.trim()) ||
    (typeof receipt.settleTxHash === 'string' && receipt.settleTxHash.trim()) ||
    (typeof receipt.claimTxHash === 'string' && receipt.claimTxHash.trim()) ||
    undefined;

  const hasNestedOrTypedBills =
    !ignoreBillsTree &&
    Array.isArray(receipt.bills) &&
    receipt.bills.some(
      b =>
        (Array.isArray(b.children) && b.children.length > 0) ||
        b.kind === 'model' ||
        b.kind === 'connector' ||
        b.kind === 'tool',
    );
  if (hasNestedOrTypedBills && Array.isArray(receipt.bills)) {
    const pushBill = (bill: Bill) => {
      if (Array.isArray(bill.children) && bill.children.length > 0) {
        for (const child of bill.children) pushBill(child);
      }
      const amt = parsePositiveBigInt(bill.amountWei);
      if (amt <= 0n) return;
      const subj = bill.subject?.trim();
      const isCoord =
        bill.kind === 'agent' &&
        ((bill.agentWallet && bill.agentWallet.toLowerCase() === coordLower) ||
          (subj && subj.toLowerCase() === `agent:${coordLower}`));
      const category: WorkflowBillItem['category'] = isCoord
        ? 'coordinator'
        : bill.kind === 'model'
          ? 'model'
          : bill.kind === 'connector' || bill.kind === 'tool'
            ? 'connector'
            : bill.kind === 'agent'
              ? 'agent'
              : 'coordinator';
      const matchedNode =
        category !== 'coordinator' && subj
          ? orderedNodes.find(
              n => n.data.kind === category && matchesStepSubject(n.data.entry, n.data.kind, subj),
            )
          : undefined;
      items.push({
        category,
        kind: bill.kind,
        name:
          (isCoord
            ? coordinator.name
            : matchedNode?.data.entry?.name || bill.name?.trim() || bill.model?.trim() || subj) ||
          bill.kind,
        ...(subj ? { subject: subj } : {}),
        ...(matchedNode ? { stepId: matchedNode.id } : {}),
        ...(receiptId ? { receiptId } : {}),
        ...(txHash ? { txHash } : {}),
        amountWei: amt.toString(),
      });
    };
    for (const bill of receipt.bills) pushBill(bill);
    if (items.length > 0) return items;
  }

  const finalWei = parsePositiveBigInt(receipt.finalAmountWei);
  if (finalWei <= 0n) return items;

  const service = (receipt.service ?? '').trim().toLowerCase();
  const action = (receipt.action ?? '').trim();
  const subjectStr = receipt.subject?.trim() ?? '';

  if (action === 'models_call' || action.startsWith('models_call:')) {
    const toolCallId = action.startsWith('models_call:')
      ? action.slice('models_call:'.length).trim()
      : '';
    const matchedNode =
      (toolCallId
        ? orderedNodes.find(n => stepToolCallIds?.get(n.id)?.has(toolCallId))
        : undefined) ??
      orderedNodes.find(
        n => n.data.kind === 'model' && matchesStepSubject(n.data.entry, 'model', subjectStr),
      );
    items.push({
      category: 'model',
      kind: 'inference',
      name: matchedNode?.data.entry?.name || subjectStr || 'model',
      ...(subjectStr ? { subject: subjectStr } : {}),
      ...(matchedNode ? { stepId: matchedNode.id } : {}),
      ...(receiptId ? { receiptId } : {}),
      ...(txHash ? { txHash } : {}),
      amountWei: finalWei.toString(),
    });
    return items;
  }

  if (service === 'mcp' || service === 'connector' || service === 'onchain') {
    const matchedNode = orderedNodes.find(
      n => n.data.kind === 'connector' && matchesStepSubject(n.data.entry, 'connector', subjectStr),
    );
    items.push({
      category: 'connector',
      kind: service,
      name: matchedNode?.data.entry?.name || subjectStr || service,
      ...(subjectStr ? { subject: subjectStr } : {}),
      ...(matchedNode ? { stepId: matchedNode.id } : {}),
      ...(receiptId ? { receiptId } : {}),
      ...(txHash ? { txHash } : {}),
      amountWei: finalWei.toString(),
    });
    return items;
  }

  if (
    (service === 'agent' || service === 'runtime') &&
    subjectStr &&
    subjectStr.toLowerCase() !== `agent:${coordLower}` &&
    subjectStr.toLowerCase() !== coordLower
  ) {
    const matchedNode = orderedNodes.find(
      n => n.data.kind === 'agent' && matchesStepSubject(n.data.entry, 'agent', subjectStr),
    );
    items.push({
      category: 'agent',
      kind: 'agent',
      name: matchedNode?.data.entry?.name || subjectStr,
      subject: subjectStr,
      ...(matchedNode ? { stepId: matchedNode.id } : {}),
      ...(receiptId ? { receiptId } : {}),
      ...(txHash ? { txHash } : {}),
      amountWei: finalWei.toString(),
    });
    return items;
  }

  items.push({
    category: 'coordinator',
    kind: service || 'coordinator',
    name:
      service === 'agent' || service === 'runtime'
        ? coordinator.name
        : `${coordinator.name} · ${subjectStr || action || service || 'compute'}`,
    ...(subjectStr ? { subject: subjectStr } : { subject: `agent:${coordinator.walletAddress}` }),
    ...(receiptId ? { receiptId } : {}),
    ...(txHash ? { txHash } : {}),
    amountWei: finalWei.toString(),
  });
  return items;
}

const INLINE_MARKDOWN_DATA_URI_RE = /!\[([^\]]*)\]\(data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)\)/g;
const RAW_DATA_URI_RE = /data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]{64,})/g;

function replaceDataUrisWithHostedUrls(text: string, hostedAssets: string[]): string {
  const hasHosted = hostedAssets.some(a => /https?:\/\//i.test(a));
  let cleaned = text;
  if (hasHosted) {
    cleaned = cleaned
      .replace(INLINE_MARKDOWN_DATA_URI_RE, '')
      .replace(RAW_DATA_URI_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  const parts = cleaned ? [cleaned] : [];
  for (const asset of hostedAssets) {
    const rawUrlMatch = asset.match(/\((https?:\/\/[^)]+)\)/);
    const checkToken = rawUrlMatch?.[1] ?? asset;
    if (!parts.some(p => p.includes(checkToken))) {
      parts.push(asset);
    }
  }
  return parts.join('\n\n').trim();
}

async function pinResidualDataUrisInStepOutput(
  text: string,
  stepId: string,
  fetchImpl?: typeof fetch,
): Promise<{ output: string; pinnedAssets: string[] }> {
  if (!text.includes('data:') || !text.includes(';base64,')) {
    return { output: text, pinnedAssets: [] };
  }
  if (!config.pinataJwt?.trim()) {
    return { output: text, pinnedAssets: [] };
  }

  const pinnedAssets: string[] = [];
  let updated = text;
  const matches = [...text.matchAll(/data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]{128,})/g)];
  let idx = 0;
  for (const m of matches) {
    const fullUri = m[0];
    const mimeType = (m[1] || 'image/png').trim().toLowerCase();
    const rawB64 = (m[2] || '').replace(/\s+/g, '');
    if (!rawB64) continue;
    idx += 1;
    const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    try {
      const bytes = Buffer.from(rawB64, 'base64');
      if (bytes.length === 0) continue;
      const pinned = await pinBufferToIpfs(
        {
          bytes,
          mimeType,
          fileName: `step-${stepId}-${idx}.${ext}`,
          name: `step-${stepId}-${idx}`,
        },
        fetchImpl,
      );
      updated = updated.split(fullUri).join(pinned.imageUrl);
      const formatted = mimeType.startsWith('image/')
        ? `![Generated image](${pinned.imageUrl})`
        : pinned.imageUrl;
      if (!pinnedAssets.includes(formatted)) pinnedAssets.push(formatted);
    } catch {
      // Leave intact if IPFS pin fails; sanitizePromptStepOutput still strips oversized blobs from prompts
    }
  }
  return { output: updated, pinnedAssets };
}

function sanitizePromptStepOutput(text: string): string {
  if (!text.includes('data:') || !text.includes(';base64,')) return text;
  return text
    .replace(
      INLINE_MARKDOWN_DATA_URI_RE,
      (_match, alt: string) => `[Generated media${alt ? `: ${alt}` : ''} omitted from inline prompt]`,
    )
    .replace(RAW_DATA_URI_RE, '[inline base64 media omitted]');
}

function formatToolStepOutput(payload: Record<string, unknown> | undefined, assets: string[]): string {
  const parts: string[] = [];
  if (payload) {
    const artifact = asRecord(payload.artifact);
    if (typeof artifact?.content === 'string' && artifact.content.trim()) {
      parts.push(artifact.content.trim());
    } else if (typeof artifact?.url === 'string' && artifact.url.trim()) {
      parts.push(
        artifact.type === 'image' ? `![Generated image](${artifact.url.trim()})` : artifact.url.trim(),
      );
    }
    if (parts.length === 0) {
      const unwrapped = unwrapToolOutput(payload.output);
      const rec = asRecord(unwrapped);
      if (rec) {
        const readable = extractReadableFromRecord(rec);
        parts.push(readable || JSON.stringify(rec));
      } else if (typeof unwrapped === 'string' && unwrapped.trim()) {
        parts.push(unwrapped.trim());
      } else if (typeof payload.message === 'string' && payload.message.trim()) {
        parts.push(payload.message.trim());
      }
    }
  }
  return replaceDataUrisWithHostedUrls(parts.join('\n\n').trim(), assets);
}

interface RawConnectorActionDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function formatSchemaParamType(propSchema: Record<string, unknown> | null): string {
  if (!propSchema) return 'any';
  const rawType = propSchema['type'];
  const baseType = Array.isArray(rawType)
    ? rawType.map(String).join('|')
    : typeof rawType === 'string'
      ? rawType
      : Array.isArray(propSchema['enum'])
        ? 'enum'
        : 'any';
  if (baseType === 'object') {
    const nested = asRecord(propSchema['properties']);
    if (nested) {
      const subKeys = Object.keys(nested).slice(0, 5);
      if (subKeys.length > 0) return `object{${subKeys.join(',')}}`;
    }
  }
  if (baseType === 'array') {
    const items = asRecord(propSchema['items']);
    const itemType = typeof items?.['type'] === 'string' ? items['type'] : 'any';
    return `${itemType}[]`;
  }
  return baseType;
}

function summarizeConnectorActions(actions: RawConnectorActionDef[]): string {
  if (actions.length === 0) return '';
  return actions
    .slice(0, 120)
    .map(action => {
      const schema = asRecord(action.inputSchema);
      const props = asRecord(schema?.['properties']) ?? {};
      const requiredSet = new Set(
        Array.isArray(schema?.['required']) ? schema['required'].map(String) : [],
      );
      const orderedKeys = [
        ...Object.keys(props).filter(k => requiredSet.has(k)),
        ...Object.keys(props).filter(k => !requiredSet.has(k)),
      ].slice(0, 8);
      const sig = orderedKeys
        .map(k => `${k}${requiredSet.has(k) ? '*' : ''}:${formatSchemaParamType(asRecord(props[k]))}`)
        .join(', ');
      const desc = (action.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return `     - ${action.name}(${sig})${desc ? `: ${desc}` : ''}`;
    })
    .join('\n');
}

async function fetchConnectorActionSummary(
  runSdk: ComposeSDK,
  bindingId: string,
): Promise<string> {
  const [origin, ...rest] = bindingId.split(':');
  const slug = rest.join(':').trim();
  if (!origin || !slug) return '';
  if (origin === 'account') {
    const res = await runSdk.connectors.accounts?.toolkits
      ?.actions?.(slug, { limit: 200 })
      .catch(() => null);
    if (!res?.actions?.length) return '';
    return summarizeConnectorActions(
      res.actions.map(a => ({
        name: a.slug,
        description: a.description || a.name,
        inputSchema: a.inputParameters,
      })),
    );
  }
  if (origin === 'mcp') {
    const res = await runSdk.connectors.mcps?.actions?.(slug).catch(() => null);
    if (!res?.tools?.length) return '';
    return summarizeConnectorActions(
      res.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    );
  }
  if (origin === 'onchain') {
    const res = await runSdk.connectors.onchain?.get?.(slug).catch(() => null);
    if (!res?.tools?.length) return '';
    return summarizeConnectorActions(
      res.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? t.parameters,
      })),
    );
  }
  return '';
}

function assembleFinalDeliverable(params: {
  orderedNodes: Block[];
  edges: Link[];
  executedSteps: Map<string, ExecutedWorkflowStep>;
  coordinatorText: string;
  globalAssets: string[];
}): string {
  const { orderedNodes, edges, executedSteps, coordinatorText, globalAssets } = params;
  const sourceNodeIds = new Set(edges.map(e => e.source));
  const orderedSteps = orderedNodes
    .map(n => executedSteps.get(n.id))
    .filter((s): s is ExecutedWorkflowStep => Boolean(s && s.output.trim()));

  const contentSteps = orderedSteps.filter(s => s.kind === 'model' || s.kind === 'agent');
  const sinkConnectorSteps = orderedSteps.filter(
    s => s.kind === 'connector' && !sourceNodeIds.has(s.id) && s.invokedTool !== 'dry_run',
  );
  const primaryStepText = contentSteps[contentSteps.length - 1]?.output.trim() ?? '';
  const primaryProseLen = primaryStepText.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim().length;

  const rawCoord = coordinatorText.trim();
  const coordUsable =
    rawCoord && !rawCoord.includes('[truncated ') && !rawCoord.startsWith('{"role":"tool"')
      ? rawCoord
      : '';

  const sections: string[] = [];
  if (
    primaryProseLen >= 300 &&
    (!coordUsable ||
      (!coordUsable.includes(primaryStepText.slice(0, 120)) &&
        coordUsable.length < primaryProseLen * 0.7))
  ) {
    sections.push(primaryStepText);
    if (coordUsable) {
      sections.push(`---\n\n${coordUsable}`);
    }
  } else if (coordUsable) {
    sections.push(coordUsable);
  } else if (primaryStepText) {
    sections.push(primaryStepText);
  } else if (orderedSteps.length > 0) {
    sections.push(orderedSteps[orderedSteps.length - 1]!.output.trim());
  }

  const joinedSoFar = sections.join('\n\n');
  for (const conn of sinkConnectorSteps) {
    const summary = conn.output.trim();
    if (summary && !joinedSoFar.includes(summary)) {
      sections.push(`---\n\n**${conn.label}:** ${summary}`);
    }
  }
  for (const asset of globalAssets) {
    const rawUrlMatch = asset.match(/\((https?:\/\/[^)]+)\)/);
    const checkToken = rawUrlMatch?.[1] ?? asset;
    if (!sections.some(s => s.includes(checkToken))) sections.push(asset);
  }
  return sections.join('\n\n').trim();
}

function buildCoordinatorMessage(params: {
  flow: Listing;
  coordinator: Coordinator;
  waves: Block[][];
  orderedNodes: Block[];
  incomingByNode: Map<string, string[]>;
  priorStepOutputs: Record<string, string>;
  connectedBindings: ReadonlySet<string>;
  connectorActionSummaries: ReadonlyMap<string, string>;
  userInput?: string;
  attachments: WorkflowAttachment[];
  dry: boolean;
  isResumingThread: boolean;
}): string {
  const {
    flow,
    coordinator,
    waves,
    orderedNodes,
    incomingByNode,
    priorStepOutputs,
    connectedBindings,
    connectorActionSummaries,
    userInput,
    attachments,
    dry,
    isResumingThread,
  } = params;

  const completedNodes = orderedNodes.filter(n => priorStepOutputs[n.id] !== undefined);
  const pendingNodes = orderedNodes.filter(n => priorStepOutputs[n.id] === undefined);
  const firstPending = pendingNodes[0];

  const formatStepSpec = (node: Block, idx: number): string => {
    const deps = incomingByNode.get(node.id) ?? [];
    const entry = node.data.entry;
    const completed = priorStepOutputs[node.id];
    const bindingId = node.data.kind === 'connector' ? canonicalConnectorBindingId(entry) : null;
    const bindingLower = bindingId?.toLowerCase() ?? '';
    const cleanModelId =
      node.data.kind === 'model' && entry?.id ? entry.id.trim().replace(/^model:/i, '') : null;
    const isAuthorizedConnector = Boolean(bindingLower && connectedBindings.has(bindingLower));
    const actionSummary =
      completed === undefined && bindingLower && !dry
        ? connectorActionSummaries.get(bindingLower) ?? ''
        : '';
    return [
      `${idx + 1}. [${node.id}] "${node.data.label}" (${node.data.kind})`,
      bindingId
        ? `   target: ${entry?.name ?? bindingId} (bindingId: ${bindingId}, connectorRef: connector:${bindingLower})`
        : cleanModelId
          ? `   target: ${entry?.name ?? cleanModelId} (id: ${cleanModelId}, modelRef: model:${cleanModelId})`
          : entry
            ? `   target: ${entry.name} (id: ${entry.id})`
            : '',
      cleanModelId && completed === undefined
        ? `   modelRule: Pre-registered as "model:${cleanModelId}" — invoke models_call({ modelRef: "model:${cleanModelId}", ... }) directly.`
        : '',
      bindingId && completed === undefined && !dry
        ? isAuthorizedConnector
          ? actionSummary
            ? `   connectorRule: Pre-registered as "connector:${bindingLower}" — invoke connectors_call({ connectorRef: "connector:${bindingLower}", action: "<ACTION>", args: { ... } }) directly using the schema below (if a required parent/container ID is not explicitly provided in this request, perform at most ONE targeted search/list call to obtain a top-level parent container, then execute the write action; NEVER browse, inspect, or modify unrelated existing pages or items).\n   actions (* = required):\n${actionSummary}`
            : `   connectorRule: Pre-registered as "connector:${bindingLower}" — invoke connectors_call({ connectorRef: "connector:${bindingLower}", action: "<ACTION>", args: { ... } }) or discover actions via connectors_find -> connector_select({ bindingId: "${bindingId}" }).`
          : `   connectorRule: Discover/select "${bindingId}" via connectors_find -> connector_select (or propose_connector if authorization is required), then execute the connector action.`
        : '',
      deps.length > 0 ? `   dependsOn: ${deps.join(', ')}` : '',
      node.data.note?.trim() ? `   instructions: ${node.data.note.trim()}` : '',
      completed !== undefined
        ? `   status: ALREADY COMPLETED — DO NOT RE-RUN OR RE-VERIFY\n   completedOutput:\n${sanitizePromptStepOutput(completed)}`
        : '   status: PENDING — EXECUTE NOW',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const isolationRule =
    'Isolation: Treat this run as strictly self-contained. NEVER access, modify, or cite URLs, page IDs, database IDs, or artifacts from prior workflows or unrelated workspace items not explicitly provided in this User request, step instructions, or Completed upstream outputs.';

  if (isResumingThread && completedNodes.length > 0 && firstPending) {
    return [
      `RESUME WORKFLOW "${flow.name}" STARTING IMMEDIATELY AT STEP [${firstPending.id}] "${firstPending.data.label}".`,
      `Steps already completed in this thread (${completedNodes.map(n => `[${n.id}] "${n.data.label}"`).join(', ')}) are IMMUTABLE — DO NOT re-run, re-select, or re-execute any completed step.`,
      isolationRule,
      dry
        ? 'Mode: DRY RUN — do NOT mutate external accounts or submit irreversible transactions.'
        : 'Mode: LIVE RUN — execute all pending external connector actions and deliver the upstream output.',
      `Completed upstream outputs & pending steps:\n${orderedNodes.map((n, i) => formatStepSpec(n, i)).join('\n\n')}`,
      userInput?.trim() ? `User request:\n${userInput.trim()}` : '',
      formatWorkflowAttachments(attachments),
      `Execute ONLY the PENDING steps starting with [${firstPending.id}] "${firstPending.data.label}". Do NOT call \`proposal\` except for \`agent\` steps.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const waveSummary = waves
    .map((wave, i) => `Wave ${i + 1}: ${wave.map(n => `${n.data.label} (${n.id})`).join(' || ')}`)
    .join('\n');

  return [
    `Execute workflow "${flow.name}".`,
    flow.brief?.trim() ? `Brief: ${flow.brief.trim()}` : '',
    coordinator.personality?.trim() ? `Directive: ${coordinator.personality.trim()}` : '',
    isolationRule,
    dry
      ? 'Mode: DRY RUN — execute read/model steps, do NOT mutate external accounts or submit irreversible transactions.'
      : 'Mode: LIVE RUN — execute every step including external connector deliveries.',
    `DAG waves:\n${waveSummary}`,
    `Steps:\n${orderedNodes.map((n, i) => formatStepSpec(n, i)).join('\n\n')}`,
    userInput?.trim() ? `User request:\n${userInput.trim()}` : '',
    formatWorkflowAttachments(attachments),
    'Run pending steps in DAG wave order using your native tools. Do NOT call `proposal` except for `agent` steps. Return the final deliverable once all steps finish.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runWorkflow(params: {
  flow: Listing;
  coordinator: Coordinator;
  runSdk: ComposeSDK;
  runId: string;
  threadId: string;
  subject?: string;
  userInput?: string;
  attachments?: WorkflowAttachment[];
  priorStepOutputs?: Record<string, string>;
  dry?: boolean;
  requireProof?: boolean;
  isResumingThread?: boolean;
  hasConnectorDecisions?: boolean;
  fetchImpl?: typeof fetch;
  emitEvent: (event: Record<string, unknown>) => void;
  onBillDelta: (deltaWei: bigint) => void;
  onStepProgress?: (progress: {
    runningStepId: string | null;
    stepOutputs: Record<string, string>;
  }) => void;
}): Promise<WorkflowResult> {
  const {
    flow,
    coordinator,
    runSdk,
    runId,
    threadId,
    subject,
    userInput,
    attachments = [],
    priorStepOutputs = {},
    dry = false,
    requireProof = false,
    isResumingThread = false,
    hasConnectorDecisions = false,
    fetchImpl,
    emitEvent,
    onBillDelta,
    onStepProgress,
  } = params;

  const { waves, orderedNodes, incomingByNode } = decomposeWorkflowWaves(flow.nodes, flow.edges);
  const stepOutputs: Record<string, string> = { ...priorStepOutputs };
  const startedSteps = new Set<string>(Object.keys(priorStepOutputs));
  const completedSteps = new Set<string>(Object.keys(priorStepOutputs));
  const stepStartTimes = new Map<string, number>();
  const stepAssets = new Map<string, string[]>();
  const stepErrors = new Map<string, string>();
  const stepPublishedUrls = new Map<string, string[]>();
  const spanToStepId = new Map<string, string>();
  const stepToolCallIds = new Map<string, Set<string>>();
  const turnStartedAtMs = Date.now();
  const turnRunIds = new Set<string>(isResumingThread ? [] : [runId]);
  const spanStreamBuffers = new Map<string, string>();
  const toolCallTextBuffers = new Map<string, string>();
  const stepStreamBuffers = new Map<string, string>();
  const exposedActionToBinding = new Map<string, string>();
  const missingVarsBySlug = new Map<
    string,
    NonNullable<MissingConnectorRequirement['missingVars']>
  >();
  const gatedFallbackBySlug = new Map<string, MissingConnectorRequirement>();
  const executedSteps = new Map<string, ExecutedWorkflowStep>();
  const globalAssets: string[] = [];
  let activitySeq = 0;

  const emitActivity = (item: {
    stepId: string | null;
    kind: string;
    status: 'running' | 'completed' | 'pending' | 'failed';
    title: string;
    summary?: string;
  }) => {
    activitySeq += 1;
    emitEvent({
      type: 'sse:activity',
      id: `act-${activitySeq}`,
      ts: Date.now(),
      stepId: item.stepId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      ...(item.summary ? { summary: item.summary } : {}),
    });
  };

  for (const node of orderedNodes) {
    const prior = priorStepOutputs[node.id];
    if (prior !== undefined) {
      executedSteps.set(node.id, {
        id: node.id,
        label: node.data.label,
        kind: node.data.kind,
        entryId: node.data.entry?.id ?? null,
        billWei: '0',
        output: prior,
        stepInput: { stepId: node.id, resumed: true },
        invokedTool: 'cached',
        inferenceRunIds: [runId],
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      emitEvent({
        type: 'step:done',
        stepId: node.id,
        label: node.data.label,
        kind: node.data.kind,
        output: prior,
      });
    }
  }

  let backpackAccounts:
    | Array<{
      slug: string;
      name: string;
      connected: boolean;
      accountId?: string;
      status?: string;
    }>
    | undefined;

  const connectedBindings = new Set<string>();
  const connectedSlugs = new Set<string>();

  for (const node of orderedNodes) {
    if (node.data.kind !== 'connector') continue;
    const binding = canonicalConnectorBindingId(node.data.entry);
    if (binding?.startsWith('onchain:')) {
      connectedBindings.add(binding.toLowerCase());
      connectedSlugs.add(binding.slice('onchain:'.length).toLowerCase());
    }
  }

  const preflightStatus =
    subject && orderedNodes.some(n => n.data.kind === 'connector' || n.data.kind === 'agent')
      ? await runSdk.connectors.status({ userAddress: subject }).catch(() => null)
      : null;

  if (subject && preflightStatus) {
    for (const acc of preflightStatus.accounts ?? []) {
      if (acc.connected) {
        const slugLower = acc.slug.toLowerCase();
        connectedSlugs.add(slugLower);
        connectedBindings.add(`account:${slugLower}`);
      }
    }
    for (const conn of preflightStatus.connectors ?? []) {
      if (conn.connected && (conn.missingVars?.length ?? 0) === 0) {
        const slugLower = conn.slug.toLowerCase();
        connectedSlugs.add(slugLower);
        connectedBindings.add(`mcp:${slugLower}`);
      }
    }

    for (const node of orderedNodes) {
      if (node.data.kind !== 'connector') continue;
      const binding = canonicalConnectorBindingId(node.data.entry);
      if (!binding) continue;
      if (binding.startsWith('account:')) {
        const toolkit = binding.slice('account:'.length).toLowerCase();
        const matchAcc =
          (preflightStatus.accounts ?? []).find(
            a => a.slug.toLowerCase() === toolkit && a.connected,
          ) ?? (preflightStatus.accounts ?? []).find(a => a.slug.toLowerCase() === toolkit);
        if (matchAcc?.connected) {
          if (!matchAcc.granted) {
            await runSdk.connectors.accounts
              .grant({ userAddress: subject, toolkit: matchAcc.slug })
              .catch(() => undefined);
            matchAcc.granted = true;
          }
          connectedBindings.add(binding.toLowerCase());
          connectedSlugs.add(toolkit);
        }
      } else if (binding.startsWith('mcp:')) {
        const rawMcpSlug = binding.slice('mcp:'.length);
        const mcpSlug = rawMcpSlug.toLowerCase();
        const matchConn =
          (preflightStatus.connectors ?? []).find(
            c => c.slug.toLowerCase() === mcpSlug && c.connected,
          ) ?? (preflightStatus.connectors ?? []).find(c => c.slug.toLowerCase() === mcpSlug);
        if (matchConn?.connected && (matchConn.missingVars?.length ?? 0) === 0) {
          if (!matchConn.allowed) {
            await runSdk.connectors.gated
              .grant({ userAddress: subject, slug: matchConn.slug })
              .catch(() => undefined);
          }
          connectedBindings.add(binding.toLowerCase());
          connectedSlugs.add(mcpSlug);
        } else if (matchConn?.missingVars?.length) {
          missingVarsBySlug.set(mcpSlug, matchConn.missingVars);
        } else if (!matchConn) {
          const serverInfo = await runSdk.connectors.mcps
            ?.get?.(rawMcpSlug)
            .catch(() => null);
          const rawCreds = (
            serverInfo as {
              credentials?: Array<{ varName: string; description?: string; obtainUrl?: string }>;
            } | null
          )?.credentials;
          const requiredSpecs = Array.isArray(rawCreds)
            ? rawCreds.filter(c => typeof c?.varName === 'string' && c.varName.trim().length > 0)
            : [];
          if (requiredSpecs.length > 0) {
            missingVarsBySlug.set(mcpSlug, requiredSpecs);
          } else {
            // Public/ungated MCP server with zero required credentials
            connectedBindings.add(binding.toLowerCase());
            connectedSlugs.add(mcpSlug);
          }
        }
      }
    }

    if (Array.isArray(preflightStatus.accounts) && preflightStatus.accounts.length > 0) {
      const dedupedBySlug = new Map<
        string,
        {
          slug: string;
          name: string;
          connected: boolean;
          accountId?: string;
          status?: string;
        }
      >();
      for (const acc of preflightStatus.accounts) {
        const key = acc.slug.toLowerCase();
        const existing = dedupedBySlug.get(key);
        if (existing?.connected && !acc.connected) continue;
        dedupedBySlug.set(key, {
          slug: acc.slug,
          name: acc.slug,
          connected: Boolean(acc.connected),
          ...(acc.connectedAccountId ? { accountId: acc.connectedAccountId } : {}),
          ...(acc.status ? { status: acc.status } : {}),
        });
      }
      backpackAccounts = [...dedupedBySlug.values()];
    }
  }

  const hasPendingUpstreamModelOrAgent = orderedNodes.some(
    n => !completedSteps.has(n.id) && (n.data.kind === 'model' || n.data.kind === 'agent'),
  );

  if (!dry && preflightStatus && hasPendingUpstreamModelOrAgent && !hasConnectorDecisions) {
    const preflightMissing: MissingConnectorRequirement[] = [];
    for (const node of orderedNodes) {
      if (node.data.kind !== 'connector' || completedSteps.has(node.id)) continue;
      const binding = canonicalConnectorBindingId(node.data.entry);
      if (!binding) continue;
      const bindingLower = binding.toLowerCase();
      if (binding.startsWith('account:') && !connectedBindings.has(bindingLower)) {
        const slug = binding.slice('account:'.length);
        preflightMissing.push({
          entryId: node.data.entry?.id || binding,
          slug,
          name: node.data.entry?.name || slug,
          type: 'account',
          ...(subject ? { userAddress: subject } : {}),
          reason: `Connect ${node.data.entry?.name || slug} before running this workflow.`,
          agentWallet: coordinator.walletAddress,
          runId,
          threadId,
        });
      } else if (binding.startsWith('mcp:') && !connectedBindings.has(bindingLower)) {
        const rawMcpSlug = binding.slice('mcp:'.length);
        const mcpSlug = rawMcpSlug.toLowerCase();
        const matchConn =
          (preflightStatus.connectors ?? []).find(
            c => c.slug.toLowerCase() === mcpSlug && c.connected,
          ) ?? (preflightStatus.connectors ?? []).find(c => c.slug.toLowerCase() === mcpSlug);
        const knownVars = matchConn?.missingVars?.length
          ? matchConn.missingVars
          : missingVarsBySlug.get(mcpSlug);
        preflightMissing.push({
          entryId: node.data.entry?.id || binding,
          slug: matchConn?.slug || rawMcpSlug,
          name: node.data.entry?.name || matchConn?.name || rawMcpSlug,
          type: 'gated',
          ...(subject ? { userAddress: subject } : {}),
          ...(knownVars?.length ? { missingVars: knownVars } : {}),
          reason: `Configure ${node.data.entry?.name || matchConn?.slug || rawMcpSlug} before running this workflow.`,
          agentWallet: coordinator.walletAddress,
          runId,
          threadId,
        });
      }
    }
    if (preflightMissing.length > 0) {
      emitEvent({ type: 'connector:pause', missing: preflightMissing });
      throw Object.assign(new Error(preflightMissing[0]!.reason), {
        statusCode: 428,
        code: 'CONNECTOR_REQUIRED',
        threadId,
        missing: preflightMissing,
      });
    }
  }

  const selectedModels: Record<string, Record<string, unknown>> = {};
  const selectedConnectors: Record<string, Record<string, unknown>> = {};
  const connectorActionSummaries = new Map<string, string>();
  const pendingActionFetches: Array<Promise<void>> = [];

  for (const node of orderedNodes) {
    if (completedSteps.has(node.id)) continue;
    if (node.data.kind === 'model' && node.data.entry?.id) {
      const cleanModelId = node.data.entry.id.trim().replace(/^model:/i, '');
      if (cleanModelId) {
        const ref = `model:${cleanModelId}`;
        selectedModels[ref] = {
          kind: 'model',
          ref,
          source: 'models_find',
          modelId: cleanModelId,
          ...(node.data.entry.name ? { name: node.data.entry.name } : {}),
          ...(node.data.entry.description ? { description: node.data.entry.description } : {}),
        };
      }
    } else if (node.data.kind === 'connector' && !dry) {
      const binding = canonicalConnectorBindingId(node.data.entry);
      if (!binding) continue;
      const bindingLower = binding.toLowerCase();
      if (connectedBindings.has(bindingLower) || hasConnectorDecisions) {
        connectedBindings.add(bindingLower);
        const origin = binding.startsWith('account:')
          ? 'account'
          : binding.startsWith('onchain:')
            ? 'onchain'
            : 'mcp';
        const ref = `connector:${bindingLower}`;
        selectedConnectors[ref] = {
          kind: 'connector',
          ref,
          source: 'self',
          bindingId: binding,
          origin,
          ...(node.data.entry?.name ? { name: node.data.entry.name } : {}),
          ...(node.data.entry?.description ? { description: node.data.entry.description } : {}),
          credentialGated: false,
          actions: [],
        };
        if (!connectorActionSummaries.has(bindingLower)) {
          connectorActionSummaries.set(bindingLower, '');
          pendingActionFetches.push(
            fetchConnectorActionSummary(runSdk, binding).then(summary => {
              if (summary) connectorActionSummaries.set(bindingLower, summary);
            }),
          );
        }
      }
    }
  }

  if (pendingActionFetches.length > 0) {
    await Promise.all(pendingActionFetches);
  }

  let totalComposeBillWei = 0n;
  const collectedBills: WorkflowBillItem[] = [];
  const coordinatorProviders: string[] = [];
  const coordinatorRunIds: string[] = [];
  const seenReceiptKeys = new Set<string>();
  const sseReceipts: Receipt[] = [];

  const receiptIdentityKey = (receipt: Receipt, requestId?: string | null): string =>
    receipt.id ||
    receipt.paymentIntentId ||
    (receipt.executionRunId
      ? `${receipt.service ?? ''}:${receipt.action ?? ''}:${receipt.executionRunId}:${receipt.checkpointSequence ?? 0}:${receipt.finalAmountWei}`
      : '') ||
    receipt.txHash ||
    `${receipt.subject ?? 'run'}:${receipt.finalAmountWei}:${requestId ?? ''}`;

  const recordReceipt = (receipt: Receipt | undefined, requestId?: string | null) => {
    if (!receipt) return;
    const dedupeKey = receiptIdentityKey(receipt, requestId);
    if (seenReceiptKeys.has(dedupeKey)) return;
    seenReceiptKeys.add(dedupeKey);
    sseReceipts.push(receipt);

    const meta = extractMetaFromReceiptPayload(receipt as unknown as Record<string, unknown>);
    if (meta.billWei > 0n) {
      totalComposeBillWei += meta.billWei;
      onBillDelta(meta.billWei);
    }
    const newBills = extractBillItemsFromReceipt(
      receipt,
      coordinator,
      orderedNodes,
      stepToolCallIds,
    );
    if (newBills.length > 0) {
      collectedBills.push(...newBills);
      emitEvent({
        type: 'sse:bill',
        composeBillWei: totalComposeBillWei.toString(),
        bills: [...collectedBills],
      });
    }
    const provider = meta.provider ?? extractProviderFromReceipt(receipt);
    if (provider) coordinatorProviders.push(provider);
    if (meta.requestId) coordinatorRunIds.push(meta.requestId);
    else if (requestId) coordinatorRunIds.push(requestId);
  };

  const offReceipt = runSdk.events.on('receipt', evt => {
    recordReceipt(evt.receipt, evt.requestId);
  });

  const missingConnectors: MissingConnectorRequirement[] = [];
  const missingInputs: MissingInputRequirement[] = [];
  const activeToolSpans = new Set<string>();
  const settledRequestIds = new Set<string>();
  const pendingWatchQueue: Array<{ runId: string; requestId: string }> = [];
  const streamAbort = new AbortController();
  let pausedForConnector = false;
  let latestModelSpanId: string | null = null;
  let activeStepId: string | null = null;
  let lastCompletedStepId: string | null = null;
  let upstreamError: string | null = null;
  let coordinatorText = '';

  const matchNodeForTool = (
    toolName: string,
    event: Extract<RunEvent, { domain: 'activity' }>,
  ): Block | undefined => {
    const lowerTool = toolName.toLowerCase();
    const mappedBinding = exposedActionToBinding.get(lowerTool);
    const inputObj = asRecord(event.payload?.['input']);
    const rawConnectorRef =
      (typeof inputObj?.['connectorRef'] === 'string' && inputObj['connectorRef']) ||
      (typeof inputObj?.['bindingId'] === 'string' && inputObj['bindingId']) ||
      '';
    const inputBinding = rawConnectorRef.replace(/^connector:/i, '').trim().toLowerCase();
    const effectiveBinding = mappedBinding || inputBinding || undefined;

    const targetText = JSON.stringify({
      tool: toolName,
      binding: effectiveBinding,
      target: event.target,
      input: event.payload?.['input'],
    }).toLowerCase();

    const uncompleted = orderedNodes.filter(n => !completedSteps.has(n.id));
    const allConnectorNodes = orderedNodes.filter(n => n.data.kind === 'connector');

    const findByBinding = (pool: Block[], bindingLower: string): Block | undefined =>
      pool.find(n => {
        if (n.data.kind !== 'connector') return false;
        const b = canonicalConnectorBindingId(n.data.entry)?.toLowerCase();
        const eid = n.data.entry?.id?.toLowerCase();
        return b === bindingLower || eid === bindingLower;
      });

    if (effectiveBinding) {
      const boundMatch =
        findByBinding(uncompleted, effectiveBinding) ??
        findByBinding(allConnectorNodes, effectiveBinding);
      if (boundMatch) return boundMatch;
    }

    const matchByPrefix = (pool: Block[]): Block | undefined =>
      !CONTROL_TOOLS.has(toolName) &&
        toolName !== 'models_call' &&
        toolName !== 'proposal' &&
        toolName !== 'swarm_delegate'
        ? pool.find(n => {
          if (n.data.kind !== 'connector') return false;
          const slug = (n.data.entry?.id ?? '').split(':').pop()?.toLowerCase() ?? '';
          return slug.length >= 2 && lowerTool.startsWith(`${slug}_`);
        })
        : undefined;

    const prefixMatch = matchByPrefix(uncompleted) ?? matchByPrefix(allConnectorNodes);
    if (prefixMatch) return prefixMatch;

    const expectedKind =
      toolName === 'models_call'
        ? 'model'
        : toolName === 'connectors_call' || Boolean(effectiveBinding)
          ? 'connector'
          : toolName === 'proposal' || toolName === 'swarm_delegate'
            ? 'agent'
            : undefined;

    for (const node of uncompleted) {
      if (expectedKind && node.data.kind !== expectedKind) continue;
      const rawId = node.data.entry?.id?.toLowerCase();
      if (!rawId) continue;
      const tail = rawId.split(':').pop() ?? rawId;
      if (targetText.includes(rawId) || (tail.length >= 3 && targetText.includes(tail))) {
        return node;
      }
    }
    if (expectedKind === 'connector') {
      for (const node of allConnectorNodes) {
        const rawId = node.data.entry?.id?.toLowerCase();
        if (!rawId) continue;
        const tail = rawId.split(':').pop() ?? rawId;
        if (targetText.includes(rawId) || (tail.length >= 3 && targetText.includes(tail))) {
          return node;
        }
      }
      return uncompleted.find(n => n.data.kind === 'connector') ?? allConnectorNodes[0];
    }
    return expectedKind ? uncompleted.find(n => n.data.kind === expectedKind) : undefined;
  };

  const recordStepToolCall = (stepId: string, event: RunEvent) => {
    const set = stepToolCallIds.get(stepId) ?? new Set<string>();
    const addCandidate = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) set.add(v.trim());
    };
    const rec = asRecord(event);
    const payload = asRecord(rec?.payload);
    addCandidate(rec?.toolCallId);
    addCandidate(rec?.tool_call_id);
    addCandidate(payload?.toolCallId);
    addCandidate(payload?.tool_call_id);
    const rawOut = payload?.output;
    const outRec =
      typeof rawOut === 'string' && rawOut.trim().startsWith('{')
        ? (() => {
            try {
              return asRecord(JSON.parse(rawOut));
            } catch {
              return null;
            }
          })()
        : asRecord(rawOut);
    addCandidate(outRec?.toolCallId);
    addCandidate(outRec?.tool_call_id);
    const outKwargs = asRecord(outRec?.kwargs);
    addCandidate(outKwargs?.toolCallId);
    addCandidate(outKwargs?.tool_call_id);
    if (event.domain === 'activity' && typeof event.target?.id === 'string' && event.target.id.trim()) {
      set.add(event.target.id.trim());
    }
    if (event.domain === 'activity' && typeof event.spanId === 'string' && event.spanId.trim()) {
      set.add(event.spanId.trim());
    }
    stepToolCallIds.set(stepId, set);
  };

  const handleRunEvent = async (event: RunEvent): Promise<void> => {
    if (typeof event.runId === 'string' && event.runId.trim()) {
      turnRunIds.add(event.runId.trim());
    }
    if (event.domain === 'model') {
      if (activeToolSpans.size > 0) {
        if (event.type === 'model.text.delta' && event.delta) {
          if (typeof event.toolCallId === 'string' && event.toolCallId) {
            toolCallTextBuffers.set(
              event.toolCallId,
              (toolCallTextBuffers.get(event.toolCallId) ?? '') + event.delta,
            );
          }
          if (latestModelSpanId) {
            spanStreamBuffers.set(
              latestModelSpanId,
              (spanStreamBuffers.get(latestModelSpanId) ?? '') + event.delta,
            );
          }
          if (activeStepId) {
            stepStreamBuffers.set(
              activeStepId,
              (stepStreamBuffers.get(activeStepId) ?? '') + event.delta,
            );
          }
          emitEvent({ type: 'sse:delta', stepId: activeStepId, delta: event.delta });
        } else if (event.type === 'model.text.done' && event.text) {
          if (
            typeof event.toolCallId === 'string' &&
            event.toolCallId &&
            !toolCallTextBuffers.get(event.toolCallId)
          ) {
            toolCallTextBuffers.set(event.toolCallId, event.text);
          }
          if (latestModelSpanId && !spanStreamBuffers.get(latestModelSpanId)) {
            spanStreamBuffers.set(latestModelSpanId, event.text);
          }
          if (activeStepId && !stepStreamBuffers.get(activeStepId)) {
            stepStreamBuffers.set(activeStepId, event.text);
          }
        }
      } else {
        if (event.type === 'model.text.delta' && event.delta) {
          coordinatorText += event.delta;
          emitEvent({ type: 'sse:delta', stepId: null, delta: event.delta });
        } else if (event.type === 'model.text.done' && event.text && !coordinatorText) {
          coordinatorText = event.text;
        }
      }
      if (event.type === 'model.asset' && event.asset && !event.asset.partial && event.asset.url) {
        const formatted =
          event.asset.kind === 'image' ? `![Generated image](${event.asset.url})` : event.asset.url;
        if (!globalAssets.includes(formatted)) globalAssets.push(formatted);
        const targetStepId = activeStepId ?? lastCompletedStepId;
        if (targetStepId) {
          const list = stepAssets.get(targetStepId) ?? [];
          if (!list.includes(formatted)) list.push(formatted);
          stepAssets.set(targetStepId, list);
          if (stepOutputs[targetStepId]) {
            const upgraded = replaceDataUrisWithHostedUrls(stepOutputs[targetStepId]!, list);
            if (upgraded !== stepOutputs[targetStepId]) {
              stepOutputs[targetStepId] = upgraded;
              const prevExec = executedSteps.get(targetStepId);
              if (prevExec) executedSteps.set(targetStepId, { ...prevExec, output: upgraded });
            }
          }
        }
      }
      if (event.type === 'model.error' && event.error?.code === 'MISSING_MEDIA_INPUT') {
        const details = asRecord(event.error.details);
        const required = Array.isArray(details?.['requiredInputs'])
          ? (details['requiredInputs'] as unknown[]).map(String)
          : ['audio'];
        const stepNode =
          (activeStepId ? orderedNodes.find(n => n.id === activeStepId) : undefined) ??
          orderedNodes.find(n => n.data.kind === 'model' && !completedSteps.has(n.id)) ??
          orderedNodes[0];
        if (stepNode && !missingInputs.some(m => m.stepId === stepNode.id)) {
          missingInputs.push({
            stepId: stepNode.id,
            stepLabel: stepNode.data.label,
            modelId: stepNode.data.entry?.id,
            modelName: stepNode.data.entry?.name,
            acceptedInputs: required,
            reason: event.error.message,
            agentWallet: coordinator.walletAddress,
            runId: event.runId ?? runId,
            threadId,
          });
        }
      }
      return;
    }

    if (event.type === 'activity.thinking' && event.status === 'running') {
      emitActivity({
        stepId: activeStepId,
        kind: 'thinking',
        status: 'running',
        title: activeStepId
          ? `Orchestrating ${orderedNodes.find(n => n.id === activeStepId)?.data.label ?? 'step'}`
          : `${coordinator.name} planning next step`,
      });
      return;
    }

    if (event.type === 'activity.connector') {
      const payload = event.payload ?? {};
      const details = asRecord(event.target?.details) ?? {};
      const state =
        (typeof payload['state'] === 'string' && payload['state']) ||
        (typeof details['decision'] === 'string' && details['decision']) ||
        '';
      const rawBinding =
        (typeof payload['bindingId'] === 'string' && payload['bindingId']) ||
        (typeof event.target?.target === 'string' && event.target.target) ||
        '';
      const bindingTail = rawBinding.split(':').pop()?.toLowerCase() ?? '';
      const connectorNode = orderedNodes.find(n => {
        if (n.data.kind !== 'connector') return false;
        if (!rawBinding) return true;
        const nodeBinding = canonicalConnectorBindingId(n.data.entry)?.toLowerCase() ?? '';
        const nodeEntryId = n.data.entry?.id?.toLowerCase() ?? '';
        return (
          nodeBinding === rawBinding.toLowerCase() ||
          nodeEntryId === rawBinding.toLowerCase() ||
          (bindingTail.length > 0 &&
            (nodeEntryId === bindingTail || nodeEntryId.endsWith(`:${bindingTail}`)))
        );
      });
      const nodeBindingLower = connectorNode
        ? canonicalConnectorBindingId(connectorNode.data.entry)?.toLowerCase() ?? ''
        : '';
      const entryId = connectorNode?.data.entry?.id || rawBinding || 'connector';
      const slug =
        (typeof payload['slug'] === 'string' && payload['slug'].trim()) ||
        (typeof event.target?.name === 'string' && event.target.name.trim()) ||
        (rawBinding ? rawBinding.split(':').pop() : '') ||
        entryId.split(':').pop() ||
        entryId;

      if (event.status === 'completed' || state === 'connected') {
        const idx = missingConnectors.findIndex(
          m => m.entryId === entryId || m.slug.toLowerCase() === slug.toLowerCase(),
        );
        if (idx >= 0) missingConnectors.splice(idx, 1);
        gatedFallbackBySlug.delete(slug.toLowerCase());
        emitActivity({
          stepId: connectorNode?.id ?? activeStepId,
          kind: 'connector',
          status: 'completed',
          title: `Connected · ${connectorNode?.data.entry?.name || slug}`,
        });
        return;
      }

      if (event.status === 'pending' || state === 'requested' || state === 'escalated') {
        const requestId =
          (typeof payload['requestId'] === 'string' && payload['requestId'].trim()) ||
          (typeof details['requestId'] === 'string' && details['requestId'].trim()) ||
          (typeof event.target?.id === 'string' && event.target.id.trim()) ||
          undefined;
        const targetRunId =
          (typeof payload['runId'] === 'string' && payload['runId']) || event.runId || runId;

        const alreadyAuthorized =
          (nodeBindingLower.length > 0 && connectedBindings.has(nodeBindingLower)) ||
          (rawBinding.length > 0 && connectedBindings.has(rawBinding.toLowerCase())) ||
          connectedSlugs.has(slug.toLowerCase());

        if (alreadyAuthorized && requestId && !settledRequestIds.has(requestId)) {
          settledRequestIds.add(requestId);
          const settled = await runSdk.agent
            .decideConnector({
              agentWallet: coordinator.walletAddress,
              runId: targetRunId,
              requestId,
              decision: 'connected',
              ...(subject ? { userAddress: subject } : {}),
            })
            .catch(() => null);
          if (settled) {
            pendingWatchQueue.push({ runId: targetRunId, requestId });
            emitActivity({
              stepId: connectorNode?.id ?? activeStepId,
              kind: 'connector',
              status: 'completed',
              title: `Connected · ${connectorNode?.data.entry?.name || slug}`,
            });
            return;
          }
        }

        const kindRaw =
          (typeof payload['kind'] === 'string' && payload['kind']) ||
          (typeof details['kind'] === 'string' && details['kind']) ||
          (rawBinding.startsWith('account:') || entryId.startsWith('account:')
            ? 'account'
            : 'gated');
        const knownVars = Array.isArray(payload['missingVars'])
          ? (payload['missingVars'] as MissingConnectorRequirement['missingVars'])
          : missingVarsBySlug.get(slug.toLowerCase());

        const nextReq: MissingConnectorRequirement = {
          entryId,
          slug,
          name:
            (typeof payload['name'] === 'string' && payload['name']) ||
            connectorNode?.data.entry?.name ||
            event.target?.name ||
            slug,
          type: kindRaw === 'account' ? 'account' : 'gated',
          ...(subject ? { userAddress: subject } : {}),
          ...(knownVars && knownVars.length > 0 ? { missingVars: knownVars } : {}),
          reason:
            (typeof payload['reason'] === 'string' && payload['reason']) ||
            event.target?.summary ||
            `Connect ${connectorNode?.data.entry?.name || slug} to continue this workflow.`,
          agentWallet: coordinator.walletAddress,
          runId: targetRunId,
          threadId,
          ...(requestId ? { requestId } : {}),
        };
        const existingIdx = missingConnectors.findIndex(
          m => m.entryId === nextReq.entryId || m.slug.toLowerCase() === nextReq.slug.toLowerCase(),
        );
        if (existingIdx >= 0) missingConnectors[existingIdx] = nextReq;
        else missingConnectors.push(nextReq);
        emitActivity({
          stepId: connectorNode?.id ?? activeStepId,
          kind: 'connector',
          status: 'pending',
          title: `Authorization required · ${nextReq.name}`,
          summary: nextReq.reason,
        });
        if (!pausedForConnector) {
          pausedForConnector = true;
          emitEvent({ type: 'connector:pause', missing: [...missingConnectors] });
          void runSdk.agent
            .stop({
              agentWallet: coordinator.walletAddress,
              runId: targetRunId,
              threadId,
            })
            .catch(() => undefined);
          streamAbort.abort();
        }
      }
      return;
    }

    if (event.type === 'activity.plan') {
      const payload = event.payload ?? {};
      if (
        payload['state'] === 'awaiting_approval' &&
        typeof payload['proposalId'] === 'string' &&
        typeof payload['version'] === 'number'
      ) {
        const proposalRunId =
          (typeof payload['runId'] === 'string' && payload['runId']) || event.runId || runId;
        await runSdk.agent.decide({
          agentWallet: coordinator.walletAddress,
          runId: proposalRunId,
          proposalId: payload['proposalId'],
          proposalVersion: payload['version'],
          decision: 'approved',
          ...(subject ? { approver: subject } : {}),
        });
        const watchGen = runSdk.agent.watch(
          {
            agentWallet: coordinator.walletAddress,
            runId: proposalRunId,
            threadId,
          },
          { signal: streamAbort.signal },
        );
        let nextWatch = await watchGen.next();
        while (!nextWatch.done) {
          await handleRunEvent(nextWatch.value);
          nextWatch = await watchGen.next();
        }
        recordReceipt(nextWatch.value?.receipt);
      }
      return;
    }

    if (event.type === 'activity.tool') {
      if (
        !event.name ||
        event.id.startsWith('artifact:') ||
        event.spanId.startsWith('artifact:')
      ) {
        const artifact = asRecord(event.payload?.['artifact']);
        const artifactUrl = typeof artifact?.['url'] === 'string' ? artifact['url'].trim() : '';
        if (artifactUrl) {
          const formatted =
            artifact?.['type'] === 'image'
              ? `![Generated image](${artifactUrl})`
              : artifactUrl;
          if (!globalAssets.includes(formatted)) globalAssets.push(formatted);
          const targetStepId = activeStepId ?? lastCompletedStepId;
          if (targetStepId) {
            const list = stepAssets.get(targetStepId) ?? [];
            if (!list.includes(formatted)) list.push(formatted);
            stepAssets.set(targetStepId, list);
            if (stepOutputs[targetStepId]) {
              const upgraded = replaceDataUrisWithHostedUrls(stepOutputs[targetStepId]!, list);
              if (upgraded !== stepOutputs[targetStepId]) {
                stepOutputs[targetStepId] = upgraded;
                const prevExec = executedSteps.get(targetStepId);
                if (prevExec) executedSteps.set(targetStepId, { ...prevExec, output: upgraded });
                const targetNode = orderedNodes.find(n => n.id === targetStepId);
                if (targetNode) {
                  emitEvent({
                    type: 'step:done',
                    stepId: targetNode.id,
                    label: targetNode.data.label,
                    kind: targetNode.data.kind,
                    output: upgraded,
                  });
                }
              }
            }
          }
        }
        return;
      }

      const toolName = event.name;
      if (event.status === 'running') {
        activeToolSpans.add(event.spanId);
        if (toolName === 'models_call') {
          latestModelSpanId = event.spanId;
          spanStreamBuffers.set(event.spanId, '');
        }
        coordinatorText = '';
      } else {
        activeToolSpans.delete(event.spanId);
        if (latestModelSpanId === event.spanId) {
          latestModelSpanId = null;
        }
      }
      const payload = event.payload ?? {};
      const parsedOut =
        asRecord(unwrapToolOutput(payload['output'])) ??
        asRecord(unwrapToolOutput(payload['error']));

      if (toolName === 'connector_select' && event.status === 'completed' && parsedOut) {
        const selected = asRecord(parsedOut['selected']);
        const bindingId =
          (typeof selected?.['bindingId'] === 'string' && selected['bindingId'].trim()) ||
          (typeof parsedOut['bindingId'] === 'string' && parsedOut['bindingId'].trim()) ||
          '';
        if (bindingId) {
          const bindingKey = bindingId.toLowerCase();
          if (Array.isArray(selected?.['actions'])) {
            for (const rawAct of selected['actions']) {
              const act = asRecord(rawAct);
              if (typeof act?.['name'] === 'string' && act['name'].trim()) {
                exposedActionToBinding.set(act['name'].trim().toLowerCase(), bindingKey);
              }
            }
          }
          if (Array.isArray(parsedOut['exposedTools'])) {
            for (const rawName of parsedOut['exposedTools']) {
              if (typeof rawName === 'string' && rawName.trim()) {
                exposedActionToBinding.set(rawName.trim().toLowerCase(), bindingKey);
              }
            }
          }
        }
        if (parsedOut['state'] === 'credential_gated') {
          const gatedBinding =
            (typeof parsedOut['bindingId'] === 'string' && parsedOut['bindingId'].trim()) ||
            bindingId;
          const gatedSlug =
            (typeof parsedOut['slug'] === 'string' && parsedOut['slug'].trim()) ||
            gatedBinding.split(':').pop() ||
            '';
          if (gatedSlug) {
            if (Array.isArray(parsedOut['missingVars'])) {
              missingVarsBySlug.set(
                gatedSlug.toLowerCase(),
                parsedOut['missingVars'] as NonNullable<MissingConnectorRequirement['missingVars']>,
              );
            }
            const cNode = orderedNodes.find(n => {
              if (n.data.kind !== 'connector') return false;
              const nb = canonicalConnectorBindingId(n.data.entry)?.toLowerCase() ?? '';
              return (
                nb === gatedBinding.toLowerCase() ||
                (n.data.entry?.id ?? '').toLowerCase().endsWith(gatedSlug.toLowerCase())
              );
            });
            const entryId = cNode?.data.entry?.id || gatedBinding || gatedSlug;
            gatedFallbackBySlug.set(gatedSlug.toLowerCase(), {
              entryId,
              slug: gatedSlug,
              name: cNode?.data.entry?.name || gatedSlug,
              type:
                gatedBinding.startsWith('account:') || entryId.startsWith('account:')
                  ? 'account'
                  : 'gated',
              ...(subject ? { userAddress: subject } : {}),
              ...(Array.isArray(parsedOut['missingVars'])
                ? {
                  missingVars: parsedOut[
                    'missingVars'
                  ] as MissingConnectorRequirement['missingVars'],
                }
                : {}),
              reason:
                (typeof parsedOut['message'] === 'string' && parsedOut['message']) ||
                `Connect ${cNode?.data.entry?.name || gatedSlug} to continue this workflow.`,
              agentWallet: coordinator.walletAddress,
              runId: event.runId ?? runId,
              threadId,
            });
          }
        }
        return;
      }

      if (
        event.status !== 'running' &&
        parsedOut &&
        (parsedOut['code'] === 'MISSING_MEDIA_INPUT' || Array.isArray(parsedOut['requiredInputs']))
      ) {
        const modelRec = asRecord(parsedOut['model']);
        const required = Array.isArray(parsedOut['requiredInputs'])
          ? parsedOut['requiredInputs'].map(String)
          : ['audio'];
        const matchedNode =
          (spanToStepId.get(event.spanId)
            ? orderedNodes.find(n => n.id === spanToStepId.get(event.spanId))
            : undefined) ?? matchNodeForTool(toolName, event);
        if (matchedNode && !missingInputs.some(m => m.stepId === matchedNode.id)) {
          missingInputs.push({
            stepId: matchedNode.id,
            stepLabel: matchedNode.data.label,
            modelId:
              (typeof modelRec?.['id'] === 'string' && modelRec['id']) || matchedNode.data.entry?.id,
            modelName:
              (typeof modelRec?.['name'] === 'string' && modelRec['name']) ||
              matchedNode.data.entry?.name,
            acceptedInputs: required,
            reason:
              (typeof parsedOut['error'] === 'string' && parsedOut['error']) ||
              `Provide ${required.join('/')} input for "${matchedNode.data.label}".`,
            agentWallet: coordinator.walletAddress,
            runId: event.runId ?? runId,
            threadId,
          });
        }
        return;
      }

      if (event.status !== 'running' && parsedOut?.['code'] === 'CONNECTOR_AUTH_REQUIRED') {
        const authBinding =
          (typeof parsedOut['bindingId'] === 'string' && parsedOut['bindingId'].trim()) || '';
        const authSlug =
          (typeof parsedOut['slug'] === 'string' && parsedOut['slug'].trim()) ||
          authBinding.split(':').pop() ||
          'connector';
        const matchedNode =
          (spanToStepId.get(event.spanId)
            ? orderedNodes.find(n => n.id === spanToStepId.get(event.spanId))
            : undefined) ?? matchNodeForTool(toolName, event);
        const entryId = matchedNode?.data.entry?.id || authBinding || authSlug;
        const authReq: MissingConnectorRequirement = {
          entryId,
          slug: authSlug,
          name: matchedNode?.data.entry?.name || authSlug,
          type: authBinding.startsWith('account:') || entryId.startsWith('account:') ? 'account' : 'gated',
          ...(subject ? { userAddress: subject } : {}),
          reason:
            (typeof parsedOut['error'] === 'string' && parsedOut['error']) ||
            `Connect ${matchedNode?.data.entry?.name || authSlug} to continue this workflow.`,
          agentWallet: coordinator.walletAddress,
          runId: event.runId ?? runId,
          threadId,
        };
        const existingIdx = missingConnectors.findIndex(
          m => m.entryId === authReq.entryId || m.slug.toLowerCase() === authReq.slug.toLowerCase(),
        );
        if (existingIdx >= 0) missingConnectors[existingIdx] = authReq;
        else missingConnectors.push(authReq);
        if (!pausedForConnector) {
          pausedForConnector = true;
          emitEvent({ type: 'connector:pause', missing: [...missingConnectors] });
          void runSdk.agent
            .stop({
              agentWallet: coordinator.walletAddress,
              runId: event.runId ?? runId,
              threadId,
            })
            .catch(() => undefined);
          streamAbort.abort();
        }
        return;
      }

      if (CONTROL_TOOLS.has(toolName)) return;

      if (event.status === 'running') {
        const node = matchNodeForTool(toolName, event);
        if (node) {
          spanToStepId.set(event.spanId, node.id);
          recordStepToolCall(node.id, event);
          activeStepId = node.id;
          if (toolName === 'models_call') {
            stepStreamBuffers.set(node.id, '');
          }
          if (!startedSteps.has(node.id)) {
            startedSteps.add(node.id);
            stepStartTimes.set(node.id, event.ts || Date.now());
            emitEvent({
              type: 'step:start',
              stepId: node.id,
              label: node.data.label,
              kind: node.data.kind,
            });
            onStepProgress?.({ runningStepId: node.id, stepOutputs: { ...stepOutputs } });
          }
          emitActivity({
            stepId: node.id,
            kind: node.data.kind,
            status: 'running',
            title: `${node.data.kind === 'model' ? 'Model' : node.data.kind === 'connector' ? 'Connector' : 'Agent'} · ${node.data.entry?.name || node.data.label}`,
          });
        }
        return;
      }

      const mappedStepId = spanToStepId.get(event.spanId);
      const node =
        (mappedStepId ? orderedNodes.find(n => n.id === mappedStepId) : undefined) ??
        matchNodeForTool(toolName, event);
      if (node) {
        recordStepToolCall(node.id, event);
      }

      const nestedResult = asRecord(parsedOut?.['result']);
      const toolFailed =
        event.status === 'failed' ||
        Boolean(payload['error']) ||
        parsedOut?.['success'] === false ||
        parsedOut?.['successful'] === false ||
        parsedOut?.['ok'] === false ||
        nestedResult?.['successful'] === false ||
        nestedResult?.['success'] === false;

      if (toolFailed) {
        const errDetail =
          (typeof parsedOut?.['error'] === 'string' && parsedOut['error'].trim()) ||
          (typeof nestedResult?.['error'] === 'string' && nestedResult['error'].trim()) ||
          (typeof parsedOut?.['message'] === 'string' && parsedOut['message'].trim()) ||
          (typeof payload['error'] === 'string' && payload['error'].trim()) ||
          `Tool ${toolName} failed.`;
        if (node) {
          stepErrors.set(node.id, errDetail);
          emitActivity({
            stepId: node.id,
            kind: node.data.kind,
            status: 'failed',
            title: `Failed · ${node.data.entry?.name || node.data.label}`,
            summary: errDetail,
          });
        }
        return;
      }

      if (node && event.status === 'completed') {
        stepErrors.delete(node.id);
        const startedAt = stepStartTimes.get(node.id) ?? event.ts ?? Date.now();
        const endedAt = Date.now();
        const nodeAssets = stepAssets.get(node.id) ?? [];
        const formattedPayload = formatToolStepOutput(payload, nodeAssets);
        const streamedText = (
          (typeof payload['toolCallId'] === 'string' &&
            toolCallTextBuffers.get(payload['toolCallId'])) ||
          spanStreamBuffers.get(event.spanId) ||
          stepStreamBuffers.get(node.id) ||
          ''
        ).trim();

        const rawOutputJson = JSON.stringify(payload['output'] ?? '');
        const wasTruncated =
          formattedPayload.includes('[truncated ') ||
          rawOutputJson.includes('[truncated ') ||
          rawOutputJson.includes('truncated_text');

        let stepText = formattedPayload;
        if (toolName === 'models_call' && streamedText.length > 0 && (!formattedPayload || wasTruncated)) {
          const combined = [streamedText];
          for (const asset of nodeAssets) {
            if (!combined.some(part => part.includes(asset))) combined.push(asset);
          }
          stepText = replaceDataUrisWithHostedUrls(combined.join('\n\n').trim(), nodeAssets);
        }

        if (stepText.includes('data:') && stepText.includes(';base64,')) {
          const pinnedRes = await pinResidualDataUrisInStepOutput(stepText, node.id, fetchImpl);
          stepText = pinnedRes.output;
          if (pinnedRes.pinnedAssets.length > 0) {
            const list = stepAssets.get(node.id) ?? [];
            for (const asset of pinnedRes.pinnedAssets) {
              if (!list.includes(asset)) list.push(asset);
              if (!globalAssets.includes(asset)) globalAssets.push(asset);
            }
            stepAssets.set(node.id, list);
          }
        }

        if (node.data.kind === 'connector') {
          const publishedMatch = stepText.match(/https?:\/\/[^\s)]+/);
          if (publishedMatch && stepText.startsWith('Published:')) {
            const urls = stepPublishedUrls.get(node.id) ?? [];
            if (!urls.includes(publishedMatch[0])) urls.push(publishedMatch[0]);
            stepPublishedUrls.set(node.id, urls);
          }
          const priorUrls = stepPublishedUrls.get(node.id) ?? [];
          for (const url of priorUrls) {
            if (!stepText.includes(url)) {
              stepText = `Published: ${url}\n\n${stepText}`.trim();
            }
          }
        }

        if (!stepText) {
          stepText = event.target?.summary || `Completed ${node.data.label}`;
        }

        stepOutputs[node.id] = stepText;
        completedSteps.add(node.id);
        lastCompletedStepId = node.id;
        if (activeStepId === node.id) activeStepId = null;

        const inputAction = asRecord(payload['input'])?.['action'];
        const recordedTool =
          toolName === 'connectors_call' && typeof inputAction === 'string' && inputAction.trim()
            ? inputAction.trim()
            : toolName;

        executedSteps.set(node.id, {
          id: node.id,
          label: node.data.label,
          kind: node.data.kind,
          entryId: node.data.entry?.id ?? null,
          billWei: '0',
          output: stepText,
          stepInput: payload['input'] ?? { stepId: node.id, label: node.data.label },
          invokedTool: recordedTool,
          inferenceRunIds: event.runId ? [event.runId] : [runId],
          startedAt,
          endedAt,
        });

        emitEvent({
          type: 'step:done',
          stepId: node.id,
          label: node.data.label,
          kind: node.data.kind,
          output: stepText,
        });
        emitActivity({
          stepId: node.id,
          kind: node.data.kind,
          status: 'completed',
          title: `Completed · ${node.data.entry?.name || node.data.label}`,
        });
        onStepProgress?.({ runningStepId: null, stepOutputs: { ...stepOutputs } });
      }
      return;
    }

    if (event.type === 'activity.message' && event.status === 'completed' && event.delta) {
      coordinatorText = event.delta;
      return;
    }

    if (event.type === 'activity.error') {
      upstreamError =
        (typeof event.payload?.['message'] === 'string' && event.payload['message']) ||
        (typeof event.payload?.['error'] === 'string' && event.payload['error']) ||
        'Coordinator runtime execution failed.';
      emitActivity({
        stepId: activeStepId,
        kind: 'error',
        status: 'failed',
        title: 'Execution error',
        summary: upstreamError,
      });
    }
  };

  const message = buildCoordinatorMessage({
    flow,
    coordinator,
    waves,
    orderedNodes,
    incomingByNode,
    priorStepOutputs,
    connectedBindings,
    connectorActionSummaries,
    userInput,
    attachments,
    dry,
    isResumingThread,
  });

  const streamAttachments = attachments.map(att => ({
    type: att.type,
    url: att.url,
    ...(att.mimeType ? { mimeType: att.mimeType } : {}),
    ...(att.name ? { name: att.name } : {}),
  }));

  const constraints: Record<string, unknown> = {
    ...(dry ? { dryRun: true } : {}),
    ...(requireProof ? { requireProof: true } : {}),
  };

  const hasPendingAgentNodes = orderedNodes.some(
    n => !completedSteps.has(n.id) && n.data.kind === 'agent',
  );
  const hasSelectedModels = Object.keys(selectedModels).length > 0;
  const hasSelectedConnectors = Object.keys(selectedConnectors).length > 0;
  const selectedResources =
    hasSelectedModels || hasSelectedConnectors
      ? {
        ...(hasSelectedModels ? { models: selectedModels } : {}),
        ...(hasSelectedConnectors ? { connectors: selectedConnectors } : {}),
      }
      : undefined;

  try {
    const firstPending = orderedNodes.find(n => !completedSteps.has(n.id));
    if (firstPending && !startedSteps.has(firstPending.id)) {
      startedSteps.add(firstPending.id);
      activeStepId = firstPending.id;
      stepStartTimes.set(firstPending.id, Date.now());
      emitEvent({
        type: 'step:start',
        stepId: firstPending.id,
        label: firstPending.data.label,
        kind: firstPending.data.kind,
      });
      onStepProgress?.({ runningStepId: firstPending.id, stepOutputs: { ...stepOutputs } });
    }

    const gen = runSdk.agent.stream(
      {
        agentWallet: coordinator.walletAddress,
        message,
        threadId,
        mode: hasPendingAgentNodes ? 'swarm' : 'solo',
        ...(isResumingThread ? {} : { runId }),
        ...(subject ? { userAddress: subject } : {}),
        ...(backpackAccounts ? { backpackAccounts } : {}),
        ...(selectedResources ? { selectedResources } : {}),
        ...(streamAttachments.length > 0 ? { attachments: streamAttachments } : {}),
        ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
      },
      { signal: streamAbort.signal },
    );

    try {
      let next = await gen.next();
      while (!next.done) {
        await handleRunEvent(next.value);
        next = await gen.next();
      }
      recordReceipt(next.value?.receipt);
    } catch (streamErr) {
      if (!pausedForConnector) {
        throw streamErr;
      }
    }

    while (!pausedForConnector && pendingWatchQueue.length > 0) {
      const watchTarget = pendingWatchQueue.shift()!;
      const watchGen = runSdk.agent.watch(
        {
          agentWallet: coordinator.walletAddress,
          runId: watchTarget.runId,
          threadId,
        },
        { signal: streamAbort.signal },
      );
      try {
        let nextWatch = await watchGen.next();
        while (!nextWatch.done) {
          await handleRunEvent(nextWatch.value);
          nextWatch = await watchGen.next();
        }
        recordReceipt(nextWatch.value?.receipt);
      } catch (watchErr) {
        if (!pausedForConnector) {
          throw watchErr;
        }
      }
    }
  } finally {
    offReceipt();
  }

  const receiptListRes = subject
    ? await runSdk.receipts?.list?.({ limit: 100 }).catch(() => null)
    : null;
  const turnApiReceipts = (receiptListRes?.receipts ?? []).filter(r => {
    const execId = r.executionRunId?.trim() ?? '';
    if (execId) {
      for (const tid of turnRunIds) {
        if (execId === tid || execId.startsWith(`${tid}:`)) return true;
      }
    }
    if (!isResumingThread && r.rootRunId?.trim() === runId) {
      return true;
    }
    if (isResumingThread && turnRunIds.size === 0 && r.rootRunId?.trim() === runId) {
      return (r.settledAt ?? 0) >= turnStartedAtMs - 5_000;
    }
    return false;
  });

  if (turnApiReceipts.length > 0) {
    const mergedByKey = new Map<string, Receipt>();
    for (const r of [...turnApiReceipts].sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))) {
      mergedByKey.set(receiptIdentityKey(r), r);
    }
    for (const r of sseReceipts) {
      const key = receiptIdentityKey(r);
      const alreadyHasRuntime =
        r.service === 'runtime' &&
        Array.from(mergedByKey.values()).some(
          existing =>
            existing.service === 'runtime' &&
            existing.executionRunId === r.executionRunId &&
            existing.finalAmountWei === r.finalAmountWei,
        );
      if (!mergedByKey.has(key) && !alreadyHasRuntime) {
        mergedByKey.set(key, r);
      }
    }

    collectedBills.length = 0;
    let reconciledComposeWei = 0n;
    for (const r of mergedByKey.values()) {
      const amt = parsePositiveBigInt(r.finalAmountWei);
      if (amt > 0n) reconciledComposeWei += amt;
      const items = extractBillItemsFromReceipt(r, coordinator, orderedNodes, stepToolCallIds, true);
      if (items.length > 0) collectedBills.push(...items);
      const meta = extractMetaFromReceiptPayload(r as unknown as Record<string, unknown>);
      const provider = meta.provider ?? extractProviderFromReceipt(r);
      if (provider && !coordinatorProviders.includes(provider)) coordinatorProviders.push(provider);
      if (meta.requestId && !coordinatorRunIds.includes(meta.requestId)) {
        coordinatorRunIds.push(meta.requestId);
      }
    }

    if (reconciledComposeWei !== totalComposeBillWei) {
      onBillDelta(reconciledComposeWei - totalComposeBillWei);
      totalComposeBillWei = reconciledComposeWei;
    }
    emitEvent({
      type: 'sse:bill',
      composeBillWei: totalComposeBillWei.toString(),
      bills: [...collectedBills],
    });
  }

  for (const [slugKey, fallbackReq] of gatedFallbackBySlug.entries()) {
    const connectorDone = orderedNodes.some(n => {
      if (n.data.kind !== 'connector' || !completedSteps.has(n.id)) return false;
      const eid = (n.data.entry?.id ?? '').toLowerCase();
      return eid === fallbackReq.entryId.toLowerCase() || eid.endsWith(slugKey);
    });
    if (
      !connectorDone &&
      !missingConnectors.some(
        m => m.entryId === fallbackReq.entryId || m.slug.toLowerCase() === slugKey,
      )
    ) {
      missingConnectors.push(fallbackReq);
    }
  }

  if (missingConnectors.length > 0) {
    if (!pausedForConnector) {
      emitEvent({ type: 'connector:pause', missing: missingConnectors });
    }
    throw Object.assign(new Error(missingConnectors[0]!.reason), {
      statusCode: 428,
      code: 'CONNECTOR_REQUIRED',
      threadId,
      missing: missingConnectors,
    });
  }

  if (missingInputs.length > 0) {
    emitEvent({ type: 'input:pause', missingInputs });
    throw Object.assign(new Error(missingInputs[0]!.reason), {
      statusCode: 428,
      code: 'INPUT_REQUIRED',
      threadId,
      missingInputs,
    });
  }

  if (upstreamError) {
    throw Object.assign(new Error(upstreamError), { statusCode: 502, threadId });
  }

  // Attribute Coordinator synthesis to a pending specialist agent step if delegated via watch
  const rawSummary = coordinatorText.trim();
  for (const node of orderedNodes) {
    if (!executedSteps.has(node.id) && node.data.kind === 'agent' && rawSummary) {
      stepOutputs[node.id] = rawSummary;
      completedSteps.add(node.id);
      executedSteps.set(node.id, {
        id: node.id,
        label: node.data.label,
        kind: node.data.kind,
        entryId: node.data.entry?.id ?? null,
        billWei: '0',
        output: rawSummary,
        stepInput: { stepId: node.id, label: node.data.label },
        invokedTool: 'proposal',
        inferenceRunIds: coordinatorRunIds.length > 0 ? [...coordinatorRunIds] : [runId],
        startedAt: stepStartTimes.get(node.id) ?? Date.now(),
        endedAt: Date.now(),
      });
      emitEvent({
        type: 'step:done',
        stepId: node.id,
        label: node.data.label,
        kind: node.data.kind,
        output: rawSummary,
      });
    }
  }

  if (dry) {
    for (const node of orderedNodes) {
      if (node.data.kind === 'connector' && !completedSteps.has(node.id)) {
        const dryNote = `[Dry run] Skipped external connector mutation for ${node.data.label}.`;
        stepOutputs[node.id] = dryNote;
        completedSteps.add(node.id);
        executedSteps.set(node.id, {
          id: node.id,
          label: node.data.label,
          kind: node.data.kind,
          entryId: node.data.entry?.id ?? null,
          billWei: '0',
          output: dryNote,
          stepInput: { stepId: node.id, dryRun: true },
          invokedTool: 'dry_run',
          inferenceRunIds: coordinatorRunIds.length > 0 ? [...coordinatorRunIds] : [runId],
          startedAt: stepStartTimes.get(node.id) ?? Date.now(),
          endedAt: Date.now(),
        });
      }
    }
  } else {
    const uncompletedNode = orderedNodes.find(n => !completedSteps.has(n.id));
    if (uncompletedNode) {
      const reason =
        stepErrors.get(uncompletedNode.id) ||
        `Step "${uncompletedNode.data.label}" (${uncompletedNode.data.kind}) did not complete execution.`;
      throw Object.assign(new Error(reason), { statusCode: 502, threadId });
    }
  }

  const finalOutput = assembleFinalDeliverable({
    orderedNodes,
    edges: flow.edges,
    executedSteps,
    coordinatorText,
    globalAssets,
  });

  const usedBillIndexes = new Set<number>();
  const latestProvider = coordinatorProviders[coordinatorProviders.length - 1];
  const stepBillMap = new Map<string, bigint>();
  const baseSteps = orderedNodes
    .map(node => executedSteps.get(node.id))
    .filter((step): step is ExecutedWorkflowStep => Boolean(step));

  for (const step of baseSteps) {
    stepBillMap.set(step.id, parsePositiveBigInt(step.billWei));
  }

  for (let i = 0; i < collectedBills.length; i++) {
    const b = collectedBills[i]!;
    if (b.category === 'coordinator') continue;
    if (b.stepId && stepBillMap.has(b.stepId)) {
      stepBillMap.set(b.stepId, (stepBillMap.get(b.stepId) ?? 0n) + parsePositiveBigInt(b.amountWei));
      usedBillIndexes.add(i);
    }
  }

  for (let i = 0; i < collectedBills.length; i++) {
    if (usedBillIndexes.has(i)) continue;
    const b = collectedBills[i]!;
    if (b.category === 'coordinator' || !b.subject) continue;
    const matchedStep = baseSteps.find(step => {
      if (step.kind !== b.category) return false;
      const node = orderedNodes.find(n => n.id === step.id);
      return matchesStepSubject(node?.data.entry, step.kind, b.subject!);
    });
    if (matchedStep) {
      stepBillMap.set(
        matchedStep.id,
        (stepBillMap.get(matchedStep.id) ?? 0n) + parsePositiveBigInt(b.amountWei),
      );
      usedBillIndexes.add(i);
    }
  }

  const finalSteps = baseSteps.map(step => ({
    ...step,
    billWei: (stepBillMap.get(step.id) ?? 0n).toString(),
    ...(step.provider || !latestProvider ? {} : { provider: latestProvider }),
    inferenceRunIds:
      step.inferenceRunIds.length > 0
        ? step.inferenceRunIds
        : coordinatorRunIds.length > 0
          ? [...coordinatorRunIds]
          : [runId],
  }));

  onStepProgress?.({ runningStepId: null, stepOutputs: { ...stepOutputs } });

  return {
    output: finalOutput,
    steps: finalSteps,
    bills: collectedBills,
    coordinatorBillWei: totalComposeBillWei,
    coordinatorProviders,
    coordinatorRunIds: coordinatorRunIds.length > 0 ? coordinatorRunIds : [runId],
    totalComposeBillWei,
    stepOutputs,
  };
}
