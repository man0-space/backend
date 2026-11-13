import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ComposeSDK, createMemoryStorage } from '@compose-market/sdk';
import { runWorkflow } from '../agents/coordinator.js';
import type { Coordinator, Listing } from '../schema.js';

const testCoord: Coordinator = {
  id: 'coord-fast',
  userAddress: 'alice.testnet',
  agentId: 1,
  walletAddress: '0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g',
  name: 'Fast executor',
  image: '',
  personality: 'Execute steps concisely.',
  model: 'gemini-3.8-flash',
  cid: '',
  txHash: '',
  contractId: '',
  network: 'near:testnet',
};

test('runWorkflow streams multi-step DAG via runSdk.agent.stream, preserves media assets, and tracks bill + provider', async () => {
  const stepSearchId = randomUUID();
  const stepImageId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Search & Illustrate',
    brief: 'Search news and generate cover image',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepSearchId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Search News',
          kind: 'connector',
          note: 'Find top NEAR ecosystem news',
          entry: {
            id: 'mcp:exa',
            kind: 'connector',
            name: 'Exa Search',
            description: 'Web search MCP',
          },
        },
      },
      {
        id: stepImageId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Generate Cover',
          kind: 'model',
          note: 'Generate cover illustration',
          entry: {
            id: 'fal:flux-schnell',
            kind: 'model',
            name: 'FLUX Schnell',
            description: 'Fast image generation',
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: stepSearchId, target: stepImageId }],
  };

  let capturedStreamBody: Record<string, unknown> | null = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.ok(url.endsWith(`/agent/${testCoord.walletAddress}/stream`));
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    capturedStreamBody = JSON.parse(raw) as Record<string, unknown>;

    const receipt = {
      finalAmountWei: '18500',
      network: 'near:testnet',
      subject: `agent:${testCoord.walletAddress}`,
      executionRunId: 'exec-run-42',
      bills: [
        {
          kind: 'model',
          source: 'fireworks',
          amountWei: '12000',
          lineItems: [],
        },
      ],
    };

    const sse = [
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 't1:start',
        kind: 'tool',
        status: 'running',
        spanId: 'span-exa',
        name: 'connectors_call',
        ts: Date.now(),
        payload: { input: { connectorRef: 'connector:mcp:exa', action: 'search' } },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 't1:end',
        kind: 'tool',
        status: 'completed',
        spanId: 'span-exa',
        name: 'connectors_call',
        ts: Date.now(),
        payload: { output: 'NEAR Intents volume hit a new weekly record.' },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 't2:start',
        kind: 'tool',
        status: 'running',
        spanId: 'span-flux',
        name: 'models_call',
        ts: Date.now(),
        payload: { input: { modelRef: 'model:fal:flux-schnell' } },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'model',
        type: 'model.asset',
        id: 'asset-1',
        ts: Date.now(),
        asset: {
          kind: 'image',
          url: 'https://cdn.compose.market/generated/cover.png',
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'model',
        type: 'model.text.delta',
        id: 'nested-tool-delta',
        ts: Date.now(),
        delta: 'Nested model stream that should not duplicate final output.',
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'activity',
        type: 'activity.tool',
        id: 't2:end',
        kind: 'tool',
        status: 'completed',
        spanId: 'span-flux',
        name: 'models_call',
        ts: Date.now(),
        payload: {
          output: {
            lc: 1,
            type: 'constructor',
            kwargs: {
              content: JSON.stringify({
                success: true,
                model: { id: 'fal:flux-schnell', name: 'FLUX Schnell' },
                output: 'Generated cover artwork.',
              }),
            },
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        domain: 'model',
        type: 'model.text.delta',
        id: 'delta-1',
        ts: Date.now(),
        delta: 'Here is the NEAR ecosystem brief and cover.',
      })}\n\n`,
      `event: receipt\ndata: ${JSON.stringify(receipt)}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  const events: Array<Record<string, unknown>> = [];
  let billTotal = 0n;

  const result = await runWorkflow({
    flow,
    coordinator: testCoord,
    runSdk,
    runId: 'wf-run-1',
    threadId: 'wf-thread-1',
    subject: 'alice.testnet',
    userInput: 'Create weekly NEAR digest',
    emitEvent: evt => events.push(evt),
    onBillDelta: delta => {
      billTotal += delta;
    },
  });

  assert.ok(capturedStreamBody);
  assert.equal('approvedPlan' in capturedStreamBody, false);
  assert.equal(billTotal, 18500n);
  assert.equal(result.totalComposeBillWei, 18500n);
  assert.deepEqual(result.coordinatorProviders, ['fireworks']);
  assert.match(result.output, /Here is the NEAR ecosystem brief/);
  assert.doesNotMatch(result.output, /Nested model stream that should not duplicate/);
  assert.match(result.output, /https:\/\/cdn\.compose\.market\/generated\/cover\.png/);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0]!.id, stepSearchId);
  assert.match(result.steps[0]!.output, /NEAR Intents volume/);
  assert.equal(result.steps[1]!.id, stepImageId);
  assert.match(result.steps[1]!.output, /^Generated cover artwork\./);
  assert.match(result.steps[1]!.output, /https:\/\/cdn\.compose\.market\/generated\/cover\.png/);
  assert.ok(events.some(e => e.type === 'step:start' && e.stepId === stepSearchId));
  assert.ok(events.some(e => e.type === 'step:done' && e.stepId === stepSearchId));
  assert.ok(events.some(e => e.type === 'step:start' && e.stepId === stepImageId));
  assert.ok(events.some(e => e.type === 'step:done' && e.stepId === stepImageId));
});

test('runWorkflow auto-approves specialist agent proposal via decide + watch and hydrates priorStepOutputs', async () => {
  const stepDoneId = randomUUID();
  const stepAgentId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Specialist Delegation',
    brief: 'Resume after step 1 and delegate step 2',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepDoneId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Ingest',
          kind: 'model',
          note: 'Extract metrics',
          entry: {
            id: 'gemini-3.8-flash',
            kind: 'model',
            name: 'Gemini Flash',
            description: 'Fast model',
          },
        },
      },
      {
        id: stepAgentId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Audit Specialist',
          kind: 'agent',
          note: 'Audit extracted metrics',
          entry: {
            id: '0x1111111111111111111111111111111111111111',
            kind: 'agent',
            name: 'Quant Specialist',
            description: 'Specialist agent',
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: stepDoneId, target: stepAgentId }],
  };

  let decideBody: Record<string, unknown> | null = null;
  let streamBody: Record<string, unknown> | null = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/stream')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      streamBody = JSON.parse(raw) as Record<string, unknown>;
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.plan',
          id: 'plan:1',
          kind: 'plan',
          status: 'pending',
          spanId: 'plan:1',
          ts: Date.now(),
          payload: {
            runId: 'child-plan-run-1',
            proposalId: 'prop-specialist-1',
            version: 1,
            state: 'awaiting_approval',
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/approval')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      decideBody = JSON.parse(raw) as Record<string, unknown>;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/events')) {
      const sse = [
        `data: ${JSON.stringify({
          domain: 'model',
          type: 'model.text.delta',
          id: 'watch-delta-1',
          ts: Date.now(),
          delta: 'Specialist audit completed cleanly.',
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  const events: Array<Record<string, unknown>> = [];
  const res = await runWorkflow({
    flow,
    coordinator: testCoord,
    runSdk,
    runId: 'wf-run-resume',
    threadId: 'wf-thread-resume',
    subject: 'alice.testnet',
    priorStepOutputs: { [stepDoneId]: 'Cached metrics v1' },
    isResumingThread: true,
    emitEvent: evt => events.push(evt),
    onBillDelta: () => undefined,
  });

  assert.ok(streamBody);
  assert.equal('runId' in streamBody, false);
  assert.match(String(streamBody['message']), /ALREADY COMPLETED/);
  assert.ok(decideBody);
  assert.equal(decideBody['proposalId'], 'prop-specialist-1');
  assert.equal(decideBody['decision'], 'approved');
  assert.equal(res.output, 'Specialist audit completed cleanly.');
  assert.equal(res.stepOutputs[stepDoneId], 'Cached metrics v1');
  assert.equal(res.stepOutputs[stepAgentId], 'Specialist audit completed cleanly.');
});

test('runWorkflow recovers full >8000-char streamed model output over [truncated ...] tool payload, preserves sink connector delivery, and emits SSE + itemized bills', async () => {
  const stepStoryId = randomUUID();
  const stepPublishId = randomUUID();
  const fullStory = [
    '**THE LLAMA THAT ROLLED DOWN**',
    '',
    '*by a narrator who keeps forgetting its own name*',
    '',
    '---',
    '',
    '### 0. Preamble (or, Why This Story Exists)',
    '',
    '> **NOTE TO THE READER:**',
    '> The following text was generated from a single voice-note.',
    '',
    Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: The llama rolled past milestone ${i + 1} across the high Andean ridge without losing momentum.`).join('\n\n'),
    '',
    '### Epilogue: Touchdown in Cusco',
    'At last, the llama stood upright in the plaza, completely untruncated.',
  ].join('\n');
  assert.ok(fullStory.length > 8500);

  const flow: Listing = {
    id: randomUUID(),
    name: 'Write & Publish Story',
    brief: 'Write long story and publish externally',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepStoryId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Write Story',
          kind: 'model',
          note: 'Generate full markdown story',
          entry: {
            id: 'NVIDIA-Nemotron-3-Ultra-550B-A55B',
            kind: 'model',
            name: 'NVIDIA Nemotron 3 Ultra 550B A55B',
            description: 'Large language model',
          },
        },
      },
      {
        id: stepPublishId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Publish to Notion',
          kind: 'connector',
          note: 'Publish story to Notion page',
          entry: {
            id: 'account:notion',
            kind: 'connector',
            name: 'Notion',
            description: 'Notion workspace',
          },
        },
      },
    ],
    edges: [{ id: 'e-story-pub', source: stepStoryId, target: stepPublishId }],
  };

  const truncatedPayload = {
    role: 'tool',
    tool_call_id: 'chatcmpl-tool-a4cb253b0faa1ba1',
    name: 'models_call',
    status: 'success',
    content: {
      success: true,
      model: {
        id: 'NVIDIA-Nemotron-3-Ultra-550B-A55B',
        name: 'NVIDIA Nemotron 3 Ultra 550B A55B',
        score: null,
      },
      output: `${fullStory.slice(0, 320)}... [truncated ${fullStory.length - 320} chars]`,
      usage: { inputTokens: 105, outputTokens: 1989, totalTokens: 2094 },
    },
  };

  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          accounts: [{ slug: 'notion', name: 'Notion', connected: true, granted: true }],
          connectors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/stream')) {
      const chunkMid = Math.floor(fullStory.length / 2);
      const receipt = {
        service: 'runtime',
        finalAmountWei: '15000',
        network: 'near:testnet',
        subject: `agent:${testCoord.walletAddress}`,
        executionRunId: 'exec-story-1',
        cumulative: {
          totalAmountWei: '57000',
          receiptCount: 3,
        },
        bills: [
          {
            kind: 'agent',
            source: 'runtime',
            agentWallet: testCoord.walletAddress,
            amountWei: '15000',
            total: '57000',
            lineItems: [],
            children: [
              {
                kind: 'model',
                source: 'NVIDIA-Nemotron-3-Ultra-550B-A55B',
                subject: 'model:NVIDIA-Nemotron-3-Ultra-550B-A55B',
                amountWei: '35000',
                lineItems: [],
              },
              {
                kind: 'connector',
                source: 'account:notion',
                subject: 'connector:account:notion',
                amountWei: '7000',
                lineItems: [],
              },
            ],
          },
        ],
      };

      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'story:start',
          kind: 'tool',
          status: 'running',
          spanId: 'span-story',
          name: 'models_call',
          ts: Date.now(),
          payload: { input: { modelRef: 'model:NVIDIA-Nemotron-3-Ultra-550B-A55B' } },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'model',
          type: 'model.text.delta',
          id: 'story-d1',
          ts: Date.now(),
          delta: fullStory.slice(0, chunkMid),
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'model',
          type: 'model.text.delta',
          id: 'story-d2',
          ts: Date.now(),
          delta: fullStory.slice(chunkMid),
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'story:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-story',
          name: 'models_call',
          ts: Date.now(),
          payload: { output: truncatedPayload },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'sel:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-sel',
          name: 'connector_select',
          ts: Date.now(),
          payload: {
            output: {
              status: 'ready',
              bindingId: 'account:notion',
              exposedTools: ['NOTION_CREATE_NOTION_PAGE'],
            },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'pub:start',
          kind: 'tool',
          status: 'running',
          spanId: 'span-pub',
          name: 'NOTION_CREATE_NOTION_PAGE',
          ts: Date.now(),
          payload: { input: { title: 'The Llama That Rolled Down' } },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'pub:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-pub',
          name: 'NOTION_CREATE_NOTION_PAGE',
          ts: Date.now(),
          payload: {
            output: {
              successful: true,
              data: { url: 'https://www.notion.so/Llama-Story-12345' },
            },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'model',
          type: 'model.text.delta',
          id: 'coord-short-ack',
          ts: Date.now(),
          delta: 'Published story to Notion successfully.',
        })}\n\n`,
        `event: receipt\ndata: ${JSON.stringify(receipt)}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  const events: Array<Record<string, unknown>> = [];
  const res = await runWorkflow({
    flow,
    coordinator: testCoord,
    runSdk,
    runId: 'wf-story-run-1',
    threadId: 'wf-story-thread-1',
    subject: 'alice.testnet',
    userInput: 'Turn voice note into story and publish to Notion',
    emitEvent: evt => events.push(evt),
    onBillDelta: () => undefined,
  });

  // Step 1 output & final deliverable have zero truncation and zero raw tool JSON wrapper
  assert.equal(res.stepOutputs[stepStoryId]?.includes('[truncated '), false);
  assert.equal(res.stepOutputs[stepStoryId]?.includes('chatcmpl-tool-'), false);
  assert.match(res.stepOutputs[stepStoryId] ?? '', /Epilogue: Touchdown in Cusco/);
  assert.ok((res.stepOutputs[stepStoryId] ?? '').length >= fullStory.length);

  // Direct bound Composio action tool mapped to Step 2 and extracted clean Notion URL
  assert.match(res.stepOutputs[stepPublishId] ?? '', /https:\/\/www\.notion\.so\/Llama-Story-12345/);

  // Final deliverable preserves full >8500-char story AND sink connector publication confirmation
  assert.match(res.output, /THE LLAMA THAT ROLLED DOWN/);
  assert.match(res.output, /Epilogue: Touchdown in Cusco/);
  assert.match(res.output, /Publish to Notion/);
  assert.match(res.output, /https:\/\/www\.notion\.so\/Llama-Story-12345/);

  // Readable SSE events emitted for live UI
  assert.ok(events.some(e => e.type === 'sse:activity'));
  assert.ok(events.some(e => e.type === 'sse:delta' && e.stepId === stepStoryId));
  assert.ok(events.some(e => e.type === 'sse:bill'));

  // Itemized bills include Coordinator + Model + Connector totaling 57,000 wei (15,000 + 42,000)
  assert.equal(res.totalComposeBillWei, 57000n);
  assert.ok(res.bills.some(b => b.category === 'coordinator' && b.amountWei === '15000'));
  assert.ok(res.bills.some(b => b.category === 'model' && b.amountWei === '35000'));
  assert.ok(res.bills.some(b => b.category === 'connector' && b.amountWei === '7000'));
});

test('runWorkflow auto-grants ungranted connected accounts and extracts exact requestId + slug on CONNECTOR_REQUIRED', async () => {
  const stepGithubId = randomUUID();
  const stepTweetId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Release & Post Update',
    brief: 'Read GitHub release and post update to X/Twitter',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepGithubId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Read GitHub Release',
          kind: 'connector',
          note: 'Fetch latest GitHub release notes',
          entry: {
            id: 'account:github',
            kind: 'connector',
            name: 'GitHub',
            description: 'GitHub account',
          },
        },
      },
      {
        id: stepTweetId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Post to X',
          kind: 'connector',
          note: 'Post announcement',
          entry: {
            id: 'account:twitter',
            kind: 'connector',
            name: 'Twitter / X',
            description: 'Social account',
          },
        },
      },
    ],
    edges: [{ id: 'e-gh-tw', source: stepGithubId, target: stepTweetId }],
  };

  const grantedCalls: Array<Record<string, unknown>> = [];
  let capturedBody: Record<string, unknown> | null = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          accounts: [{ slug: 'github', name: 'GitHub', connected: true, granted: false }],
          connectors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/connectors/accounts/grant')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      grantedCalls.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/stream')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      capturedBody = JSON.parse(raw) as Record<string, unknown>;
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'cs:1',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-cs-1',
          name: 'connector_select',
          ts: Date.now(),
          payload: {
            output: {
              state: 'credential_gated',
              bindingId: 'account:twitter',
              slug: 'twitter',
              name: 'Twitter / X',
              reason: 'Connect Twitter / X account to post.',
            },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.connector',
          id: 'conn:req-tw-99',
          kind: 'connector',
          status: 'pending',
          spanId: 'conn:req-tw-99',
          ts: Date.now(),
          target: {
            kind: 'connector',
            id: 'req-tw-99',
            name: 'twitter',
            target: 'account:twitter',
          },
          payload: {
            runId: 'wf-tw-root-1',
            requestId: 'req-tw-99',
            kind: 'account',
            bindingId: 'account:twitter',
            state: 'requested',
            reason: 'Connect Twitter / X account to post.',
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  await assert.rejects(
    () =>
      runWorkflow({
        flow,
        coordinator: testCoord,
        runSdk,
        runId: 'wf-tw-root-1',
        threadId: 'wf-tw-thread-1',
        subject: 'alice.testnet',
        userInput: 'Ship announcement',
        emitEvent: () => undefined,
        onBillDelta: () => undefined,
      }),
    (err: Error & { code?: string; missing?: Array<Record<string, unknown>> }) => {
      assert.equal(err.code, 'CONNECTOR_REQUIRED');
      assert.equal(err.missing?.length, 1);
      assert.equal(err.missing?.[0]?.['entryId'], 'account:twitter');
      assert.equal(err.missing?.[0]?.['slug'], 'twitter');
      assert.equal(err.missing?.[0]?.['type'], 'account');
      assert.equal(err.missing?.[0]?.['requestId'], 'req-tw-99');
      assert.equal(err.missing?.[0]?.['runId'], 'wf-tw-root-1');
      return true;
    },
  );

  // Pre-flight status auto-granted github and passed backpackAccounts
  assert.equal(grantedCalls.length, 1);
  assert.equal(grantedCalls[0]?.['toolkit'], 'github');
  assert.ok(capturedBody);
  assert.deepEqual(capturedBody['backpackAccounts'], [{ slug: 'github', name: 'github', connected: true }]);
});

test('runWorkflow pre-flight pauses with 428 CONNECTOR_REQUIRED before spending upstream model credits when connector is unconnected', async () => {
  const stepModelId = randomUUID();
  const stepConnectorId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Summarize & Deliver',
    brief: 'Generate summary and deliver via external account',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepModelId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Generate Summary',
          kind: 'model',
          entry: { id: 'NVIDIA-Nemotron-3-Ultra-550B-A55B', kind: 'model', name: 'Nemotron' },
        },
      },
      {
        id: stepConnectorId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Deliver to Slack',
          kind: 'connector',
          entry: { id: 'account:slack', kind: 'connector', name: 'Slack' },
        },
      },
    ],
    edges: [{ id: 'e-1', source: stepModelId, target: stepConnectorId }],
  };

  let streamCalled = false;
  const mockFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({ userAddress: 'alice.testnet', accounts: [], connectors: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/stream')) {
      streamCalled = true;
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  await assert.rejects(
    () =>
      runWorkflow({
        flow,
        coordinator: testCoord,
        runSdk,
        runId: 'wf-pre-1',
        threadId: 'wf-pre-thread-1',
        subject: 'alice.testnet',
        userInput: 'Send weekly summary',
        dry: false,
        emitEvent: () => undefined,
        onBillDelta: () => undefined,
      }),
    (err: Error & { statusCode?: number; code?: string }) => {
      assert.equal(err.statusCode, 428);
      assert.equal(err.code, 'CONNECTOR_REQUIRED');
      return true;
    },
  );
  assert.equal(streamCalled, false);
});

test('runWorkflow deduplicates EXPIRED+ACTIVE accounts, passes selectedResources, attaches artifact URLs without hijacking connector step, and settles in-flight connector request via decideConnector + watch', async () => {
  const stepImgId = randomUUID();
  const stepDeliverId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Illustrate & Publish',
    brief: 'Generate cover and publish externally',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepImgId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Generate Cover',
          kind: 'model',
          entry: { id: 'gemini-nano-banana-2.1', kind: 'model', name: 'Nano Banana' },
        },
      },
      {
        id: stepDeliverId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Publish Deliverable',
          kind: 'connector',
          entry: { id: 'account:linear', kind: 'connector', name: 'Linear' },
        },
      },
    ],
    edges: [{ id: 'e-img-del', source: stepImgId, target: stepDeliverId }],
  };

  let capturedStreamBody: Record<string, unknown> | null = null;
  const decidedCalls: Array<Record<string, unknown>> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          accounts: [
            { slug: 'linear', connected: false, granted: false, connectedAccountId: 'ca_old', status: 'EXPIRED' },
            { slug: 'linear', connected: true, granted: true, connectedAccountId: 'ca_active', status: 'ACTIVE' },
          ],
          connectors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/accounts/toolkits/linear/actions')) {
      return new Response(
        JSON.stringify({
          toolkit: 'linear',
          actions: [
            {
              slug: 'LINEAR_CREATE_ISSUE',
              name: 'Create Linear Issue',
              description: 'Create an issue in Linear',
              toolkitSlug: 'linear',
              inputParameters: {
                type: 'object',
                required: ['title', 'team_id'],
                properties: {
                  title: { type: 'string' },
                  team_id: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/stream')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      capturedStreamBody = JSON.parse(raw) as Record<string, unknown>;
      const fakeB64 = 'A'.repeat(256);
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:img:start',
          kind: 'tool',
          status: 'running',
          spanId: 'span-img-1',
          name: 'models_call',
          ts: Date.now(),
          payload: { input: { modelRef: 'model:gemini-nano-banana-2.1' } },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:img:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-img-1',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            output: {
              success: true,
              output: `![Cover](data:image/png;base64,${fakeB64})`,
            },
          },
        })}\n\n`,
        // Nameless artifact event from runtime MUST attach URL to stepImgId and NEVER complete stepDeliverId
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'artifact:uuid-cover-1',
          kind: 'tool',
          status: 'completed',
          spanId: 'artifact:uuid-cover-1',
          ts: Date.now(),
          payload: {
            message: 'Artifact created',
            artifact: {
              type: 'image',
              url: 'https://cdn.compose.market/artifacts/cover-hosted.png',
            },
          },
        })}\n\n`,
        // In-flight connector request for an already-connected account -> auto-settled via decideConnector + watch
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.connector',
          id: 'conn:req-lin-1',
          kind: 'connector',
          status: 'pending',
          spanId: 'conn:req-lin-1',
          ts: Date.now(),
          payload: {
            runId: 'wf-lin-run-1',
            requestId: 'req-lin-1',
            kind: 'account',
            bindingId: 'account:linear',
            slug: 'linear',
            state: 'requested',
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/runs/wf-lin-run-1/connector')) {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      decidedCalls.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ success: true, requestId: 'req-lin-1', state: 'connected' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/runs/wf-lin-run-1/events')) {
      const watchSse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:lin:start',
          kind: 'tool',
          status: 'running',
          spanId: 'span-lin-1',
          name: 'connectors_call',
          ts: Date.now(),
          payload: {
            input: {
              connectorRef: 'connector:account:linear',
              action: 'LINEAR_CREATE_ISSUE',
              args: { title: 'Cover Issue', team_id: 'team-1' },
            },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:lin:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-lin-1',
          name: 'connectors_call',
          ts: Date.now(),
          payload: {
            input: {
              connectorRef: 'connector:account:linear',
              action: 'LINEAR_CREATE_ISSUE',
            },
            output: {
              success: true,
              url: 'https://linear.app/team/issue/TEAM-42',
            },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(watchSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  const res = await runWorkflow({
    flow,
    coordinator: testCoord,
    runSdk,
    runId: 'wf-lin-run-1',
    threadId: 'wf-lin-thread-1',
    subject: 'alice.testnet',
    userInput: 'Create cover and file issue',
    emitEvent: () => undefined,
    onBillDelta: () => undefined,
  });

  assert.ok(capturedStreamBody);
  assert.equal(capturedStreamBody['mode'], 'solo');
  assert.deepEqual(capturedStreamBody['backpackAccounts'], [
    { slug: 'linear', name: 'linear', connected: true, accountId: 'ca_active', status: 'ACTIVE' },
  ]);
  const selRes = capturedStreamBody['selectedResources'] as {
    models?: Record<string, unknown>;
    connectors?: Record<string, unknown>;
  };
  assert.ok(selRes?.models?.['model:gemini-nano-banana-2.1']);
  assert.ok(selRes?.connectors?.['connector:account:linear']);
  assert.match(String(capturedStreamBody['message']), /LINEAR_CREATE_ISSUE\(title\*:string, team_id\*:string/);

  // Image step replaced inline base64 with hosted artifact URL
  assert.equal(res.stepOutputs[stepImgId]?.includes('data:image/png;base64,'), false);
  assert.match(res.stepOutputs[stepImgId] ?? '', /https:\/\/cdn\.compose\.market\/artifacts\/cover-hosted\.png/);

  // Connector step ran via decideConnector + watch and recorded real URL (never "Artifact created")
  assert.equal(decidedCalls.length, 1);
  assert.equal(decidedCalls[0]?.['requestId'], 'req-lin-1');
  assert.equal(decidedCalls[0]?.['decision'], 'connected');
  assert.match(res.stepOutputs[stepDeliverId] ?? '', /https:\/\/linear\.app\/team\/issue\/TEAM-42/);
});

test('runWorkflow rejects with 502 in live mode when a pending connector step fails or is skipped', async () => {
  const stepConnId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Deliver Only',
    brief: 'Publish update',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepConnId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Publish Update',
          kind: 'connector',
          entry: { id: 'account:linear', kind: 'connector', name: 'Linear' },
        },
      },
    ],
    edges: [],
  };

  const mockFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          accounts: [{ slug: 'linear', connected: true, granted: true, connectedAccountId: 'ca_1' }],
          connectors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/stream')) {
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 'tool:fail:end',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-fail-1',
          name: 'connectors_call',
          ts: Date.now(),
          payload: {
            input: { connectorRef: 'connector:account:linear', action: 'LINEAR_CREATE_ISSUE' },
            output: { success: false, error: 'Missing required parameter team_id' },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  await assert.rejects(
    () =>
      runWorkflow({
        flow,
        coordinator: testCoord,
        runSdk,
        runId: 'wf-fail-1',
        threadId: 'wf-fail-thread-1',
        subject: 'alice.testnet',
        userInput: 'Ship update',
        dry: false,
        emitEvent: () => undefined,
        onBillDelta: () => undefined,
      }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /Missing required parameter team_id/);
      return true;
    },
  );
});

test('runWorkflow reconciles real /api/receipts per-step billing via models_call:<toolCallId> without equal-splitting onto free connectors', async () => {
  const stepTranscribeId = randomUUID();
  const stepStoryId = randomUUID();
  const stepImageId = randomUUID();
  const stepNotionId = randomUUID();
  const flow: Listing = {
    id: randomUUID(),
    name: 'Voice Notes to Fiction Stories',
    brief: 'Transcribe audio, write fiction story, generate cover image, publish to Notion',
    userAddress: 'alice.testnet',
    terms: null,
    published: null,
    modified: new Date().toISOString(),
    nodes: [
      {
        id: stepTranscribeId,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          label: 'Transcribe',
          kind: 'model',
          note: 'Transcribe audio',
          entry: { id: 'scribe_v2', kind: 'model', name: 'Scribe V2', description: 'ASR' },
        },
      },
      {
        id: stepStoryId,
        type: 'step',
        position: { x: 240, y: 0 },
        data: {
          label: 'Write Story',
          kind: 'model',
          note: 'Write fiction story',
          entry: {
            id: 'NVIDIA-Nemotron-3-Ultra-550B-A55B',
            kind: 'model',
            name: 'NVIDIA Nemotron 3 Ultra 550B A55B',
            description: 'LLM',
          },
        },
      },
      {
        id: stepImageId,
        type: 'step',
        position: { x: 480, y: 0 },
        data: {
          label: 'Cover Art',
          kind: 'model',
          note: 'Generate cover image',
          entry: {
            id: 'gemini-nano-banana-2.1',
            kind: 'model',
            name: 'Nano Banana 2.1',
            description: 'Image generation',
          },
        },
      },
      {
        id: stepNotionId,
        type: 'step',
        position: { x: 720, y: 0 },
        data: {
          label: 'Save to Notion',
          kind: 'connector',
          note: 'Save story and cover image to Notion',
          entry: { id: 'account:notion', kind: 'connector', name: 'Notion', description: 'Notion' },
        },
      },
    ],
    edges: [
      { id: 'e1', source: stepTranscribeId, target: stepStoryId },
      { id: 'e2', source: stepStoryId, target: stepImageId },
      { id: 'e3', source: stepImageId, target: stepNotionId },
    ],
  };

  const mockFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/connectors/status')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          accounts: [{ slug: 'notion', name: 'Notion', connected: true, granted: true }],
          connectors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/connectors/notion/actions')) {
      return new Response(
        JSON.stringify({
          actions: [{ name: 'NOTION_CREATE_NOTION_PAGE', description: 'Create page', inputSchema: {} }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/receipts')) {
      return new Response(
        JSON.stringify({
          userAddress: 'alice.testnet',
          network: 'near:testnet',
          cumulative: {
            totalAmountWei: '46268',
            providerAmountWei: '45800',
            platformFeeWei: '468',
            receiptCount: 5,
          },
          receipts: [
            {
              id: 'rct_scribe',
              txHash: 'tx_1',
              service: 'inference',
              action: 'models_call:call-scribe-1',
              subject: 'elevenlabs:scribe_v2',
              rootRunId: 'wf-receipts-root-1',
              executionRunId: 'exec-receipts-1',
              providerAmountWei: '1034',
              platformFeeWei: '11',
              finalAmountWei: '1045',
              settledAt: Date.now() - 4000,
              bills: [{ kind: 'agent', source: 'inference', amountWei: '1034', lineItems: [] }],
            },
            {
              id: 'rct_coord_turn_1',
              txHash: 'tx_2',
              service: 'inference',
              action: 'POST /v1/responses',
              subject: 'deepinfra:NVIDIA-Nemotron-3-Ultra-550B-A55B',
              rootRunId: 'wf-receipts-root-1',
              executionRunId: 'exec-receipts-1',
              providerAmountWei: '4450',
              platformFeeWei: '48',
              finalAmountWei: '4498',
              settledAt: Date.now() - 3500,
              bills: [{ kind: 'agent', source: 'inference', amountWei: '4450', lineItems: [] }],
            },
            {
              id: 'rct_story_step',
              txHash: 'tx_3',
              service: 'inference',
              action: 'models_call:call-story-2',
              subject: 'deepinfra:NVIDIA-Nemotron-3-Ultra-550B-A55B',
              rootRunId: 'wf-receipts-root-1',
              executionRunId: 'exec-receipts-1',
              providerAmountWei: '6200',
              platformFeeWei: '65',
              finalAmountWei: '6265',
              settledAt: Date.now() - 3000,
              bills: [{ kind: 'agent', source: 'inference', amountWei: '6200', lineItems: [] }],
            },
            {
              id: 'rct_banana_step',
              txHash: 'tx_4',
              service: 'inference',
              action: 'models_call:call-banana-3',
              subject: 'gemini:gemini-nano-banana-2.1',
              rootRunId: 'wf-receipts-root-1',
              executionRunId: 'exec-receipts-1',
              providerAmountWei: '33800',
              platformFeeWei: '338',
              finalAmountWei: '34138',
              settledAt: Date.now() - 2000,
              bills: [{ kind: 'agent', source: 'inference', amountWei: '33800', lineItems: [] }],
            },
            {
              id: 'rct_mem',
              txHash: 'tx_5',
              service: 'memory',
              action: 'fact-extraction',
              subject: 'gemini:gemini-3.1-flash-lite',
              rootRunId: 'wf-receipts-root-1',
              executionRunId: 'exec-receipts-1:mem-1',
              providerAmountWei: '316',
              platformFeeWei: '4',
              finalAmountWei: '322',
              settledAt: Date.now() - 1000,
              bills: [{ kind: 'agent', source: 'memory', amountWei: '316', lineItems: [] }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/stream')) {
      const runtimeReceipt = {
        service: 'runtime',
        finalAmountWei: '629',
        network: 'near:testnet',
        subject: `agent:${testCoord.walletAddress}`,
        executionRunId: 'exec-receipts-1',
        cumulative: { totalAmountWei: '46897', receiptCount: 6 },
        bills: [
          {
            kind: 'agent',
            source: 'runtime',
            agentWallet: testCoord.walletAddress,
            amountWei: '629',
            total: '46897',
            lineItems: [],
            children: [],
          },
        ],
      };
      const sse = [
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't1:start',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'running',
          spanId: 'span-1',
          name: 'models_call',
          ts: Date.now(),
          payload: { input: { modelRef: 'model:scribe_v2', prompt: 'Transcribe' } },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't1:end',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-1',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            output: { role: 'tool', tool_call_id: 'call-scribe-1', content: { output: 'Voice transcript' } },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't2:start',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'running',
          spanId: 'span-2',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            input: { modelRef: 'model:NVIDIA-Nemotron-3-Ultra-550B-A55B', prompt: 'Write story' },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't2:end',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-2',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            output: { role: 'tool', tool_call_id: 'call-story-2', content: { output: 'Full story body' } },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't3:start',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'running',
          spanId: 'span-3',
          name: 'models_call',
          ts: Date.now(),
          payload: { input: { modelRef: 'model:gemini-nano-banana-2.1', prompt: 'Cover art' } },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't3:end',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-3',
          name: 'models_call',
          ts: Date.now(),
          payload: {
            output: {
              role: 'tool',
              tool_call_id: 'call-banana-3',
              content: { output: 'https://jabyl.mypinata.cloud/ipfs/QmCover/cover.png' },
            },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't4:start',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'running',
          spanId: 'span-4',
          name: 'connectors_call',
          ts: Date.now(),
          payload: {
            input: { connectorRef: 'connector:account:notion', action: 'NOTION_CREATE_NOTION_PAGE' },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          domain: 'activity',
          type: 'activity.tool',
          id: 't4:end',
          runId: 'exec-receipts-1',
          kind: 'tool',
          status: 'completed',
          spanId: 'span-4',
          name: 'connectors_call',
          ts: Date.now(),
          payload: {
            output: {
              success: true,
              data: { url: 'https://app.notion.com/p/Story-Page-999' },
            },
          },
        })}\n\n`,
        `event: receipt\ndata: ${JSON.stringify(runtimeReceipt)}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const runSdk = new ComposeSDK({
    fetch: mockFetch,
    storage: createMemoryStorage(),
    userAddress: 'alice.testnet',
    network: 'near:testnet',
    key: 'compose-test-token',
  });

  let billDeltaTotal = 0n;
  const res = await runWorkflow({
    flow,
    coordinator: testCoord,
    runSdk,
    runId: 'wf-receipts-root-1',
    threadId: 'wf-receipts-thread-1',
    subject: 'alice.testnet',
    userInput: 'Convert voice note to story',
    emitEvent: () => undefined,
    onBillDelta: d => {
      billDeltaTotal += d;
    },
  });

  const byStepId = new Map(res.steps.map(s => [s.id, s.billWei]));
  assert.equal(byStepId.get(stepTranscribeId), '1045');
  assert.equal(byStepId.get(stepStoryId), '6265');
  assert.equal(byStepId.get(stepImageId), '34138');
  assert.equal(byStepId.get(stepNotionId), '0');

  // 1045 + 4498 + 6265 + 34138 + 322 + 629 = 46897
  assert.equal(res.totalComposeBillWei, 46897n);
  assert.equal(billDeltaTotal, 46897n);
  assert.equal(res.bills.filter(b => b.category === 'coordinator').length, 3);
  assert.equal(res.bills.filter(b => b.category === 'model').length, 3);
  assert.equal(res.bills.filter(b => b.category === 'connector').length, 0);
});
