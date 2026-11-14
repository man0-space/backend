import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ready } from '../databases/cache.js';
import { user, workflow } from '../databases/client.js';
import * as workflows from '../databases/workflows.js';
import { privateKey, issuer } from '../auth/config.js';
import { sign } from '../auth/token.js';
import { digest } from '../auth/digest.js';
import { decomposeWorkflowWaves, formatWorkflowAttachments } from '../agents/coordinator.js';
import { build } from '../server.js';

const creatorAddress = `alice-${randomUUID().slice(0, 8)}.testnet`;
const spendingSub = `0u${randomBytes(26).toString('hex').slice(0, 51)}g`;
const fastCoordWallet = '0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g';
let mintedCoordWallet = '0u333333333333333333333333333333333333333333333333333g';
const nearContractCalls: Array<{ contractId: string; methodName: string; args: Record<string, unknown> }> = [];
const creatorJwt = await sign(
  privateKey,
  issuer!,
  creatorAddress,
  randomBytes(32).toString('base64url'),
  3600,
);

function makeComposeSessionToken(sub: string, network = 'near:testnet'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      keyId: `key-${randomUUID().slice(0, 8)}`,
      network,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `compose-${header}.${payload}.sig`;
}

const sessionToken = makeComposeSessionToken(creatorAddress, 'near:testnet');

const pinnedProofBodies: Array<Record<string, unknown>> = [];
const agentUpserts: Array<Record<string, unknown>> = [];
const agentStreams: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
const preparedPayments: Array<Record<string, unknown>> = [];
const settledPayments: Array<Record<string, unknown>> = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (url.endsWith('/api/x402/facilitator/chains')) {
    return new Response(
      JSON.stringify({
        defaultNetwork: 'near:testnet',
        chains: [
          {
            name: 'NEAR Testnet',
            network: 'near:testnet',
            namespace: 'near',
            shortName: 'near-testnet',
            isTestnet: true,
            explorer: 'https://testnet.nearblocks.io',
            rpcUrl: 'https://rpc.testnet.near.org',
            assetAddress: 'usdc.tidepool-sandbox.testnet',
            assetSymbol: 'USDC',
            assetDecimals: 6,
            schemes: ['exact', 'upto', 'batch-settlement'],
          },
          {
            name: 'NEAR Mainnet',
            network: 'near:mainnet',
            namespace: 'near',
            shortName: 'near',
            isTestnet: false,
            explorer: 'https://nearblocks.io',
            rpcUrl: 'https://rpc.mainnet.near.org',
            assetAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
            assetSymbol: 'USDC',
            assetDecimals: 6,
            schemes: ['exact', 'upto', 'batch-settlement'],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url.endsWith('/api/payments/prepare')) {
    const rawBody =
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    preparedPayments.push(JSON.parse(rawBody || '{}') as Record<string, unknown>);
    const hdrs = new Headers(input instanceof Request ? input.headers : init?.headers);
    const sessionUser = hdrs.get('x-session-user-address')?.trim() || creatorAddress;
    return new Response(
      JSON.stringify({
        paymentIntentId: `pi-${randomUUID().slice(0, 8)}`,
        userAddress: sessionUser,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url.endsWith('/api/payments/settle')) {
    const rawBody =
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    settledPayments.push(JSON.parse(rawBody || '{}') as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        status: 'settled',
        txHash: 'near-fee-settle-tx-1',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url.endsWith('/api/payments/abort')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.startsWith('https://agents.compose.market/agents') && !url.endsWith('/upsert')) {
    return new Response(
      JSON.stringify({
        agents: [
          {
            name: 'Coordinator',
            walletAddress: '0x71C6F6E87210a443591d33d9B7314524049D3BcE',
            role: 'coordinator',
            framework: 'man0',
            model: 'gemini-3.8-flash',
            network: 'eip155:5042002',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
          {
            name: 'Fast executor',
            walletAddress: '0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g',
            role: 'coordinator',
            framework: 'man0',
            model: 'gemini-3.8-flash',
            network: 'near:testnet',
            createdAt: '2026-06-10T00:00:00.000Z',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url === 'https://agents.compose.market/agents/upsert') {
    agentUpserts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.includes('/agent/') && url.endsWith('/stream')) {
    const rawBody =
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    const parsedStreamBody = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    const hdrObj: Record<string, string> = {};
    new Headers(input instanceof Request ? input.headers : init?.headers).forEach((v, k) => {
      hdrObj[k.toLowerCase()] = v;
    });
    agentStreams.push({ url, headers: hdrObj, body: parsedStreamBody });

    const messageText = typeof parsedStreamBody.message === 'string' ? parsedStreamBody.message : '';
    const streamAttachments = Array.isArray(parsedStreamBody.attachments)
      ? (parsedStreamBody.attachments as Array<{ type?: string; url?: string }>)
      : [];
    const connectorDecisionHdr = hdrObj['x-connector-decision'] ?? '';

    if (messageText.includes('account:notion_mcp') && !connectorDecisionHdr.includes(':connected')) {
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.connector',
          id: 'connector:req-notion-1',
          kind: 'connector',
          status: 'pending',
          spanId: 'connector:req-notion-1',
          ts: Date.now(),
          payload: {
            requestId: 'req-notion-1',
            kind: 'account',
            bindingId: 'account:notion_mcp',
            slug: 'notion_mcp',
            name: 'Notion MCP',
            state: 'requested',
            reason: 'Required by workflow',
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    if (messageText.includes('deepgram:nova-3') && !streamAttachments.some(a => a.type === 'audio')) {
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:asr-1:end',
          kind: 'tool',
          status: 'failed',
          spanId: 'tool:asr-1',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            output: {
              success: false,
              code: 'MISSING_MEDIA_INPUT',
              requiredInputs: ['audio'],
              model: {
                id: 'deepgram:nova-3',
                name: 'Deepgram Nova 3',
              },
              error: 'Provide audio input for "Transcribe Audio" (Deepgram Nova 3).',
            },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    const isCustomCoord = url.includes(fastCoordWallet);
    const amountWei = isCustomCoord ? '40000' : '25000';
    const outputText = isCustomCoord
      ? 'Coordinator executed full DAG plan.'
      : 'DeepSeek synthesized alpha report.';

    const receiptPayload = {
      finalAmountWei: amountWei,
      network: 'near:testnet',
      subject: 'fireworks:accounts/fireworks/models/deepseek-v3',
      txHash: 'near-stream-tx-1',
      executionRunId: 'coord-turn-1',
    };
    const receiptB64 = Buffer.from(JSON.stringify(receiptPayload), 'utf8').toString('base64');

    const sse = [
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 'tool:step-1:start',
        kind: 'tool',
        status: 'running',
        spanId: 'tool:step-1',
        name: 'models_call',
        ts: Date.now(),
        payload: { input: { modelRef: 'model:fireworks:accounts/fireworks/models/deepseek-v3' } },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 'tool:step-1:end',
        kind: 'tool',
        status: 'completed',
        spanId: 'tool:step-1',
        name: 'models_call',
        ts: Date.now(),
        payload: { output: outputText },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'model',
        type: 'model.text.delta',
        id: 'msg-1',
        ts: Date.now(),
        delta: outputText,
      })}\n\n`,
      `event: receipt\ndata: ${JSON.stringify(receiptPayload)}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    return new Response(sse, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'X-Receipt': receiptB64,
      },
    });
  }

  if (url.includes('/connectors/status')) {
    return new Response(
      JSON.stringify({ userAddress: creatorAddress, accounts: [], connectors: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url === 'https://api.pinata.cloud/pinning/pinJSONToIPFS') {
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    pinnedProofBodies.push(parsed);
    return new Response(
      JSON.stringify({
        IpfsHash: 'bafkreirunproofcidv19999999999999999999999999999',
        PinSize: 512,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url === 'https://api.pinata.cloud/pinning/pinFileToIPFS') {
    return new Response(
      JSON.stringify({
        IpfsHash: 'bafkreiattachmentcidv1888888888888888888888888888',
        PinSize: 2048,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  throw new Error(`Unexpected fetch URL in run.test.ts: ${url}`);
};

let app: Awaited<ReturnType<typeof build>>;
const wfId = randomUUID();

before(async () => {
  await ready();
  app = await build({
    fetchImpl: mockFetch,
    viewContractImpl: async ({ methodName, args }) => {
      if (methodName === 'get_agent') {
        const agentId = (args as { agent_id: number }).agent_id;
        return {
          agent_id: agentId,
          creator: creatorAddress,
          owner: creatorAddress,
          agent_wallet: mintedCoordWallet,
          uri: 'ipfs://bafkreicoordcard',
        } as never;
      }
      return null as never;
    },
    executeContractImpl: async (_userAddress, callInput) => {
      if (callInput.methodName === 'set_agent_wallet' && typeof callInput.args['new_wallet'] === 'string') {
        mintedCoordWallet = callInput.args['new_wallet'];
      }
      nearContractCalls.push({
        contractId: callInput.contractId,
        methodName: callInput.methodName,
        args: callInput.args,
      });
      return {
        txHash: `near-contract-${callInput.methodName}-tx`,
        signerId: creatorAddress,
        network: 'testnet',
        result: callInput.methodName === 'register_agent' ? 8 : null,
        logs: [],
      };
    },
  });

  await user`INSERT INTO users ("userAddress", name) VALUES (${creatorAddress}, 'Creator Runner')`;
  await user`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "spendingAddress" text, ADD COLUMN IF NOT EXISTS "spendingState" text`;
  await user`INSERT INTO accounts ("userAddress", network, state, code, status, "spendingAddress") VALUES (${creatorAddress}, 'testnet', '{}', 'test', 'active', ${spendingSub})`;
  await user`INSERT INTO tokens (id, "userAddress", jwt, expires) VALUES (${digest(creatorJwt)}, ${creatorAddress}, 'run fixture', now() + interval '1 hour')`;
  const policyRes = await app.inject({ method: 'GET', url: '/api/policy' });
  await app.inject({
    method: 'POST',
    url: '/api/consent',
    headers: { authorization: `Bearer ${creatorJwt}` },
    payload: { policy: policyRes.json().hash, terms: true, privacy: true },
  });
});

after(async () => {
  await workflow`DELETE FROM threads WHERE scope LIKE ${`${creatorAddress.toLowerCase()}:%`}`.catch(
    () => undefined,
  );
  await workflow`DELETE FROM coordinators WHERE "userAddress" = ${creatorAddress}`;
  await workflow`DELETE FROM runs WHERE "userAddress" = ${creatorAddress}`;
  await workflow`DELETE FROM workflows WHERE "userAddress" = ${creatorAddress}`;
  await user`DELETE FROM consents WHERE "userAddress" = ${creatorAddress}`;
  await user`DELETE FROM tokens WHERE "userAddress" = ${creatorAddress}`;
  await user`DELETE FROM accounts WHERE "userAddress" = ${creatorAddress}`;
  await user`DELETE FROM users WHERE "userAddress" = ${creatorAddress}`;
  await app.close();
});

test('decomposeWorkflowWaves decomposes diamond DAGs into symmetric parallel waves and rejects cycles', () => {
  const n1 = randomUUID();
  const n2 = randomUUID();
  const n3 = randomUUID();
  const n4 = randomUUID();

  const diamondFlow = {
    id: randomUUID(),
    name: 'Diamond Pipeline',
    brief: 'Parallel research and synthesis',
    nodes: [
      {
        id: n1,
        type: 'step' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Ingest',
          kind: 'connector' as const,
          note: 'Fetch feeds',
          entry: {
            id: 'mcp:exa',
            kind: 'connector' as const,
            name: 'Exa Search',
            description: 'Web search MCP',
            groups: ['search'],
          },
        },
      },
      {
        id: n2,
        type: 'step' as const,
        position: { x: 200, y: -80 },
        data: {
          label: 'Quant Branch',
          kind: 'agent' as const,
          note: 'Analyze metrics',
          entry: {
            id: '0x1111111111111111111111111111111111111111',
            kind: 'agent' as const,
            name: 'Quant Agent',
            description: 'Metrics specialist',
            groups: ['finance'],
          },
        },
      },
      {
        id: n3,
        type: 'step' as const,
        position: { x: 200, y: 80 },
        data: {
          label: 'Macro Branch',
          kind: 'model' as const,
          note: 'Analyze macro',
          entry: {
            id: 'fireworks:accounts/fireworks/models/deepseek-v3',
            kind: 'model' as const,
            name: 'DeepSeek V3',
            description: 'Reasoning model',
            groups: ['text'],
          },
        },
      },
      {
        id: n4,
        type: 'step' as const,
        position: { x: 400, y: 0 },
        data: {
          label: 'Merge Brief',
          kind: 'model' as const,
          note: 'Combine findings',
          entry: {
            id: 'fireworks:accounts/fireworks/models/deepseek-v3',
            kind: 'model' as const,
            name: 'DeepSeek V3',
            description: 'Reasoning model',
            groups: ['text'],
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: n1, target: n2 },
      { id: 'e2', source: n1, target: n3 },
      { id: 'e3', source: n2, target: n4 },
      { id: 'e4', source: n3, target: n4 },
    ],
    modified: new Date().toISOString(),
  };

  const { waves, orderedNodes, incomingByNode } = decomposeWorkflowWaves(
    diamondFlow.nodes,
    diamondFlow.edges,
  );
  assert.equal(waves.length, 3);
  assert.equal(waves[1]!.length, 2);
  assert.equal(orderedNodes.length, 4);
  assert.deepEqual(incomingByNode.get(n2), [n1]);
  assert.deepEqual(incomingByNode.get(n3), [n1]);
  assert.deepEqual(incomingByNode.get(n4), [n2, n3]);

  const formattedAtt = formatWorkflowAttachments([
    {
      type: 'text',
      url: 'https://ipfs.io/ipfs/bafkreinotes',
      name: 'notes.md',
      text: 'Hello DAG',
    },
  ]);
  assert.match(formattedAtt, /notes\.md/);
  assert.match(formattedAtt, /Hello DAG/);

  assert.throws(
    () =>
      decomposeWorkflowWaves(
        diamondFlow.nodes,
        [...diamondFlow.edges, { id: 'cycle', source: n4, target: n1 }],
      ),
    /cycle/i,
  );
});

test('POST /api/workflows/:id/run and POST /api/draft/run reject unauthenticated callers with 401', async () => {
  const unauthRun = await app.inject({
    method: 'POST',
    url: `/api/workflows/${wfId}/run`,
    payload: { input: 'hello' },
  });
  assert.equal(unauthRun.statusCode, 401);

  const unauthDraft = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    payload: {
      flow: {
        id: randomUUID(),
        name: 'Draft',
        brief: '',
        nodes: [],
        edges: [],
        modified: new Date().toISOString(),
      },
    },
  });
  assert.equal(unauthDraft.statusCode, 401);
});

test('GET /api/coordinators merges agents.compose.market?role=coordinator and DB rows sorted newest-first without wallet/network rejections', async () => {
  const headers = { authorization: `Bearer ${creatorJwt}` };

  const publicListRes = await app.inject({
    method: 'GET',
    url: '/api/coordinators',
  });
  assert.equal(publicListRes.statusCode, 200);
  const publicList = publicListRes.json() as Array<{ walletAddress: string; name: string }>;
  const fastIdx = publicList.findIndex(
    c => c.walletAddress === '0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g',
  );
  const evmIdx = publicList.findIndex(
    c => c.walletAddress === '0x71C6F6E87210a443591d33d9B7314524049D3BcE',
  );
  assert.ok(fastIdx >= 0, 'Fast executor (0u...) must be present');
  assert.ok(evmIdx >= 0, 'Coordinator (0x...) must be accepted without prefix/network rejection');
  assert.ok(fastIdx < evmIdx, 'Newest catalog Coordinator must sort ahead of older Coordinator');

  agentUpserts.length = 0;
  pinnedProofBodies.length = 0;
  nearContractCalls.length = 0;
  const minted = await app.inject({
    method: 'POST',
    url: '/api/coordinators/mint',
    headers,
    payload: {
      name: 'Vega',
      image: 'https://jabyl.mypinata.cloud/ipfs/bafkreiavatar2',
      personality: 'Precision transcription & synthesis coordinator',
      model: 'gemini-3.6-flash',
      contractId: 'factory.man0u.testnet',
      network: 'near:testnet',
    },
  });
  assert.equal(minted.statusCode, 200, minted.body);
  assert.match(minted.json().walletAddress, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{51}[0g]$/);
  assert.equal(minted.json().walletAddress, mintedCoordWallet);
  assert.equal(minted.json().agentId, 8);
  assert.equal(nearContractCalls.length, 2);
  assert.equal(nearContractCalls[0]!.methodName, 'register_agent');
  assert.equal(nearContractCalls[1]!.methodName, 'set_agent_wallet');
  assert.equal(nearContractCalls[1]!.args['new_wallet'], mintedCoordWallet);
  assert.equal(agentUpserts.length, 1);
  const pinnedCoordMeta = pinnedProofBodies[0]!['pinataMetadata'] as { keyvalues?: Record<string, unknown> };
  assert.equal(pinnedCoordMeta?.keyvalues?.['type'], 'agent-card');
  const pinnedCoordCard = pinnedProofBodies[0]!['pinataContent'] as Record<string, unknown>;
  assert.equal(pinnedCoordCard['walletAddress'], mintedCoordWallet);
  assert.equal(pinnedCoordCard['creatorFee'], 1);
  assert.equal('dnaHash' in pinnedCoordCard, false);
  assert.equal('walletTimestamp' in pinnedCoordCard, false);

  const listed = await app.inject({
    method: 'GET',
    url: '/api/coordinators',
    headers,
  });
  assert.equal(listed.statusCode, 200);
  const merged = listed.json() as Array<{ walletAddress: string; name: string }>;
  assert.equal(merged[0]!.walletAddress, mintedCoordWallet);
  assert.ok(merged.some(c => c.walletAddress === '0x71C6F6E87210a443591d33d9B7314524049D3BcE'));
});

test('All workflow runs execute via Coordinator /agent/:wallet/stream, Facilitator fee settlement, and IPFS proof only on live Run', async () => {
  const stepNodeId = randomUUID();
  const baseFlow = {
    id: wfId,
    name: 'Alpha Synthesis',
    brief: 'Synthesize market alpha',
    nodes: [
      {
        id: stepNodeId,
        type: 'step' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Synthesize',
          kind: 'model' as const,
          note: 'Summarize market structure',
          entry: {
            id: 'fireworks:accounts/fireworks/models/deepseek-v3',
            kind: 'model' as const,
            name: 'DeepSeek V3',
            description: 'Reasoning model',
            groups: ['text'],
          },
        },
      },
    ],
    edges: [],
    modified: new Date().toISOString(),
  };

  const saved = await workflows.save(baseFlow, creatorAddress);
  await workflows.publish(
    wfId,
    creatorAddress,
    { creatorFee: 2, tasks: ['Research'], description: 'Published workflow' },
    saved.modified,
  );

  const runHeaders = {
    authorization: `Bearer ${creatorJwt}`,
    'x-compose-key': sessionToken,
    'x-network-id': 'near:testnet',
  };

  // 1. Canvas Test (/api/draft/run) -> routes via default Coordinator stream, auto-approves turn-run-1, NO proofCid pinned!
  pinnedProofBodies.length = 0;
  agentStreams.length = 0;
  preparedPayments.length = 0;
  settledPayments.length = 0;

  const draftTestRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: runHeaders,
    payload: { flow: baseFlow, input: 'Test draft input' },
  });
  assert.equal(draftTestRes.statusCode, 200);
  const draftJson = draftTestRes.json();
  assert.equal(draftJson.composeBillWei, '25000');
  assert.equal(draftJson.totalChargedWei, '25500');
  assert.equal(draftJson.proofCid, null);
  assert.equal(draftJson.proofUrl, null);
  assert.equal(pinnedProofBodies.length, 0);
  assert.equal(agentStreams.length, 1);
  assert.equal(preparedPayments[0]!['service'], 'workflow');
  assert.equal(preparedPayments[0]!['action'], 'run');
  assert.ok(agentStreams[0]!.url.includes(`/agent/${mintedCoordWallet}/stream`));
  assert.equal('approvedPlan' in agentStreams[0]!.body, false);
  assert.equal('agentCard' in agentStreams[0]!.body, false);
  const streamConstraints = agentStreams[0]!.body['constraints'] as
    | {
      dryRun?: boolean;
      requireProof?: boolean;
    }
    | undefined;
  assert.equal(streamConstraints?.dryRun, undefined);
  assert.equal(streamConstraints?.requireProof, undefined);

  // 2. Workflow Run with dry: true -> Session billed (25000 + 2% platform = 25500 wei via Facilitator prepare+settle), NO proofCid pinned!
  const dryRunRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${wfId}/run`,
    headers: runHeaders,
    payload: { input: 'Dry run input', dry: true },
  });
  assert.equal(dryRunRes.statusCode, 200);
  const dryJson = dryRunRes.json();
  assert.equal(dryJson.dry, true);
  assert.equal(dryJson.composeBillWei, '25000');
  assert.equal(dryJson.totalChargedWei, '25500');
  assert.equal(dryJson.proofCid, null);
  assert.equal(dryJson.proofUrl, null);
  assert.equal(pinnedProofBodies.length, 0);
  assert.equal((agentStreams[1]!.body['constraints'] as { dryRun?: boolean }).dryRun, true);
  assert.equal(preparedPayments.length, 2);
  assert.equal(settledPayments.length, 2);
  assert.equal(settledPayments[1]!['finalAmountWei'], '500');

  // 3. Live Workflow Run (dry: false) -> Session billed AND proof.ts pinned with provider inside IPFS payload, never in client JSON!
  const liveRunRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${wfId}/run`,
    headers: runHeaders,
    payload: { input: 'Live production input', dry: false },
  });
  assert.equal(liveRunRes.statusCode, 200);
  const liveJson = liveRunRes.json();
  assert.equal(liveJson.dry, false);
  assert.equal(liveJson.composeBillWei, '25000');
  assert.equal(liveJson.totalChargedWei, '25500');
  assert.equal(liveJson.proofCid, 'bafkreirunproofcidv19999999999999999999999999999');
  assert.ok(liveJson.proofUrl.endsWith('/ipfs/bafkreirunproofcidv19999999999999999999999999999'));
  assert.equal((agentStreams[2]!.body['constraints'] as { requireProof?: boolean }).requireProof, true);
  assert.equal('provider' in liveJson, false);
  assert.equal('provider' in liveJson.steps[0], false);

  assert.equal(pinnedProofBodies.length, 1);
  const pinnedContent = pinnedProofBodies[0]!['pinataContent'] as {
    schemaVersion: string;
    steps: Array<{ provider?: string }>;
  };
  assert.equal(pinnedContent.schemaVersion, 'proof');
  assert.equal(pinnedContent.steps[0]!.provider, 'fireworks');

  // 4. Custom Coordinator-governed draft Test AND runner Coordinator override -> executes stream on selected Coordinator wallet
  const coordList = (
    await app.inject({
      method: 'GET',
      url: '/api/coordinators',
      headers: { authorization: `Bearer ${creatorJwt}` },
    })
  ).json() as Array<{ walletAddress: string; name: string }>;
  const fastCoord = coordList.find(c => c.walletAddress === fastCoordWallet)!;
  const evmCoord = coordList.find(
    c => c.walletAddress === '0x71C6F6E87210a443591d33d9B7314524049D3BcE',
  )!;
  assert.ok(fastCoord, 'Fast executor coordinator must be selectable');
  assert.ok(evmCoord, '0x Coordinator must be selectable without rejection');

  const coordDraftRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: runHeaders,
    payload: {
      flow: {
        ...baseFlow,
        id: randomUUID(),
        coordinator: fastCoord,
      },
      input: 'Run via Fast Coordinator',
    },
  });
  assert.equal(coordDraftRes.statusCode, 200);
  assert.equal(coordDraftRes.json().output, 'Coordinator executed full DAG plan.');
  assert.equal(coordDraftRes.json().composeBillWei, '40000');
  assert.equal(coordDraftRes.json().proofCid, null);

  const overrideBeforeIdx = agentStreams.length;
  const runnerOverrideRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${wfId}/run`,
    headers: runHeaders,
    payload: {
      input: 'Runner selected EVM Coordinator explicitly',
      dry: true,
      coordinator: evmCoord,
    },
  });
  assert.equal(runnerOverrideRes.statusCode, 200, runnerOverrideRes.body);
  assert.ok(
    agentStreams[overrideBeforeIdx]!.url.includes(
      '/agent/0x71C6F6E87210a443591d33d9B7314524049D3BcE/stream',
    ),
  );

  // 5. Prefixed legacy entry IDs normalize cleanly and Prompt-to-Connect returns 428 CONNECTOR_REQUIRED with session subject
  const spendingSessionToken = makeComposeSessionToken(spendingSub, 'near:testnet');
  const spendingRunHeaders = {
    authorization: `Bearer ${creatorJwt}`,
    'x-compose-key': spendingSessionToken,
    'x-network-id': 'near:testnet',
  };

  const prefixedOnchainFlow = {
    id: randomUUID(),
    name: 'Prefixed Onchain & Model',
    brief: 'Normalized refs',
    nodes: [
      {
        id: randomUUID(),
        type: 'step' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Token Lookup',
          kind: 'connector' as const,
          note: 'Check ERC-20 metadata',
          entry: {
            id: 'connector:onchain:erc20',
            kind: 'connector' as const,
            name: 'ERC-20',
            description: 'On-chain token tools',
            groups: ['onchain'],
          },
        },
      },
      {
        id: randomUUID(),
        type: 'step' as const,
        position: { x: 240, y: 0 },
        data: {
          label: 'Summarize',
          kind: 'model' as const,
          note: 'Summarize token',
          entry: {
            id: 'model:gemini:gemini-3.6-flash',
            kind: 'model' as const,
            name: 'Gemini 3.6 Flash',
            description: 'Fast model',
            groups: ['text'],
          },
        },
      },
    ],
    edges: [],
    modified: new Date().toISOString(),
  };

  const onchainDraftRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: spendingRunHeaders,
    payload: { flow: prefixedOnchainFlow, dry: true },
  });
  assert.equal(onchainDraftRes.statusCode, 200, onchainDraftRes.body);

  const notionFlow = {
    id: randomUUID(),
    name: 'Save to Notion',
    brief: 'Requires Notion MCP',
    nodes: [
      {
        id: randomUUID(),
        type: 'step' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Save to Notion',
          kind: 'connector' as const,
          note: 'Create Notion page',
          entry: {
            id: 'account:notion_mcp',
            kind: 'connector' as const,
            name: 'Notion MCP',
            description: 'Notion workspace',
            groups: ['accounts'],
          },
        },
      },
    ],
    edges: [],
    modified: new Date().toISOString(),
  };

  const promptConnectRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: spendingRunHeaders,
    payload: { flow: notionFlow, dry: true },
  });
  assert.equal(promptConnectRes.statusCode, 428);
  const promptBody = promptConnectRes.json();
  assert.equal(promptBody.code, 'CONNECTOR_REQUIRED');
  assert.equal(promptBody.missing.length, 1);
  assert.equal(promptBody.missing[0].entryId, 'account:notion_mcp');
  assert.equal(promptBody.missing[0].slug, 'notion_mcp');
  assert.equal(promptBody.missing[0].type, 'account');
  assert.equal(promptBody.missing[0].userAddress, spendingSub);

  // 6. Multimodal attachments: /api/uploads pins WAV audio + extracts inline text, and /api/draft/run forwards attachment + context
  const fakeWavBase64 = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary').toString('base64');
  const uploadAudioRes = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { authorization: `Bearer ${creatorJwt}` },
    payload: {
      fileName: 'voice-test.wav',
      mimeType: 'audio/wav',
      fileBase64: fakeWavBase64,
    },
  });
  assert.equal(uploadAudioRes.statusCode, 200, uploadAudioRes.body);
  const uploadedAudio = uploadAudioRes.json();
  assert.equal(uploadedAudio.type, 'audio');
  assert.equal(uploadedAudio.mimeType, 'audio/wav');
  assert.ok(uploadedAudio.url.endsWith('/ipfs/bafkreiattachmentcidv1888888888888888888888888888'));

  const uploadDocRes = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { authorization: `Bearer ${creatorJwt}` },
    payload: {
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      fileBase64: Buffer.from('# Sprint Notes\nShip NEAR Testnet E2E.', 'utf8').toString('base64'),
    },
  });
  assert.equal(uploadDocRes.statusCode, 200, uploadDocRes.body);
  const uploadedDoc = uploadDocRes.json();
  assert.equal(uploadedDoc.type, 'text');
  assert.match(uploadedDoc.text, /Ship NEAR Testnet E2E/);

  const beforeStreamCount = agentStreams.length;
  const multimodalRunRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: runHeaders,
    payload: {
      flow: { ...baseFlow, id: randomUUID() },
      input: 'Transcribe the clip and cross-check the notes.',
      attachments: [uploadedAudio, uploadedDoc],
      dry: true,
    },
  });
  assert.equal(multimodalRunRes.statusCode, 200, multimodalRunRes.body);
  const latestStreamBody = agentStreams[beforeStreamCount]!.body;
  assert.deepEqual((latestStreamBody['attachments'] as unknown[])[0], {
    type: 'audio',
    url: uploadedAudio.url,
    mimeType: 'audio/wav',
    name: 'voice-test.wav',
  });
  assert.match(String(latestStreamBody['message']), /voice-test\.wav/);
  assert.match(String(latestStreamBody['message']), /Ship NEAR Testnet E2E/);

  // 7. Dynamic 'clarify' gate pauses text-only run on audio-only ASR step (0 charged) and succeeds with .wav attachment
  const asrFlow = {
    id: randomUUID(),
    name: 'Speech Transcription',
    brief: 'Transcribe audio',
    nodes: [
      {
        id: randomUUID(),
        type: 'step' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Transcribe Audio',
          kind: 'model' as const,
          note: 'Transcribe recorded speech accurately',
          entry: {
            id: 'deepgram:nova-3',
            kind: 'model' as const,
            name: 'Deepgram Nova 3',
            description: 'Speech-to-text',
          },
        },
      },
    ],
    edges: [],
    modified: new Date().toISOString(),
  };

  const missingAudioRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: runHeaders,
    payload: { flow: asrFlow, input: 'Transcribe this text without audio', dry: true },
  });
  assert.equal(missingAudioRes.statusCode, 428);
  const missingAudioJson = missingAudioRes.json();
  assert.equal(missingAudioJson.code, 'INPUT_REQUIRED');
  assert.equal(missingAudioJson.missingInputs.length, 1);
  assert.deepEqual(missingAudioJson.missingInputs[0].acceptedInputs, ['audio']);

  const withAudioRes = await app.inject({
    method: 'POST',
    url: '/api/draft/run',
    headers: runHeaders,
    payload: {
      flow: asrFlow,
      input: 'Transcribe attached clip',
      attachments: [uploadedAudio],
      dry: true,
    },
  });
  assert.equal(withAudioRes.statusCode, 200, withAudioRes.body);

  // 8. Separate recoverable workflow threads keyed by userAddress:workflowId + /watch NDJSON recovery & same-threadId resumption
  const asrSaved = await workflows.save(asrFlow, creatorAddress);
  await workflows.publish(
    asrFlow.id,
    creatorAddress,
    { creatorFee: 0, tasks: ['Audio'], description: 'Published ASR workflow' },
    asrSaved.modified,
  );

  const threadOneId = `wf-${asrFlow.id}-thread-1`;
  const threadTwoId = `wf-${asrFlow.id}-thread-2`;

  // Thread 1 pauses with 428 INPUT_REQUIRED
  const pausedRunRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${asrFlow.id}/run`,
    headers: spendingRunHeaders,
    payload: {
      input: 'Episode 1 voice notes without audio yet',
      threadId: threadOneId,
      dry: true,
    },
  });
  assert.equal(pausedRunRes.statusCode, 428, pausedRunRes.body);
  assert.equal(pausedRunRes.json().code, 'INPUT_REQUIRED');
  assert.equal(pausedRunRes.json().threadId, threadOneId);

  // Thread 1 is persisted under creatorAddress:asrFlow.id even when run used spendingAddress session sub
  const threadOneGet = await app.inject({
    method: 'GET',
    url: `/api/workflows/${asrFlow.id}/threads/${encodeURIComponent(threadOneId)}`,
    headers: { authorization: `Bearer ${creatorJwt}` },
  });
  assert.equal(threadOneGet.statusCode, 200, threadOneGet.body);
  assert.equal(threadOneGet.json().status, 'input_required');
  assert.equal(threadOneGet.json().userAddress, creatorAddress);

  // /watch replays thread:init + input:pause + 428 INPUT_REQUIRED error after reload/disconnect
  const watchPausedRes = await app.inject({
    method: 'GET',
    url: `/api/workflows/${asrFlow.id}/threads/${encodeURIComponent(threadOneId)}/watch`,
    headers: {
      authorization: `Bearer ${creatorJwt}`,
      accept: 'application/x-ndjson',
    },
  });
  assert.equal(watchPausedRes.statusCode, 200);
  const pausedLines = watchPausedRes.body
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { type: string; code?: string; threadId?: string });
  assert.equal(pausedLines[0]!.type, 'thread:init');
  assert.ok(pausedLines.some(l => l.type === 'input:pause'));
  assert.ok(pausedLines.some(l => l.type === 'error' && l.code === 'INPUT_REQUIRED'));

  // Resuming Thread 1 omits runId on /agent/:wallet/stream so runtime resumes its checkpointed rootRunId
  const resumeStreamIdx = agentStreams.length;
  const resumedRunRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${asrFlow.id}/run`,
    headers: spendingRunHeaders,
    payload: {
      input: 'Episode 1 voice notes with audio attached',
      attachments: [uploadedAudio],
      threadId: threadOneId,
      dry: true,
    },
  });
  assert.equal(resumedRunRes.statusCode, 200, resumedRunRes.body);
  assert.equal(resumedRunRes.json().threadId, threadOneId);
  assert.equal(agentStreams[resumeStreamIdx]!.body['threadId'], threadOneId);
  assert.equal('runId' in agentStreams[resumeStreamIdx]!.body, false);

  // Starting Thread 2 creates a separate thread in GET /api/workflows/:id/threads
  const secondThreadRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${asrFlow.id}/run`,
    headers: spendingRunHeaders,
    payload: {
      input: 'Episode 2 separate thread',
      attachments: [uploadedAudio],
      threadId: threadTwoId,
      dry: true,
    },
  });
  assert.equal(secondThreadRes.statusCode, 200, secondThreadRes.body);

  const allThreadsRes = await app.inject({
    method: 'GET',
    url: `/api/workflows/${asrFlow.id}/threads`,
    headers: { authorization: `Bearer ${creatorJwt}` },
  });
  assert.equal(allThreadsRes.statusCode, 200);
  const allThreads = allThreadsRes.json() as Array<{ threadId: string; status: string }>;
  assert.equal(allThreads.length, 2);
  assert.equal(allThreads[0]!.threadId, threadTwoId);
  assert.equal(allThreads[0]!.status, 'succeeded');
  assert.equal(allThreads[1]!.threadId, threadOneId);
  assert.equal(allThreads[1]!.status, 'succeeded');

  // /watch on settled Thread 1 replays terminal result immediately
  const watchDoneRes = await app.inject({
    method: 'GET',
    url: `/api/workflows/${asrFlow.id}/threads/${encodeURIComponent(threadOneId)}/watch`,
    headers: {
      authorization: `Bearer ${creatorJwt}`,
      accept: 'application/x-ndjson',
    },
  });
  assert.equal(watchDoneRes.statusCode, 200);
  const doneLines = watchDoneRes.body
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { type: string });
  assert.ok(doneLines.some(l => l.type === 'result'));

  // 9. Resuming a CONNECTOR_REQUIRED thread with connectorDecisions attaches x-connector-decision header and preserves rootRunId
  const notionSaved = await workflows.save(notionFlow, creatorAddress);
  await workflows.publish(
    notionFlow.id,
    creatorAddress,
    { creatorFee: 0, tasks: ['Productivity'], description: 'Published Notion workflow' },
    notionSaved.modified,
  );
  const notionThreadId = `wf-${notionFlow.id}-conn-thread-1`;
  const pauseNotionRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${notionFlow.id}/run`,
    headers: spendingRunHeaders,
    payload: {
      input: 'Publish sprint recap to Notion',
      threadId: notionThreadId,
      dry: true,
    },
  });
  assert.equal(pauseNotionRes.statusCode, 428, pauseNotionRes.body);
  const pauseNotionJson = pauseNotionRes.json();
  assert.equal(pauseNotionJson.code, 'CONNECTOR_REQUIRED');
  const pausedRootRunId = String(pauseNotionJson.missing[0].runId);
  assert.ok(pausedRootRunId.length > 0);
  assert.equal(pauseNotionJson.missing[0].requestId, 'req-notion-1');

  const resumeConnIdx = agentStreams.length;
  const resumeNotionRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${notionFlow.id}/run`,
    headers: spendingRunHeaders,
    payload: {
      input: 'Publish sprint recap to Notion',
      threadId: notionThreadId,
      dry: true,
      connectorDecisions: [
        {
          runId: pausedRootRunId,
          requestId: 'req-notion-1',
          decision: 'connected',
        },
      ],
    },
  });
  assert.equal(resumeNotionRes.statusCode, 200, resumeNotionRes.body);
  assert.equal(
    agentStreams[resumeConnIdx]!.headers['x-connector-decision'],
    `${pausedRootRunId}:req-notion-1:connected`,
  );
  assert.equal('runId' in agentStreams[resumeConnIdx]!.body, false);
  assert.ok(Array.isArray(resumeNotionRes.json().bills));

  const settledNotionThread = await app.inject({
    method: 'GET',
    url: `/api/workflows/${notionFlow.id}/threads/${encodeURIComponent(notionThreadId)}`,
    headers: { authorization: `Bearer ${creatorJwt}` },
  });
  assert.equal(settledNotionThread.statusCode, 200);
  assert.equal(settledNotionThread.json().runId, pausedRootRunId);
  assert.equal(settledNotionThread.json().status, 'succeeded');
});
