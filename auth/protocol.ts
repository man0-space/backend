import { createHash, randomInt } from 'node:crypto';
import { base58 } from '@scure/base';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const DOMAIN_SEPARATOR = Buffer.from('NEAR_WALLET_CONTRACT/V1', 'utf8');

const KECCAK_ROUNDS = 24;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const KECCAK_PI = [
  0, 6, 12, 18, 24, 3, 9, 10, 16, 22, 1, 7, 13, 19, 20, 4, 5, 11, 17, 23, 2, 8, 14, 15, 21,
];
const MASK_64 = 0xffffffffffffffffn;

function rotl64(x: bigint, s: number): bigint {
  return s === 0 ? x : ((x << BigInt(s)) | (x >> BigInt(64 - s))) & MASK_64;
}

export function keccak256(data: Uint8Array): Buffer {
  const rate = 136;
  const state = new BigUint64Array(25);
  const padLen = rate - (data.length % rate);
  const padded = Buffer.alloc(data.length + padLen);
  padded.set(data, 0);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const b = new BigUint64Array(25);
  const c = new BigUint64Array(5);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < 17; i++) {
      state[i] ^= padded.readBigUInt64LE(offset + i * 8);
    }
    for (let round = 0; round < KECCAK_ROUNDS; round++) {
      for (let x = 0; x < 5; x++) {
        c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) state[x + y] = (state[x + y] ^ d) & MASK_64;
      }
      for (let i = 0; i < 25; i++) {
        b[i] = rotl64(state[KECCAK_PI[i]], KECCAK_ROT[KECCAK_PI[i]]);
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          state[x + y] = (b[x + y] ^ (~b[((x + 1) % 5) + y] & b[((x + 2) % 5) + y])) & MASK_64;
        }
      }
      state[0] = (state[0] ^ KECCAK_RC[round]) & MASK_64;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}

export function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

export function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

export function u128le(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  const low = value & 0xffffffffffffffffn;
  const high = (value >> 64n) & 0xffffffffffffffffn;
  buf.writeBigUInt64LE(low, 0);
  buf.writeBigUInt64LE(high, 8);
  return buf;
}

export function borshBytes(bytes: Uint8Array): Buffer {
  return Buffer.concat([u32le(bytes.length), Buffer.from(bytes)]);
}

export function borshString(value: string): Buffer {
  return borshBytes(Buffer.from(value, 'utf8'));
}

export function compress(key: Uint8Array): Buffer {
  if (key.length === 33) {
    if (key[0] !== 0x02 && key[0] !== 0x03) {
      throw new Error('Invalid P-256 compressed public key.');
    }
    return Buffer.from(key);
  }
  if (key.length === 65 && key[0] === 0x04) {
    const prefix = (key[64] & 1) === 1 ? 0x03 : 0x02;
    return Buffer.concat([Buffer.from([prefix]), Buffer.from(key.subarray(1, 33))]);
  }
  if (key.length === 64) {
    const prefix = (key[63] & 1) === 1 ? 0x03 : 0x02;
    return Buffer.concat([Buffer.from([prefix]), Buffer.from(key.subarray(0, 32))]);
  }
  throw new Error('Invalid P-256 public key length.');
}

export function uncompress(key: Uint8Array): Buffer {
  if (key.length === 64) {
    const tagged = Buffer.concat([Buffer.from([0x04]), Buffer.from(key)]);
    const pt = p256.Point.fromBytes(tagged);
    return Buffer.from(pt.toBytes(false).subarray(1, 65));
  }
  if (key.length === 65 && key[0] === 0x04) {
    const pt = p256.Point.fromBytes(key);
    return Buffer.from(pt.toBytes(false).subarray(1, 65));
  }
  if (key.length === 33 && (key[0] === 0x02 || key[0] === 0x03)) {
    const pt = p256.Point.fromBytes(key);
    return Buffer.from(pt.toBytes(false).subarray(1, 65));
  }
  throw new Error('Invalid P-256 public key for uncompressed conversion.');
}

export function intentsPublicKey(
  curve: 'p256' | 'secp256k1' | 'ed25519',
  key: Uint8Array,
): string {
  if (curve === 'p256') {
    const raw64 = uncompress(key);
    return `p256:${base58.encode(raw64)}`;
  }
  if (curve === 'secp256k1') {
    let raw64: Uint8Array;
    if (key.length === 64) {
      const pt = secp256k1.Point.fromBytes(Buffer.concat([Buffer.from([0x04]), Buffer.from(key)]));
      raw64 = pt.toBytes(false).subarray(1, 65);
    } else if (key.length === 65 && key[0] === 0x04) {
      const pt = secp256k1.Point.fromBytes(key);
      raw64 = pt.toBytes(false).subarray(1, 65);
    } else if (key.length === 33 && (key[0] === 0x02 || key[0] === 0x03)) {
      const pt = secp256k1.Point.fromBytes(key);
      raw64 = pt.toBytes(false).subarray(1, 65);
    } else {
      throw new Error('Invalid secp256k1 public key length.');
    }
    return `secp256k1:${base58.encode(raw64)}`;
  }
  if (key.length !== 32) {
    throw new Error('Invalid ed25519 public key length.');
  }
  return `ed25519:${base58.encode(key)}`;
}

export function state(
  key: Uint8Array,
  subwalletId = 0,
  timeoutSecs = 3600,
  extensions: string[] = [],
): Buffer {
  const compressed = compress(key);
  const sortedExtensions = [...new Set(extensions)].sort();
  return Buffer.concat([
    Buffer.from([1]),
    u32le(subwalletId),
    compressed,
    u32le(timeoutSecs),
    u64le(0n),
    u32le(0),
    u32le(0),
    u32le(sortedExtensions.length),
    ...sortedExtensions.map(borshString),
  ]);
}

export type GlobalContractCode =
  | string
  | { accountId: string; codeHash?: never }
  | { codeHash: string; accountId?: never };

function encodeGlobalContractIdentifier(code: GlobalContractCode): Buffer {
  if (typeof code === 'object') {
    if ('accountId' in code && code.accountId) {
      return Buffer.concat([Buffer.from([1]), borshString(code.accountId)]);
    }
    if ('codeHash' in code && code.codeHash) {
      const decoded = base58.decode(code.codeHash);
      if (decoded.length !== 32) {
        throw new Error('Global contract code hash must be 32 bytes.');
      }
      return Buffer.concat([Buffer.from([0]), Buffer.from(decoded)]);
    }
    throw new Error('Global contract identifier is required.');
  }
  const trimmed = code.trim();
  if (
    /^0s[0-9a-f]{40}$/.test(trimmed) ||
    /^0u[0123456789abcdefghjkmnpqrstvwxyz]{52}$/.test(trimmed) ||
    trimmed.includes('.')
  ) {
    return Buffer.concat([Buffer.from([1]), borshString(trimmed)]);
  }
  const codeHash = base58.decode(trimmed);
  if (codeHash.length !== 32) {
    throw new Error('Global contract code hash must be 32 bytes.');
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from(codeHash)]);
}

export function initialization(
  code: GlobalContractCode,
  stateBytes: Uint8Array,
  accessKeys: Uint8Array[] = [],
): Buffer {
  const encodedCode = encodeGlobalContractIdentifier(code);
  const uniqueKeys = [
    ...new Map(accessKeys.map(k => [Buffer.from(k).toString('hex'), Buffer.from(k)])).values(),
  ].sort(Buffer.compare);

  return Buffer.concat([
    Buffer.from([0]),
    Buffer.from([1]),
    encodedCode,
    u32le(1),
    u32le(0),
    borshBytes(stateBytes),
    u32le(uniqueKeys.length),
    ...uniqueKeys,
  ]);
}

export function extractStateKey(rawStateInit: Uint8Array): Buffer {
  const buf = Buffer.from(rawStateInit);
  if (buf.length < 20 || buf[0] !== 0 || buf[1] !== 1) {
    throw new Error('Malformed UniversalStateInit bytes.');
  }
  let offset = 2;
  const codeDiscriminant = buf[offset++];
  if (codeDiscriminant === 0) {
    offset += 32;
  } else if (codeDiscriminant === 1) {
    const accountLen = buf.readUInt32LE(offset);
    offset += 4 + accountLen;
  } else {
    throw new Error('Unknown GlobalContractIdentifier discriminant.');
  }
  const dataCount = buf.readUInt32LE(offset);
  offset += 4;
  if (dataCount < 1) {
    throw new Error('UniversalStateInit has no state entries.');
  }
  const keyLen = buf.readUInt32LE(offset);
  offset += 4 + keyLen;
  const valLen = buf.readUInt32LE(offset);
  offset += 4;
  if (valLen < 38 || offset + valLen > buf.length) {
    throw new Error('Invalid wallet State value in UniversalStateInit.');
  }
  // State layout: [signature_enabled(1), subwallet_id(4), compressed_p256(33), ...]
  const keySlice = buf.subarray(offset + 5, offset + 38);
  return compress(keySlice);
}

export function address(rawStateInit: Uint8Array): string {
  const digest = createHash('sha3-256').update(rawStateInit).digest();
  let bits = 0;
  let value = 0;
  let out = '0u';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return out;
}

export interface Operation {
  op: 'set_signature_mode' | 'add_extension' | 'remove_extension';
  payload: {
    enable?: boolean;
    account_id?: string;
  };
}

export interface Action {
  action: 'function_call' | 'transfer' | 'state_init';
  payload: {
    function_name?: string;
    args?: string;
    deposit?: string;
    gas?: number | string;
    gas_weight?: number | string;
    amount?: string;
    code?: { hash?: string; account_id?: string };
    data?: Record<string, string>;
  };
}

export interface Call {
  receiver_id: string;
  refund_to?: string;
  actions: Action[];
}

export interface Message {
  pay_for_gas?: boolean;
  chain_id?: string;
  network_id?: string;
  signer_id: string;
  nonce: number;
  created_at: string;
  timeout_secs: number;
  request: {
    internal?: Operation[];
    external?: Call[];
  };
}

function parseTimestampNanos(iso: string): bigint {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error('Invalid RFC-3339 timestamp.');
  return BigInt(ms) * 1000000n;
}

function serializeOp(op: Operation): Buffer {
  if (op.op === 'set_signature_mode') {
    return Buffer.from([0, op.payload.enable ? 1 : 0]);
  }
  if (op.op === 'add_extension') {
    return Buffer.concat([Buffer.from([1]), borshString(op.payload.account_id ?? '')]);
  }
  if (op.op === 'remove_extension') {
    return Buffer.concat([Buffer.from([2]), borshString(op.payload.account_id ?? '')]);
  }
  throw new Error('Unsupported wallet internal operation.');
}

function serializeAction(item: Action): Buffer {
  if (item.action === 'function_call') {
    const args = item.payload.args ? Buffer.from(item.payload.args, 'base64') : Buffer.alloc(0);
    const deposit = BigInt(item.payload.deposit ?? '0');
    const gas = BigInt(item.payload.gas ?? 0);
    const gasWeight = BigInt(item.payload.gas_weight ?? 1);
    return Buffer.concat([
      Buffer.from([2]),
      borshString(item.payload.function_name ?? ''),
      borshBytes(args),
      u128le(deposit),
      u64le(gas),
      u64le(gasWeight),
    ]);
  }
  if (item.action === 'transfer') {
    return Buffer.concat([Buffer.from([3]), u128le(BigInt(item.payload.amount ?? '0'))]);
  }
  if (item.action === 'state_init') {
    const code = item.payload.code ?? {};
    const codeBytes = code.hash
      ? Buffer.concat([Buffer.from([0]), Buffer.from(base58.decode(code.hash))])
      : Buffer.concat([Buffer.from([1]), borshString(code.account_id ?? '')]);
    const entries = Object.entries(item.payload.data ?? {})
      .map(([k, v]) => [Buffer.from(k, 'base64'), Buffer.from(v, 'base64')] as const)
      .sort(([a], [b]) => Buffer.compare(a, b));
    return Buffer.concat([
      Buffer.from([11]),
      Buffer.from([0]),
      codeBytes,
      u32le(entries.length),
      ...entries.flatMap(([k, v]) => [borshBytes(k), borshBytes(v)]),
      u128le(BigInt(item.payload.deposit ?? '0')),
    ]);
  }
  throw new Error('Unsupported wallet external action.');
}

function serializePromise(promise: Call): Buffer {
  const refund = promise.refund_to
    ? Buffer.concat([Buffer.from([1]), borshString(promise.refund_to)])
    : Buffer.from([0]);
  return Buffer.concat([
    borshString(promise.receiver_id),
    refund,
    u32le(promise.actions.length),
    ...promise.actions.map(serializeAction),
  ]);
}

export function commitment(msg: Message): Buffer {
  const internal = msg.request.internal ?? [];
  const external = msg.request.external ?? [];
  const encoded = Buffer.concat([
    Buffer.from([msg.pay_for_gas ? 1 : 0]),
    borshString(msg.chain_id ?? msg.network_id ?? ''),
    borshString(msg.signer_id),
    u32le(msg.nonce),
    u64le(parseTimestampNanos(msg.created_at)),
    u32le(msg.timeout_secs),
    u32le(internal.length),
    ...internal.map(serializeOp),
    u32le(external.length),
    ...external.map(serializePromise),
  ]);
  return createHash('sha3-256').update(DOMAIN_SEPARATOR).update(encoded).digest();
}

export function ed25519AccessKeyHandle(pubKey32: Uint8Array): Buffer {
  if (pubKey32.length !== 32) {
    throw new Error('Invalid Ed25519 public key length for UniversalStateInit.');
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from(pubKey32)]);
}

export function universalStateInitAction(rawStateInit: Uint8Array, deposit = 0n): Buffer {
  return Buffer.concat([Buffer.from([15]), borshBytes(rawStateInit), u128le(deposit)]);
}

export function transferAction(amount: bigint): Buffer {
  return Buffer.concat([Buffer.from([3]), u128le(amount)]);
}

export function addFullAccessKeyAction(pubKey32: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([5]),
    ed25519AccessKeyHandle(pubKey32),
    u64le(0n),
    Buffer.from([1]),
  ]);
}

export function functionCallAction(
  methodName: string,
  args: Uint8Array,
  gas: bigint,
  deposit: bigint,
): Buffer {
  return Buffer.concat([
    Buffer.from([2]),
    borshString(methodName),
    borshBytes(args),
    u64le(gas),
    u128le(deposit),
  ]);
}

export function serializeTransaction(input: {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: Uint8Array[];
}): Buffer {
  return Buffer.concat([
    borshString(input.signerId),
    Buffer.from([0]),
    Buffer.from(input.publicKey),
    u64le(input.nonce),
    borshString(input.receiverId),
    Buffer.from(input.blockHash),
    u32le(input.actions.length),
    ...input.actions.map(a => Buffer.from(a)),
  ]);
}

export interface WebAuthnProof {
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

export function normalizeP256Signature(sig: Uint8Array): Buffer {
  if (sig.length === 64) {
    const parsed = p256.Signature.fromBytes(sig);
    const normalized = parsed.hasHighS()
      ? new p256.Signature(parsed.r, p256.Point.Fn.ORDER - parsed.s)
      : parsed;
    return Buffer.from(normalized.toBytes());
  }
  const parsed = p256.Signature.fromBytes(sig, 'der');
  const normalized = parsed.hasHighS()
    ? new p256.Signature(parsed.r, p256.Point.Fn.ORDER - parsed.s)
    : parsed;
  return Buffer.from(normalized.toBytes());
}

export function signWebAuthnP256(
  privateKey32: Uint8Array,
  challenge32: Uint8Array,
  originUrl = 'https://man0.space',
  rpId = 'man0.space',
  signCount = 1,
): WebAuthnProof {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(signCount >>> 0, 0);
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), countBuf]);
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(challenge32).toString('base64url'),
    origin: originUrl,
  });
  const clientDataHash = createHash('sha256').update(clientDataJSON, 'utf8').digest();
  const effectiveMsg = Buffer.concat([authData, clientDataHash]);
  const prehash = createHash('sha256').update(effectiveMsg).digest();
  const sig64 = p256.sign(prehash, privateKey32, { prehash: false, lowS: true });
  return {
    authenticator_data: authData.toString('base64url'),
    client_data_json: clientDataJSON,
    signature: `p256:${base58.encode(sig64)}`,
  };
}

export function webAuthnAssertionToProof(assertion: {
  response?: {
    authenticatorData?: string;
    clientDataJSON?: string;
    signature?: string;
  };
  authenticator_data?: string;
  client_data_json?: string;
  signature?: string;
}): WebAuthnProof {
  const authenticatorData = assertion.response?.authenticatorData ?? assertion.authenticator_data;
  const clientDataJSON = assertion.response?.clientDataJSON ?? assertion.client_data_json;
  const rawSignature = assertion.response?.signature ?? assertion.signature;
  if (!authenticatorData || !clientDataJSON || !rawSignature) {
    throw Object.assign(new Error('Malformed WebAuthn assertion payload.'), { statusCode: 400 });
  }
  const clientDataText = (() => {
    const trimmed = clientDataJSON.trim();
    if (trimmed.startsWith('{')) return trimmed;
    return Buffer.from(trimmed, 'base64url').toString('utf8');
  })();
  const sigBytes = rawSignature.startsWith('p256:')
    ? base58.decode(rawSignature.slice(5))
    : Buffer.from(rawSignature, 'base64url');
  const sig64 = normalizeP256Signature(sigBytes);
  return {
    authenticator_data: authenticatorData,
    client_data_json: clientDataText,
    signature: `p256:${base58.encode(sig64)}`,
  };
}


export function verifyWebAuthnP256(
  publicKey: Uint8Array,
  challenge32: Uint8Array,
  proof: WebAuthnProof,
): boolean {
  try {
    const authData = Buffer.from(proof.authenticator_data, 'base64url');
    if (authData.length < 37) return false;
    const flags = authData[32];
    if ((flags & 0x01) !== 0x01) return false;
    if ((flags & 0x08) !== 0x08 && (flags & 0x10) === 0x10) return false;

    const clientData = JSON.parse(proof.client_data_json) as {
      type?: string;
      challenge?: string;
    };
    if (clientData.type !== 'webauthn.get' || !clientData.challenge) return false;
    const challengeBytes = Buffer.from(clientData.challenge, 'base64url');
    if (!challengeBytes.equals(Buffer.from(challenge32))) return false;

    const rawSig = proof.signature.startsWith('p256:')
      ? base58.decode(proof.signature.slice(5))
      : Buffer.from(proof.signature, 'base64url');
    const sig64 = normalizeP256Signature(rawSig);
    const parsedSig = p256.Signature.fromBytes(sig64);
    if (parsedSig.hasHighS()) return false;

    const clientDataHash = createHash('sha256').update(proof.client_data_json, 'utf8').digest();
    const effectiveMsg = Buffer.concat([authData, clientDataHash]);
    const prehash = createHash('sha256').update(effectiveMsg).digest();
    const compressed = compress(publicKey);
    return p256.verify(sig64, prehash, compressed, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}
