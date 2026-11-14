import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  COMPOSE_CONNECTORS_ORIGIN,
  COMPOSE_MODELS_ORIGIN,
  COMPOSE_ROUTES_QUERY_URL,
  NEBIUS_CHAT_URL,
  VIBE_MODEL,
  createVibeStream,
  type VibeStreamEvent,
} from '../agents/vibe.js';
import type { Flow } from '../schema.js';

function makeSseResponse(chunks: unknown[]): Response {
  const lines = chunks.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(lines, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('createVibeStream drives Nemotron-3-Ultra tool loop across guidance libraries, Overview setters, and directional DAG setters', async () => {
  assert.equal(VIBE_MODEL, 'nvidia/Nemotron-3-Ultra-550b-a55b');

  let round = 0;
  const nebiusBodies: Array<Record<string, unknown>> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith(`${COMPOSE_MODELS_ORIGIN}/search`)) {
      return new Response(
        JSON.stringify({
          data: [
            {
              modelId: 'deepseek-v3',
              name: 'DeepSeek V3',
              family: 'deepseek',
              type: ['text-generation'],
              isFrontier: true,
              isLatest: true,
              score: 0.96,
              description: 'Frontier text reasoning model',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.startsWith(`${COMPOSE_MODELS_ORIGIN}/models`)) {
      return new Response(
        JSON.stringify({
          data: [
            {
              modelId: 'deepseek-v3',
              name: 'DeepSeek V3',
              family: 'deepseek',
              type: ['text-generation'],
              isFrontier: true,
              isLatest: true,
              description: 'Frontier text reasoning model',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url === COMPOSE_ROUTES_QUERY_URL) {
      return new Response(
        JSON.stringify({
          matches: [
            {
              domain: 'models',
              ref: 'deepseek-v3',
              label: 'DeepSeek V3',
              score: 0.96,
              nextTool: 'models_call',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    assert.equal(url, NEBIUS_CHAT_URL);
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    nebiusBodies.push(parsed);
    assert.equal(parsed.model, VIBE_MODEL);
    assert.equal(parsed.stream, true);

    round += 1;
    if (round === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_cat',
                    function: { name: 'read_categories_library', arguments: '{}' },
                  },
                  {
                    index: 1,
                    id: 'tc_dag',
                    function: { name: 'read_dag_library', arguments: '{}' },
                  },
                  {
                    index: 2,
                    id: 'tc_query',
                    function: {
                      name: 'query_catalog',
                      arguments: JSON.stringify({ query: 'deepseek', kind: 'model' }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    if (round === 2) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_title',
                    function: {
                      name: 'set_title',
                      arguments: JSON.stringify({ title: 'NEAR Alpha Desk' }),
                    },
                  },
                  {
                    index: 1,
                    id: 'tc_desc',
                    function: {
                      name: 'set_description',
                      arguments: JSON.stringify({
                        description: 'Synthesizes market intelligence and prepares cross-chain execution.',
                      }),
                    },
                  },
                  {
                    index: 2,
                    id: 'tc_tags',
                    function: {
                      name: 'set_categories',
                      arguments: JSON.stringify({ categories: ['Research', 'DeFi Execution'] }),
                    },
                  },
                  {
                    index: 3,
                    id: 'tc_banner',
                    function: { name: 'generate_banner', arguments: '{}' },
                  },
                  {
                    index: 4,
                    id: 'tc_s1',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        label: 'Market Research',
                        kind: 'model',
                        entryId: 'deepseek-v3',
                        note: 'Summarize NEAR DeFi liquidity',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    const messages = parsed.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
    const step1Msg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'tc_s1');
    const step1Id = JSON.parse(String(step1Msg?.content)).stepId as string;

    if (round === 3) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_s2',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        label: 'Execute Swap',
                        kind: 'connector',
                        entryId: 'near-intents',
                        note: 'Swap 10 USDC to NEAR',
                        anchorId: step1Id,
                        direction: 'right',
                        connectFromAnchor: true,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    if (round === 4) {
      const msgs4 = parsed.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
      const step2Msg = msgs4.find(m => m.role === 'tool' && m.tool_call_id === 'tc_s2');
      const step2Id = JSON.parse(String(step2Msg?.content)).stepId as string;
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_cycle',
                    function: {
                      name: 'connect_steps',
                      arguments: JSON.stringify({
                        sourceId: step2Id,
                        targetId: step1Id,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    const msgs5 = parsed.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
    const cycleResult = JSON.parse(
      String(msgs5.find(m => m.role === 'tool' && m.tool_call_id === 'tc_cycle')?.content),
    );
    assert.match(String(cycleResult.error), /acyclic|cycle/i);

    return makeSseResponse([
      {
        choices: [
          {
            delta: {
              content: 'Built **NEAR Alpha Desk** with research and NEAR Intents swap.',
            },
          },
        ],
      },
    ]);
  };

  const initialFlow: Flow = {
    id: randomUUID(),
    name: 'Untitled workflow',
    brief: '',
    nodes: [],
    edges: [],
    modified: new Date().toISOString(),
  };

  const stream = createVibeStream(
    {
      prompt: 'Create a NEAR research + Intents swap workflow',
      flow: initialFlow,
      userAddress: 'alice.near',
    },
    {
      fetchImpl: mockFetch,
      catalogLoader: async role => {
        if (role === 'model') {
          return [
            {
              id: 'deepseek-v3',
              kind: 'model',
              name: 'DeepSeek V3',
              description: 'Frontier text reasoning model',
              groups: ['text'],
              isFrontier: true,
            },
          ];
        }
        if (role === 'connector') {
          return [
            {
              id: 'near-intents',
              kind: 'connector',
              name: 'NEAR Intents',
              description: '1Click cross-chain swap router',
              groups: ['onchain'],
            },
          ];
        }
        return [];
      },
      bannerGenerator: async () => ({
        imageUrl: 'https://jabyl.mypinata.cloud/ipfs/bafkreibannercidv1',
        cid: 'bafkreibannercidv1',
      }),
    },
  );

  let raw = '';
  for await (const chunk of stream) {
    raw += String(chunk);
  }

  const events = raw
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as VibeStreamEvent);

  const patchOps = events.filter(e => e.type === 'patch').map(e => e.patch.op);
  for (const expectedOp of ['set_title', 'set_description', 'set_categories', 'set_banner', 'add_step']) {
    assert.ok(patchOps.includes(expectedOp as never), `Expected patch op ${expectedOp}`);
  }
  assert.equal(patchOps.filter(op => op === 'add_step').length, 2);
  assert.equal(patchOps.filter(op => op === 'set_banner').length, 1);

  const done = events.find(e => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.flow.name, 'NEAR Alpha Desk');
  assert.deepEqual(done.flow.tasks, ['Research', 'DeFi Execution']);
  assert.equal(done.flow.banner, 'https://jabyl.mypinata.cloud/ipfs/bafkreibannercidv1');
  assert.equal(done.flow.nodes.length, 2);
  assert.equal(done.flow.edges.length, 1);
  assert.equal(done.flow.edges[0]?.sourceHandle, 'out');
  assert.equal(done.flow.edges[0]?.targetHandle, 'in');
  assert.ok(done.flow.nodes[1]!.position.x > done.flow.nodes[0]!.position.x);
});

test('createVibeStream prioritizes frontier worker models, chains multi-step symbolic stepIds in a single turn, emits workflow_ready immediately without blocking on background banner, and passes title + logos to bannerGenerator', async () => {
  let round = 0;
  const bannerCalls: Array<{
    title?: string;
    description?: string;
    logos?: Array<{ name: string; url?: string }>;
  }> = [];
  const workerUrlsHit: string[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith(`${COMPOSE_MODELS_ORIGIN}/search`)) {
      workerUrlsHit.push(url);
      const u = new URL(url);
      const q = u.searchParams.get('q') ?? '';
      if (q.includes('speech') || q.includes('transcribe')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                modelId: 'nova-3',
                name: 'Deepgram Nova 3',
                family: 'deepgram',
                provider: 'deepgram',
                type: ['speech'],
                isFrontier: false,
                isLatest: true,
                score: 0.93,
                description: 'Real-time high-accuracy speech-to-text transcription.',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (q.includes('cover') || q.includes('image')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                modelId: 'sd-1.5-anime-finetune',
                name: 'SD 1.5 Anime',
                family: 'stability',
                provider: 'replicate',
                type: ['image-generation'],
                isFrontier: false,
                isLatest: false,
                score: 0.55,
                description: 'Old non-frontier image model',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Creative fiction search returns an obscure finetune from raw lexical/vector match...
      return new Response(
        JSON.stringify({
          data: [
            {
              modelId: 'L3.1-70B-Euryale-v2.2',
              name: 'Euryale 70B',
              family: 'llama',
              provider: 'nebius',
              type: ['text-generation'],
              isFrontier: false,
              isLatest: false,
              score: 0.49,
              description: 'Roleplay finetune',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.startsWith(`${COMPOSE_MODELS_ORIGIN}/models`)) {
      workerUrlsHit.push(url);
      return new Response(
        JSON.stringify({
          data: [
            {
              modelId: 'claude-opus-5-5',
              name: 'Claude Opus 5.5',
              family: 'claude',
              provider: 'anthropic',
              type: ['text-generation'],
              isFrontier: true,
              isLatest: true,
              description: 'Flagship frontier reasoning and creative writing model.',
            },
            {
              modelId: 'FLUX-2-max',
              name: 'FLUX 2 Max',
              family: 'flux',
              provider: 'bfl',
              type: ['image-generation'],
              isFrontier: true,
              isLatest: true,
              description: 'Frontier image generation model.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.startsWith(COMPOSE_CONNECTORS_ORIGIN)) {
      workerUrlsHit.push(url);
      return new Response(
        JSON.stringify({
          accounts: {
            toolkits: [
              {
                slug: 'notion',
                name: 'Notion',
                description: 'Create and organize structured pages and databases in Notion.',
                logo: 'https://logos.composio.dev/api/notion',
              },
            ],
          },
          mcps: {
            servers: [
              {
                slug: 'easy-notion',
                name: 'Easy Notion MCP',
                description: 'Notion MCP integration',
                score: 0.78,
                status: 'live',
              },
            ],
          },
          onchain: { connectors: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    assert.equal(url, NEBIUS_CHAT_URL);
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    round += 1;

    if (round === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_asr',
                    function: {
                      name: 'models_find',
                      arguments: JSON.stringify({ query: 'speech to text transcribe', modality: 'speech' }),
                    },
                  },
                  {
                    index: 1,
                    id: 'tc_notion',
                    function: {
                      name: 'connectors_find',
                      arguments: JSON.stringify({ query: 'notion' }),
                    },
                  },
                  {
                    index: 2,
                    id: 'tc_story',
                    function: {
                      name: 'models_find',
                      arguments: JSON.stringify({
                        query: 'creative fiction story writing',
                        modality: 'text-generation',
                      }),
                    },
                  },
                  {
                    index: 3,
                    id: 'tc_cover',
                    function: {
                      name: 'models_find',
                      arguments: JSON.stringify({
                        query: 'book cover illustration',
                        modality: 'image-generation',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    if (round === 2) {
      const msgs = parsed.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
      const storyRes = JSON.parse(
        String(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'tc_story')?.content),
      ) as { models: Array<{ id: string; isFrontier: boolean; provider?: string }> };
      const coverRes = JSON.parse(
        String(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'tc_cover')?.content),
      ) as { models: Array<{ id: string; isFrontier: boolean; provider?: string }> };
      const notionRes = JSON.parse(
        String(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'tc_notion')?.content),
      ) as { connectors: Array<{ id: string }> };

      // Frontier models MUST rank #1 above non-frontier finetunes, with zero provider field exposed!
      assert.equal(storyRes.models[0]?.id, 'claude-opus-5-5');
      assert.equal(storyRes.models[0]?.isFrontier, true);
      assert.equal('provider' in (storyRes.models[0] ?? {}), false);

      assert.equal(coverRes.models[0]?.id, 'FLUX-2-max');
      assert.equal(coverRes.models[0]?.isFrontier, true);
      assert.equal(notionRes.connectors[0]?.id, 'account:notion');

      // Add set_description BEFORE set_title AND add ALL 4 steps in a SINGLE turn using symbolic stepId + anchorId!
      // Notice generate_banner is NOT called — set_description must automatically trigger banner generation!
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_desc',
                    function: {
                      name: 'set_description',
                      arguments: JSON.stringify({
                        description:
                          'Speak your ideas aloud, transcribe them automatically, save structured notes to Notion, and craft illustrated short fiction stories.',
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: 'tc_title',
                    function: {
                      name: 'set_title',
                      arguments: JSON.stringify({ title: 'Voice Notes to Fiction Stories' }),
                    },
                  },
                  {
                    index: 2,
                    id: 'tc_cats',
                    function: {
                      name: 'set_categories',
                      arguments: JSON.stringify({ categories: ['Content Creation', 'Productivity'] }),
                    },
                  },
                  {
                    index: 3,
                    id: 'tc_step1',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        stepId: 'step_1',
                        label: 'Transcribe Audio',
                        kind: 'model',
                        entryId: 'nova-3',
                        note: 'Transcribe spoken voice note audio cleanly.',
                      }),
                    },
                  },
                  {
                    index: 4,
                    id: 'tc_step2',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        stepId: 'step_2',
                        label: 'Save to Notion',
                        kind: 'connector',
                        entryId: 'notion',
                        note: 'Save structured story outline and notes to Notion.',
                        anchorId: 'step_1',
                        direction: 'right',
                      }),
                    },
                  },
                  {
                    index: 5,
                    id: 'tc_step3',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        stepId: 'step_3',
                        label: 'Write Fiction Story',
                        kind: 'model',
                        entryId: 'claude-opus-5-5',
                        note: 'Transform the structured notes into a polished fictional short story.',
                        anchorId: 'step_2',
                        direction: 'right',
                      }),
                    },
                  },
                  {
                    index: 6,
                    id: 'tc_step4',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        stepId: 'step_4',
                        label: 'Generate Story Cover',
                        kind: 'model',
                        entryId: 'FLUX-2-max',
                        note: 'Illustrate bespoke cover art matching the fictional story.',
                        anchorId: 'step_3',
                        direction: 'right',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    return makeSseResponse([
      {
        choices: [
          {
            delta: {
              content: 'Built the complete 4-step **Voice Notes to Fiction Stories** workflow with cover generation.',
            },
          },
        ],
      },
    ]);
  };

  const initialFlow: Flow = {
    id: randomUUID(),
    name: 'Unknown #1',
    brief: '',
    banner: null,
    nodes: [],
    edges: [],
    modified: new Date().toISOString(),
  };

  const stream = createVibeStream(
    {
      prompt:
        'Speak your ideas aloud, transcribe them automatically, save structured notes to Notion, then transform those notes into polished short fictional stories with a cool cover',
      flow: initialFlow,
      userAddress: 'creator.near',
    },
    {
      fetchImpl: mockFetch,
      catalogLoader: async () => [],
      bannerGenerator: async args => {
        bannerCalls.push(args);
        await new Promise(resolve => setTimeout(resolve, 35));
        return {
          imageUrl: 'https://jabyl.mypinata.cloud/ipfs/bafybeifrontierstorybanner',
          cid: 'bafybeifrontierstorybanner',
        };
      },
    },
  );

  let raw = '';
  for await (const chunk of stream) {
    raw += String(chunk);
  }

  const events = raw
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as VibeStreamEvent);

  const readyIdx = events.findIndex(e => e.type === 'workflow_ready');
  const setBannerIdx = events.findIndex(e => e.type === 'patch' && e.patch.op === 'set_banner');
  const doneIdx = events.findIndex(e => e.type === 'done');
  assert.ok(readyIdx >= 0, 'Expected workflow_ready event');
  assert.ok(setBannerIdx > readyIdx, 'Expected background banner patch to arrive AFTER workflow_ready without blocking it');
  assert.ok(doneIdx > setBannerIdx, 'Expected done event after background banner completes');

  const readyEvt = events[readyIdx];
  assert.ok(readyEvt && readyEvt.type === 'workflow_ready');
  assert.equal(readyEvt.flow.nodes.length, 4);
  assert.equal(readyEvt.flow.edges.length, 3);

  const done = events.find(e => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.flow.name, 'Voice Notes to Fiction Stories');
  assert.equal(done.flow.banner, 'https://jabyl.mypinata.cloud/ipfs/bafybeifrontierstorybanner');
  assert.equal(bannerCalls.length, 1);
  assert.equal(bannerCalls[0]?.title, 'Voice Notes to Fiction Stories');
  assert.match(String(bannerCalls[0]?.description), /transcribe them automatically/i);
  const logoNames = (bannerCalls[0]?.logos ?? []).map(l => l.name);
  assert.ok(logoNames.includes('Notion'), `Expected Notion in banner logos, got ${JSON.stringify(logoNames)}`);
  assert.ok(logoNames.includes('Claude'), `Expected Claude in banner logos, got ${JSON.stringify(logoNames)}`);
  assert.ok(logoNames.includes('FLUX'), `Expected FLUX in banner logos, got ${JSON.stringify(logoNames)}`);

  assert.equal(done.flow.nodes.length, 4);
  assert.deepEqual(
    done.flow.nodes.map(n => n.data.entry?.id),
    ['nova-3', 'account:notion', 'claude-opus-5-5', 'FLUX-2-max'],
  );
  assert.equal(done.flow.edges.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(done.flow.edges[i]?.source, done.flow.nodes[i]?.id);
    assert.equal(done.flow.edges[i]?.target, done.flow.nodes[i + 1]?.id);
    assert.equal(done.flow.edges[i]?.sourceHandle, 'out');
    assert.equal(done.flow.edges[i]?.targetHandle, 'in');
  }
  assert.ok(workerUrlsHit.some(u => u.startsWith(`${COMPOSE_MODELS_ORIGIN}/search`)));
  assert.ok(workerUrlsHit.some(u => u.startsWith(`${COMPOSE_CONNECTORS_ORIGIN}/`)));
});

test('createVibeStream defaults to clean create mode ignoring dirty canvas nodes/history, and edit mode never auto-chains unanchored steps', async () => {
  const dirtyExistingNodeId = randomUUID();
  const dirtyFlow: Flow = {
    id: randomUUID(),
    name: 'Stale Unsaved Canvas',
    brief: 'Old unrelated brief',
    banner: 'https://example.com/old-banner.png',
    tasks: ['Analytics'],
    nodes: [
      {
        id: dirtyExistingNodeId,
        type: 'step',
        position: { x: 100, y: 100 },
        data: {
          label: 'Old Stale Step',
          kind: 'connector',
          note: 'Old notion action',
          entry: { id: 'account:notion', kind: 'connector', name: 'Notion' },
        },
      },
    ],
    edges: [],
    modified: new Date().toISOString(),
  };

  let createTurn = 0;
  const capturedCreateMessages: Array<Array<{ role: string; content?: string }>> = [];
  const createMockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, NEBIUS_CHAT_URL);
    const parsed = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content?: string }>;
    };
    capturedCreateMessages.push(parsed.messages);
    createTurn += 1;
    if (createTurn === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_new_title',
                    function: {
                      name: 'set_title',
                      arguments: JSON.stringify({ title: 'Fresh Clean Workflow' }),
                    },
                  },
                  {
                    index: 1,
                    id: 'tc_new_step',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        label: 'Fresh Step',
                        kind: 'model',
                        entryId: 'deepseek-v3',
                        note: 'Summarize fresh input',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    return makeSseResponse([{ choices: [{ delta: { content: 'Created fresh workflow.' } }] }]);
  };

  let rawCreate = '';
  for await (const chunk of createVibeStream(
    {
      prompt: 'Build a fresh summarizer',
      flow: dirtyFlow,
      history: [
        { role: 'user', content: 'Old conversation turn' },
        { role: 'assistant', content: 'Old assistant reply' },
      ],
    },
    {
      fetchImpl: createMockFetch,
      catalogLoader: async () => [
        { id: 'deepseek-v3', kind: 'model', name: 'DeepSeek V3', description: 'LLM' },
      ],
      bannerGenerator: async () => ({ imageUrl: 'https://example.com/fresh.png', cid: 'fresh' }),
    },
  )) {
    rawCreate += String(chunk);
  }

  // Stale history and stale nodes must NOT appear in create mode prompt or output
  const firstPromptJson = JSON.stringify(capturedCreateMessages[0]);
  assert.equal(firstPromptJson.includes('Old Stale Step'), false);
  assert.equal(firstPromptJson.includes('Old conversation turn'), false);

  const createEvents = rawCreate
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as VibeStreamEvent);
  const createDone = createEvents.find(e => e.type === 'done');
  assert.ok(createDone && createDone.type === 'done');
  assert.equal(createDone.flow.nodes.length, 1);
  assert.equal(createDone.flow.nodes[0]?.data.label, 'Fresh Step');
  assert.equal(createDone.flow.edges.length, 0);

  // Even in explicit edit mode, an unanchored add_step must NOT auto-wire to dirtyExistingNodeId
  let editTurn = 0;
  const editMockFetch: typeof fetch = async (_input, _init) => {
    editTurn += 1;
    if (editTurn === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_unanchored',
                    function: {
                      name: 'add_step',
                      arguments: JSON.stringify({
                        label: 'Standalone Step',
                        kind: 'model',
                        entryId: 'deepseek-v3',
                        note: 'Independent node',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    return makeSseResponse([{ choices: [{ delta: { content: 'Added standalone step.' } }] }]);
  };

  let rawEdit = '';
  for await (const chunk of createVibeStream(
    {
      prompt: 'Add a standalone step',
      flow: dirtyFlow,
      mode: 'edit',
    },
    {
      fetchImpl: editMockFetch,
      catalogLoader: async () => [
        { id: 'deepseek-v3', kind: 'model', name: 'DeepSeek V3', description: 'LLM' },
      ],
      bannerGenerator: async () => ({ imageUrl: 'https://example.com/edit.png', cid: 'edit' }),
    },
  )) {
    rawEdit += String(chunk);
  }

  const editEvents = rawEdit
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as VibeStreamEvent);
  const editDone = editEvents.find(e => e.type === 'done');
  assert.ok(editDone && editDone.type === 'done');
  assert.equal(editDone.flow.nodes.length, 2);
  assert.equal(editDone.flow.edges.length, 0);
});
