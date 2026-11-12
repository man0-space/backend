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
    service === 'runtime' &&
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
      service === 'runtime'
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
