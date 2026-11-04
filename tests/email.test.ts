import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../auth/digest.js';
import { emailAvailable, startEmailVerification } from '../auth/email.js';

const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.EMAIL_FROM;

beforeEach(() => {
  process.env.RESEND_API_KEY = 'resend-test-key';
  delete process.env.EMAIL_FROM;
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
  if (originalFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originalFrom;
});

test('missing or blank email keys refuse sign-in before creating a challenge', async () => {
  for (const key of [undefined, '', '   ']) {
    if (key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = key;
    let created = false;
    assert.equal(emailAvailable(), false);
    await assert.rejects(
      startEmailVerification('creator@example.com', async () => {
        created = true;
        return 'unreachable';
      }, async () => { throw new Error('Transport must not be called.'); }),
      { statusCode: 503, message: 'Email sign-in is unavailable. Please try again later.' },
    );
    assert.equal(created, false);
  }
});

test('accepted delivery keeps the code in the message and its digest in storage', async () => {
  process.env.EMAIL_FROM = 'Man0 <auth@example.com>';
  let challenge: { kind: string; email: string; codeHash: string } | undefined;
  let sentCode = '';
  const result = await startEmailVerification('creator@example.com', async value => {
    challenge = value as typeof challenge;
    return 'challenge-fixture';
  }, async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer resend-test-key');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.to, ['creator@example.com']);
    assert.equal(body.from, 'Man0 <auth@example.com>');
    sentCode = body.subject.match(/^\d{6}/)?.[0] || '';
    assert.match(sentCode, /^\d{6}$/);
    assert.ok(body.text.includes(sentCode));
    return new Response('{"id":"email-fixture"}', { status: 200 });
  });
  assert.equal(emailAvailable(), true);
  assert.deepEqual(challenge, { kind: 'email', email: 'creator@example.com', codeHash: digest(sentCode) });
  assert.deepEqual(result, { id: 'challenge-fixture', email: 'creator@example.com', expiresIn: 300 });
  assert.equal('code' in result, false);
});

for (const status of [400, 401, 403, 429, 500, 503]) {
  test(`rejected delivery (${status}) returns a safe service error`, async () => {
    await assert.rejects(
      startEmailVerification('creator@example.com', async () => 'challenge-fixture',
        async () => new Response('Provider details and credentials must stay private.', { status })),
      { statusCode: 503, message: 'Email sign-in is unavailable. Please try again later.' },
    );
  });
}

test('transport failures never expose provider errors or a successful challenge', async () => {
  await assert.rejects(
    startEmailVerification('creator@example.com', async () => 'challenge-fixture',
      async () => { throw new Error('Transport included resend-test-key in its error.'); }),
    { statusCode: 503, message: 'Email sign-in is unavailable. Please try again later.' },
  );
});

test('default sender is retained when no override is configured', async () => {
  await startEmailVerification('creator@example.com', async () => 'challenge-fixture', async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).from, 'auth@man0.space');
    return new Response('{}', { status: 200 });
  });
});
