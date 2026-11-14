import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ready } from '../databases/cache.js';
import { user } from '../databases/client.js';
import { privateKey, issuer } from '../auth/config.js';
import { sign } from '../auth/token.js';
import { digest } from '../auth/digest.js';
import { build } from '../server.js';
import {
  GEMINI_IMAGE_MODEL,
  MAN0_BRAND_STYLE,
  buildAvatarPrompt,
  buildBannerPrompt,
} from '../agents/media.js';

const testUser = `test-media:${randomUUID()}`;
const jwt = await sign(privateKey, issuer!, testUser, randomBytes(32).toString('base64url'), 3600);
const composeSessionToken = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: testUser,
      keyId: 'key-media-1',
      network: 'near:testnet',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `compose-${header}.${payload}.sig`;
})();

const calls: Array<{ url: string; init?: RequestInit }> = [];
const bannerPaymentCalls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
const samplePngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

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
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url.endsWith('/api/payments/prepare')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bannerPaymentCalls.push({ endpoint: 'prepare', body });
    return new Response(
      JSON.stringify({ paymentIntentId: 'pi-banner-1', userAddress: testUser }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url.endsWith('/api/payments/settle')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bannerPaymentCalls.push({ endpoint: 'settle', body });
    return new Response(
      JSON.stringify({ status: 'confirmed', txHash: 'near_banner_tx_1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  calls.push({ url, init });

  if (url === 'https://logos.composio.dev/api/notion') {
    return new Response(Buffer.from(samplePngBase64, 'base64'), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }

  if (url.includes(`models/${GEMINI_IMAGE_MODEL}:generateContent`)) {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: samplePngBase64,
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (url === 'https://api.pinata.cloud/pinning/pinFileToIPFS') {
    const body = init?.body as FormData;
    assert.ok(body instanceof FormData, 'Expected multipart FormData for Pinata upload');
    const optionsRaw = body.get('pinataOptions');
    assert.equal(optionsRaw, JSON.stringify({ cidVersion: 1 }));
    return new Response(
      JSON.stringify({
        IpfsHash: 'bafkreigeneratedmediacidv1example1234567890abcdef',
        PinSize: 8,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  throw new Error(`Unexpected fetch URL in media.test.ts: ${url}`);
};

let app: Awaited<ReturnType<typeof build>>;

before(async () => {
  await ready();
  app = await build({ fetchImpl: mockFetch });
  await user`INSERT INTO users ("userAddress", name) VALUES (${testUser}, 'Media Tester')`;
  await user`INSERT INTO tokens (id, "userAddress", jwt, expires) VALUES (${digest(jwt)}, ${testUser}, 'media fixture', now() + interval '1 hour')`;
  const policyRes = await app.inject({ method: 'GET', url: '/api/policy' });
  await app.inject({
    method: 'POST',
    url: '/api/consent',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { policy: policyRes.json().hash, terms: true, privacy: true },
  });
});

after(async () => {
  await user`DELETE FROM consents WHERE "userAddress" = ${testUser}`;
  await user`DELETE FROM tokens WHERE "userAddress" = ${testUser}`;
  await user`DELETE FROM users WHERE "userAddress" = ${testUser}`;
  await app.close();
});

test('man0 avatar and banner prompts enforce stealth-glass brand palette, banner title typography, and brand logos', () => {
  assert.equal(GEMINI_IMAGE_MODEL, 'gemini-nano-banana-2.1');
  assert.ok(MAN0_BRAND_STYLE.includes('#020305'));
  assert.ok(MAN0_BRAND_STYLE.includes('#38bdf8'));
  assert.ok(MAN0_BRAND_STYLE.includes('#ff2e63'));

  const avatarPrompt = buildAvatarPrompt('Nyra', 'Precision DeFi strategist');
  const bannerPrompt = buildBannerPrompt('Voice Notes to Fiction Stories', 'Transcribe voice notes and craft illustrated fiction stories.', [
    { name: 'Notion', url: 'https://logos.composio.dev/api/notion' },
    { name: 'Claude' },
  ]);
  assert.ok(avatarPrompt.includes('Nyra'));
  assert.ok(avatarPrompt.includes(MAN0_BRAND_STYLE));
  assert.ok(bannerPrompt.includes('Voice Notes to Fiction Stories'));
  assert.ok(bannerPrompt.includes('Prominently render the exact title "Voice Notes to Fiction Stories"'));
  assert.ok(bannerPrompt.includes('Notion, Claude'));
  assert.ok(bannerPrompt.includes(MAN0_BRAND_STYLE));
  assert.equal(/strictly no text/i.test(bannerPrompt), false);
});

test('POST /api/generate-avatar and /api/generate-banner validate required fields and pin CIDv1 images', async () => {
  const headers = { authorization: `Bearer ${jwt}` };

  const missingAvatar = await app.inject({
    method: 'POST',
    url: '/api/generate-avatar',
    headers,
    payload: { title: 'Nyra', description: '   ' },
  });
  assert.equal(missingAvatar.statusCode, 400);
  assert.match(missingAvatar.json().error, /Name \+ Description/);

  const missingBanner = await app.inject({
    method: 'POST',
    url: '/api/generate-banner',
    headers,
    payload: { title: '', description: 'Valid description' },
  });
  assert.equal(missingBanner.statusCode, 400);
  assert.match(missingBanner.json().error, /Title \+ Description/);

  calls.length = 0;
  const okAvatar = await app.inject({
    method: 'POST',
    url: '/api/generate-avatar',
    headers,
    payload: { title: 'Nyra', description: 'Autonomous risk & portfolio coordinator' },
  });
  assert.equal(okAvatar.statusCode, 200);
  assert.equal(okAvatar.json().cid, 'bafkreigeneratedmediacidv1example1234567890abcdef');
  assert.ok(okAvatar.json().imageUrl.endsWith('/ipfs/bafkreigeneratedmediacidv1example1234567890abcdef'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.includes('models/gemini-nano-banana-2.1:generateContent'));
  const geminiReq = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(geminiReq.generationConfig, { responseModalities: ['IMAGE'] });

  calls.length = 0;
  bannerPaymentCalls.length = 0;

  const unpaidBanner = await app.inject({
    method: 'POST',
    url: '/api/generate-banner',
    headers,
    payload: {
      title: 'Intents Yield Router',
      description: 'Routes NEAR Intents swaps with research synthesis',
    },
  });
  assert.equal(unpaidBanner.statusCode, 402);

  const okBanner = await app.inject({
    method: 'POST',
    url: '/api/generate-banner',
    headers: {
      ...headers,
      'x-compose-key': composeSessionToken,
      'x-network-id': 'near:testnet',
    },
    payload: {
      title: 'Intents Yield Router',
      description: 'Routes NEAR Intents swaps with research synthesis',
      logos: [
        { name: 'GPT-5', url: '/families/openai.png' },
        { name: 'Gemini 2.5', url: '/families/gemini-color.svg' },
        { name: 'Notion', url: 'https://logos.composio.dev/api/notion' },
      ],
    },
  });
  assert.equal(okBanner.statusCode, 200);
  assert.equal(okBanner.json().cid, 'bafkreigeneratedmediacidv1example1234567890abcdef');
  assert.equal(bannerPaymentCalls.length, 2);
  assert.equal(bannerPaymentCalls[0]!.body['service'], 'banner');
  assert.equal(bannerPaymentCalls[0]!.body['action'], 'generate');
  assert.equal(bannerPaymentCalls[0]!.body['maxAmountWei'], '30000');
  assert.equal(bannerPaymentCalls[1]!.body['finalAmountWei'], '30000');
  assert.equal(bannerPaymentCalls[1]!.body['meterSubject'], 'banner');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, 'https://logos.composio.dev/api/notion');
  assert.ok(calls[1]!.url.includes('models/gemini-nano-banana-2.1:generateContent'));
  const bannerGeminiReq = JSON.parse(String(calls[1]!.init?.body));
  const bannerPromptSent = String(
    (bannerGeminiReq.contents?.[0]?.parts ?? []).find((part: { text?: string }) => typeof part.text === 'string')?.text ?? '',
  );
  assert.ok(bannerPromptSent.includes('GPT-5, Gemini 2.5, Notion'));

  const duplicateZod = await app.inject({
    method: 'POST',
    url: '/api/generate-banner',
    headers,
    payload: {
      title: 'Duplicate Error Test',
      description: 'Checks deduplicated Zod validation error messages',
      logos: [{ name: '' }, { name: '' }],
    },
  });
  assert.equal(duplicateZod.statusCode, 400);
  const errMsg = String(duplicateZod.json().error);
  const parts = errMsg.split('Too small');
  assert.ok(parts.length <= 2, `Expected deduplicated ZodError message, got: ${errMsg}`);
});
