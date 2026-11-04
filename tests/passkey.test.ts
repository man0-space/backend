import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { options, registration } from '../auth/passkey.js';

test('passkey options restrict credential creation strictly to P-256 (ES256, -7)', () => {
  const createOpts = options('create', 'man0.space') as {
    pubKeyCredParams?: Array<{ alg: number; type: string }>;
  };
  assert.deepEqual(createOpts.pubKeyCredParams, [{ alg: -7, type: 'public-key' }]);
});

test('registration verifies a real synthetic P-256 credential and rejects Ed25519 (-8), changed origin, or changed challenge', async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const credential = randomBytes(32);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credential.length);
  const auth = Buffer.concat([
    createHash('sha256').update('man0.space').digest(),
    Buffer.from([69]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    length,
    credential,
    cose,
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: 'challenge',
      origin: 'https://man0.space',
      crossOrigin: false,
    }),
  ).toString('base64url');
  const response = {
    id: credential.toString('base64url'),
    rawId: credential.toString('base64url'),
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: client,
      attestationObject: Buffer.from(
        isoCBOR.encode(
          new Map<string, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', auth],
          ]),
        ),
      ).toString('base64url'),
    },
  };
  const actual = await registration(response, {
    challenge: 'challenge',
    origin: 'https://man0.space',
    rp: 'man0.space',
  });
  assert.equal(actual.credential.id, response.id);
  assert.deepEqual(
    Buffer.from(actual.key),
    Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]),
  );
  await assert.rejects(
    registration(response, {
      challenge: 'another',
      origin: 'https://man0.space',
      rp: 'man0.space',
    }),
  );
  await assert.rejects(
    registration(response, {
      challenge: 'challenge',
      origin: 'https://evil.example',
      rp: 'man0.space',
    }),
  );

  // Reject Ed25519 (-8) credentials because wallet-webauthn-p256 only supports P-256
  const edCose = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, randomBytes(32)],
    ]),
  );
  const edAuth = Buffer.concat([
    createHash('sha256').update('man0.space').digest(),
    Buffer.from([69]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    length,
    credential,
    edCose,
  ]);
  const edResponse = {
    ...response,
    response: {
      clientDataJSON: client,
      attestationObject: Buffer.from(
        isoCBOR.encode(
          new Map<string, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', edAuth],
          ]),
        ),
      ).toString('base64url'),
    },
  };
  await assert.rejects(
    registration(edResponse, {
      challenge: 'challenge',
      origin: 'https://man0.space',
      rp: 'man0.space',
    }),
  );
});
