import { randomBytes } from 'node:crypto';
import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { decodeCredentialPublicKey, cose } from '@simplewebauthn/server/helpers';

const { isCOSEPublicKeyEC2, COSEKEYS, COSEALG } = cose;

export function options(mode: 'create' | 'login', rp: string, customChallenge?: string) {
  const challenge = customChallenge ?? randomBytes(32).toString('base64url');
  if (mode === 'create') {
    const id = randomBytes(32).toString('base64url');
    return {
      challenge,
      rp: { name: rp, id: rp },
      user: { id, name: id, displayName: '' },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' as const }],
      timeout: 60000,
      attestation: 'none' as const,
      authenticatorSelection: {
        residentKey: 'preferred' as const,
        requireResidentKey: false,
        userVerification: 'preferred' as const,
      },
    };
  }
  return {
    challenge,
    rpId: rp,
    timeout: 60000,
    userVerification: 'preferred' as const,
  };
}

export async function registration(
  response: RegistrationResponseJSON,
  expected: {
    challenge: string;
    origin: string;
    rp: string;
  },
) {
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
    expectedRPID: expected.rp,
    requireUserVerification: false,
    supportedAlgorithmIDs: [-7],
  });
  if (!verified.verified || !verified.registrationInfo) {
    throw Object.assign(new Error('Passkey registration verification failed.'), { statusCode: 401 });
  }
  const credential = verified.registrationInfo.credential;
  const decoded = decodeCredentialPublicKey(credential.publicKey);
  if (
    !isCOSEPublicKeyEC2(decoded) ||
    decoded.get(COSEKEYS.alg) !== COSEALG.ES256 ||
    decoded.get(COSEKEYS.crv) !== 1
  ) {
    throw Object.assign(new Error('This passkey must use the P-256 (ES256) signing algorithm.'), {
      statusCode: 400,
    });
  }
  const x = Buffer.from(decoded.get(COSEKEYS.x)!);
  const y = Buffer.from(decoded.get(COSEKEYS.y)!);
  if (x.length !== 32 || y.length !== 32) {
    throw Object.assign(new Error('Invalid P-256 public key coordinates.'), {
      statusCode: 400,
    });
  }
  const key = Buffer.concat([Buffer.from([4]), x, y]);
  return { credential, key, info: verified.registrationInfo };
}

export async function authentication(
  response: AuthenticationResponseJSON,
  expected: {
    challenge: string;
    origin: string;
    rp: string;
    credential: WebAuthnCredential;
  },
) {
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
    expectedRPID: expected.rp,
    requireUserVerification: false,
    credential: expected.credential,
  });
  if (!verified.verified || !verified.authenticationInfo) {
    throw Object.assign(new Error('Passkey authentication failed.'), { statusCode: 401 });
  }
  return verified.authenticationInfo;
}
