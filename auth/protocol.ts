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
