import { createHash } from 'node:crypto';
import { config } from './config.js';

export interface ProofStepRecord {
  stepId: string;
  kind: 'model' | 'connector' | 'agent';
  entryId: string | null;
  provider?: string;
  inputHash: string;
  outputHash: string;
  invokedTool: string;
  inferenceRunIds: string[];
  startedAt: number;
  endedAt: number;
  wallMs: number;
}

export interface ProofBundle {
  schemaVersion: 'proof';
  runId: string;
  workflowId: string;
  chainWorkflowId?: number | null;
  coordinatorWallet?: string | null;
  planHash: string;
  steps: ProofStepRecord[];
  inferenceRunIds: string[];
  startedAt: number;
  endedAt: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(key => obj[key] !== undefined)
    .sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

export function hashValue(value: unknown): string {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export class ProofAccumulator {
  private readonly steps: ProofStepRecord[] = [];
  private readonly inferenceRunIds = new Set<string>();
  private readonly startedAt: number;
  private readonly planHash: string;

  constructor(
    private readonly meta: {
      runId: string;
      workflowId: string;
      chainWorkflowId?: number | null;
      coordinatorWallet?: string | null;
      planSnapshot: unknown;
      startedAt?: number;
    },
  ) {
    this.startedAt = meta.startedAt ?? Date.now();
    this.planHash = hashValue(meta.planSnapshot);
  }

  recordStep(input: {
    stepId: string;
    kind: 'model' | 'connector' | 'agent';
    entryId: string | null;
    provider?: string;
    stepInput: unknown;
    stepOutput: unknown;
    invokedTool: string;
    inferenceRunIds?: string[];
    startedAt: number;
    endedAt?: number;
  }): ProofStepRecord {
    const endedAt = input.endedAt ?? Date.now();
    const runIds = [...new Set((input.inferenceRunIds ?? []).filter(Boolean))];
    for (const id of runIds) {
      this.inferenceRunIds.add(id);
    }

    const record: ProofStepRecord = {
      stepId: input.stepId,
      kind: input.kind,
      entryId: input.entryId,
      ...((input.kind === 'model' || input.kind === 'agent') && input.provider
        ? { provider: input.provider }
        : {}),
      inputHash: hashValue(input.stepInput),
      outputHash: hashValue(input.stepOutput),
      invokedTool: input.invokedTool,
      inferenceRunIds: runIds,
      startedAt: input.startedAt,
      endedAt,
      wallMs: Math.max(0, endedAt - input.startedAt),
    };
    this.steps.push(record);
    return record;
  }

  finalize(endedAt = Date.now()): ProofBundle {
    return {
      schemaVersion: 'proof',
      runId: this.meta.runId,
      workflowId: this.meta.workflowId,
      ...(this.meta.chainWorkflowId !== undefined
        ? { chainWorkflowId: this.meta.chainWorkflowId }
        : {}),
      ...(this.meta.coordinatorWallet ? { coordinatorWallet: this.meta.coordinatorWallet } : {}),
      planHash: this.planHash,
      steps: [...this.steps],
      inferenceRunIds: [...this.inferenceRunIds],
      startedAt: this.startedAt,
      endedAt: Math.max(this.startedAt, endedAt),
    };
  }
}

export async function pinProofBundleToIPFS(
  bundle: ProofBundle,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ proofCid: string; proofUrl: string; planHash: string }> {
  const res = await fetchImpl('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.pinataJwt}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      pinataOptions: { cidVersion: 1 },
      pinataMetadata: {
        name: `man0-proof-${bundle.runId}`,
        keyvalues: {
          app: 'man0',
          schemaVersion: bundle.schemaVersion,
          workflowId: bundle.workflowId,
          runId: bundle.runId,
        },
      },
      pinataContent: JSON.parse(canonicalJson(bundle)) as Record<string, unknown>,
    }),
  });

  if (!res.ok) {
    throw Object.assign(new Error(`Failed to pin proof bundle to IPFS (${res.status}).`), {
      statusCode: 502,
    });
  }

  const pinned = (await res.json()) as { IpfsHash?: string };
  if (!pinned.IpfsHash) {
    throw Object.assign(new Error('Pinata returned no IpfsHash for proof bundle.'), {
      statusCode: 502,
    });
  }

  return {
    proofCid: pinned.IpfsHash,
    proofUrl: `https://${config.pinataGateway}/ipfs/${pinned.IpfsHash}`,
    planHash: bundle.planHash,
  };
}
