import { createECDH, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { config, required, rpcFor, treasuryFor, usdcFor } from '../config.js';
import { cached, cacheDel } from '../databases/cache.js';
import { user } from '../databases/client.js';
import {
  addFullAccessKeyAction,
  address,
  buildWalletAddPublicKeyMessage,
  buildWalletContractCallMessage,
  commitment,
  compress,
  ed25519AccessKeyHandle,
  extractStateKey,
  functionCallAction,
  initialization,
  intentsPublicKey,
  serializeTransaction,
  signWebAuthnP256,
  state,
  transferAction,
  universalStateInitAction,
  type Message,
  type WebAuthnProof,
} from './protocol.js';

const require = createRequire(import.meta.url);

export const MAINNET_GLOBAL_WALLET_CONTRACT =
  process.env.NEAR_UNIVERSAL_CONTRACT_ACCOUNT?.trim() ||
  '0saf343be226341c0eca7dba6d0b29d49bdff3ad03';

export const TESTNET_GLOBAL_WALLET_CODE_HASH =
  process.env.NEAR_UNIVERSAL_CONTRACT_CODE_HASH?.trim() ||
  'AjYXfrYzBs5BR7GmmFgCSghc6nccq4LCfSxkYTUqnZKK';

export function codeFor(network: 'mainnet' | 'testnet' = config.network): string {
  return network === 'mainnet'
    ? MAINNET_GLOBAL_WALLET_CONTRACT
    : TESTNET_GLOBAL_WALLET_CODE_HASH;
}

export const code = codeFor(config.network);

export interface Account {
  account: string;
  state: string;
  code: string;
}

export function derivePrivate(id: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.secret, 'hex'),
      Buffer.from(id, 'utf8'),
      Buffer.from('universal account owner', 'utf8'),
      32,
    ),
  );
}

export function derive(id: string): Buffer {
  const seed = derivePrivate(id);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(seed);
  return Buffer.from(ecdh.getPublicKey(null, 'compressed'));
}

export async function prepare(
  key: Uint8Array,
  network: 'mainnet' | 'testnet' = config.network,
): Promise<Account> {
  const targetCode = codeFor(network);
  const compressed = compress(key);
  const rawState = state(compressed);
  const rawInit = initialization(targetCode, rawState);
  const account = address(rawInit);
  return {
    account,
    state: rawInit.toString('base64'),
    code: targetCode,
  };
}

export function facilitatorPublicKey32(): Buffer {
  const raw = config.facilitatorPrivateKey.trim();
  const stripped = raw.startsWith('ed25519:') ? raw.slice(8) : raw;
  const decoded = Buffer.from(base58.decode(stripped));
  if (decoded.length >= 64) {
    return Buffer.from(decoded.subarray(32, 64));
  }
  if (decoded.length === 32) {
    return Buffer.from(ed25519.getPublicKey(decoded));
  }
  throw new Error('Invalid NEAR_FACILITATOR_KEY length.');
}

export function prepareSpending(
  key: Uint8Array,
  network: 'mainnet' | 'testnet' = config.network,
): Account {
  const targetCode = codeFor(network);
  const compressed = compress(key);
  const rawState = state(compressed, 1);
  const rawInit = initialization(targetCode, rawState, [
    ed25519AccessKeyHandle(facilitatorPublicKey32()),
  ]);
  return {
    account: address(rawInit),
    state: rawInit.toString('base64'),
    code: targetCode,
  };
}

let accountColumnsEnsured = false;
async function ensureAccountColumns(): Promise<void> {
  if (accountColumnsEnsured) return;
  await user`
    ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS "spendingAddress" text,
    ADD COLUMN IF NOT EXISTS "spendingState" text
  `;
  await user`
    CREATE INDEX IF NOT EXISTS accounts_spending_idx ON accounts ("spendingAddress")
  `;
  accountColumnsEnsured = true;
}

export function oneClickBaseUrl(network: 'mainnet' | 'testnet' = config.network): string {
  if (network === 'testnet') {
    return (process.env.ONECLICK_TESTNET_URL?.trim() || 'https://www.usetidepool.tech').replace(
      /\/+$/,
      '',
    );
  }
  return (
    process.env.ONECLICK_MAINNET_URL?.trim() || 'https://1click.chaindefuser.com'
  ).replace(/\/+$/, '');
}

export interface NearIntentsContracts {
  verifier: string;
  intentsUsdcContract: string | null;
  nearTokenContracts: string[];
}

export async function discoverNearIntentsContracts(
  network: 'mainnet' | 'testnet' = config.network,
): Promise<NearIntentsContracts> {
  const baseUrl = oneClickBaseUrl(network);
  return cached(`near:intents:contracts:${network}:${baseUrl}`, 300, async () => {
    const [healthRes, tokensRes] = await Promise.all([
      fetch(`${baseUrl}/v0/health`, { signal: AbortSignal.timeout(8_000) }).catch(() => null),
      fetch(`${baseUrl}/v0/tokens`, { signal: AbortSignal.timeout(10_000) }).catch(() => null),
    ]);
    let verifier = '';
    if (healthRes?.ok) {
      const health = (await healthRes.json().catch(() => null)) as { verifier?: string } | null;
      if (typeof health?.verifier === 'string' && health.verifier.trim()) {
        verifier = health.verifier.trim();
      }
    }
    if (!verifier) {
      const intentsPkg = require('@defuse-protocol/intents-sdk') as {
        IntentsSDK?: new (args: { referral: string }) => unknown;
      };
      void intentsPkg;
      verifier =
        network === 'mainnet'
          ? process.env.NEAR_INTENTS_VERIFIER_MAINNET?.trim() || 'intents.near'
          : process.env.NEAR_INTENTS_VERIFIER_TESTNET?.trim() || '';
    }
    const nearTokenContracts: string[] = [];
    let intentsUsdcContract: string | null = null;
    if (tokensRes?.ok) {
      const tokens = (await tokensRes.json().catch(() => null)) as Array<{
        blockchain?: string;
        symbol?: string;
        contractAddress?: string;
        assetId?: string;
      }> | null;
      if (Array.isArray(tokens)) {
        for (const token of tokens) {
          if (token.blockchain !== 'near') continue;
          const contract =
            token.contractAddress?.trim() ||
            (typeof token.assetId === 'string' && token.assetId.startsWith('nep141:')
              ? token.assetId.slice('nep141:'.length).trim()
              : '');
          if (!contract) continue;
          if (!nearTokenContracts.includes(contract)) nearTokenContracts.push(contract);
          if (!intentsUsdcContract && token.symbol?.toUpperCase() === 'USDC') {
            intentsUsdcContract = contract;
          }
          if (!verifier && contract.includes('.')) {
            const dot = contract.indexOf('.');
            const domain = contract.slice(dot + 1);
            if (domain.endsWith('.testnet')) {
              verifier = `verifier.${domain}`;
            }
          }
        }
      }
    }
    if (!verifier) {
      throw new Error(`Unable to discover NEAR Intents verifier contract for ${network}.`);
    }
    return { verifier, intentsUsdcContract, nearTokenContracts };
  });
}
