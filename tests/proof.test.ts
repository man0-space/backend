import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProofAccumulator,
  canonicalJson,
  hashValue,
  pinProofBundleToIPFS,
} from '../proof.js';
import { extractReceiptMeta } from '../payment.js';

test('canonicalJson and hashValue produce identical SHA-256 hashes regardless of object key order', () => {
  const a = { z: 1, a: { y: true, x: [3, 2, 1] }, skip: undefined };
  const b = { a: { x: [3, 2, 1], y: true }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashValue(a), hashValue(b));
  assert.match(hashValue(a), /^0x[a-f0-9]{64}$/);
});

test('extractReceiptMeta extracts provider, model, requestId, and billWei from X-Receipt and bills', () => {
  const receiptB64 = Buffer.from(
    JSON.stringify({
      finalAmountWei: '18500',
      subject: 'fireworks:accounts/fireworks/models/deepseek-v3',
      executionRunId: 'inf-run-77',
    }),
    'utf8',
  ).toString('base64');

  const res = new Response('{}', {
    status: 200,
    headers: { 'X-Receipt': receiptB64 },
  });

  const meta = extractReceiptMeta(res, {});
  assert.equal(meta.billWei, 18_500n);
  assert.equal(meta.provider, 'fireworks');
  assert.equal(meta.model, 'accounts/fireworks/models/deepseek-v3');
  assert.equal(meta.requestId, 'inf-run-77');
});

test('ProofAccumulator records provider strictly on model and agent steps and pins CIDv1 bundle', async () => {
  const acc = new ProofAccumulator({
    runId: 'run-proof-1',
    workflowId: 'wf-proof-1',
    chainWorkflowId: 42,
    coordinatorWallet: '0ua0cexhh24pgqk9zecxa0tc9z8hd4e4aq49wy2s9dhrwwr8wgc2d0',
    planSnapshot: { steps: ['s1', 's2', 's3'] },
    startedAt: 1_700_000_000_000,
  });

  acc.recordStep({
    stepId: 's1',
    kind: 'model',
    entryId: 'nebius:deepseek-ai/DeepSeek-V3',
    provider: 'nebius',
    stepInput: 'Analyze yield curves',
    stepOutput: 'Curve summary',
    invokedTool: 'responses:nebius:deepseek-ai/DeepSeek-V3',
    inferenceRunIds: ['req-1'],
    startedAt: 1_700_000_000_010,
    endedAt: 1_700_000_000_210,
  });

  acc.recordStep({
    stepId: 's2',
    kind: 'connector',
    entryId: 'mcp:coingecko',
    provider: 'should-not-appear-on-connector',
    stepInput: { coin: 'near' },
    stepOutput: { usd: 5.42 },
    invokedTool: 'mcp:coingecko/get_price',
    startedAt: 1_700_000_000_220,
    endedAt: 1_700_000_000_320,
  });

  acc.recordStep({
    stepId: 's3',
    kind: 'agent',
    entryId: '0ua0cexhh24pgqk9zecxa0tc9z8hd4e4aq49wy2s9dhrwwr8wgc2d0',
    provider: 'fireworks',
    stepInput: { summary: 'Curve summary' },
    stepOutput: 'Final recommendation',
    invokedTool: 'agent:0ua0cexhh24pgqk9zecxa0tc9z8hd4e4aq49wy2s9dhrwwr8wgc2d0:stream',
    inferenceRunIds: ['req-2'],
    startedAt: 1_700_000_000_330,
    endedAt: 1_700_000_000_530,
  });

  const bundle = acc.finalize(1_700_000_000_600);
  assert.equal(bundle.schemaVersion, 'proof');
  assert.equal(bundle.steps.length, 3);
  assert.equal(bundle.steps[0]!.provider, 'nebius');
  assert.equal(bundle.steps[0]!.wallMs, 200);
  assert.equal('provider' in bundle.steps[1]!, false);
  assert.equal(bundle.steps[2]!.provider, 'fireworks');
  assert.deepEqual(bundle.inferenceRunIds, ['req-1', 'req-2']);

  let capturedBody: Record<string, unknown> | null = null;
  const pinned = await pinProofBundleToIPFS(bundle, async (url, init) => {
    assert.equal(url, 'https://api.pinata.cloud/pinning/pinJSONToIPFS');
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ IpfsHash: 'bafkreiproofbundlecidv10000000000000000000000001' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  assert.equal(pinned.proofCid, 'bafkreiproofbundlecidv10000000000000000000000001');
  assert.ok(pinned.proofUrl.endsWith('/ipfs/bafkreiproofbundlecidv10000000000000000000000001'));
  assert.deepEqual(capturedBody?.['pinataOptions'], { cidVersion: 1 });
  const pinnedContent = capturedBody?.['pinataContent'] as { steps: Array<{ provider?: string }> };
  assert.equal(pinnedContent.steps[0]!.provider, 'nebius');
  assert.equal(pinnedContent.steps[1]!.provider, undefined);
  assert.equal(pinnedContent.steps[2]!.provider, 'fireworks');
});
