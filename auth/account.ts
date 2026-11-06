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

interface NearViewAccountResult {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  global_contract_account_id?: string;
  global_contract_hash?: string;
}

async function rpcCall<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`NEAR RPC HTTP error ${res.status}`);
  }
  const data = (await res.json()) as {
    result?: T;
    error?: {
      message?: string;
      data?: unknown;
      cause?: { name?: string };
    };
  };
  if (data.error) {
    const err = new Error(data.error.message || 'NEAR RPC error') as Error & {
      causeName?: string;
      rpcError?: unknown;
    };
    err.causeName = data.error.cause?.name;
    err.rpcError = data.error;
    throw err;
  }
  return data.result as T;
}

export async function viewAccount(
  rpcUrl: string,
  accountId: string,
): Promise<NearViewAccountResult | null> {
  try {
    return await rpcCall<NearViewAccountResult>(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'optimistic',
      account_id: accountId,
    });
  } catch (err) {
    const causeName = (err as { causeName?: string }).causeName;
    const msg = err instanceof Error ? err.message : String(err);
    if (causeName === 'UNKNOWN_ACCOUNT' || msg.includes('does not exist')) {
      return null;
    }
    throw err;
  }
}

export async function callViewFunction<T = unknown>(
  rpcUrl: string,
  accountId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const argsBase64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  const res = await rpcCall<{ result: number[] }>(rpcUrl, 'query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: accountId,
    method_name: methodName,
    args_base64: argsBase64,
  });
  const text = Buffer.from(res.result).toString('utf8');
  return JSON.parse(text) as T;
}

export async function hasIntentsPublicKey(
  rpcUrl: string,
  accountId: string,
  publicKey: string,
  intentsContractId = 'intents.near',
): Promise<boolean> {
  try {
    const res = await callViewFunction<boolean>(rpcUrl, intentsContractId, 'has_public_key', {
      account_id: accountId,
      public_key: publicKey,
    });
    return res === true;
  } catch {
    return false;
  }
}

export async function listIntentsPublicKeys(
  rpcUrl: string,
  accountId: string,
  intentsContractId = 'intents.near',
): Promise<string[]> {
  try {
    const res = await callViewFunction<string[]>(rpcUrl, intentsContractId, 'public_keys_of', {
      account_id: accountId,
    });
    return Array.isArray(res) ? res : [];
  } catch (err) {
    const causeName = (err as { causeName?: string }).causeName;
    const msg = err instanceof Error ? err.message : String(err);
    if (causeName === 'UNKNOWN_ACCOUNT' || msg.includes('does not exist')) {
      return [];
    }
    throw err;
  }
}

function getDeployerCredentials(network: 'mainnet' | 'testnet'): {
  signerId: string;
  secretKey32: Buffer;
  pubKey32: Buffer;
  pubKeyB58: string;
} {
  const rawKey =
    network === 'testnet'
      ? required('NEAR_DEPLOYER_TESTNET_PRIVATE_KEY')
      : required('NEAR_DEPLOYER_PRIVATE_KEY');
  const signerId = treasuryFor(network);
  const stripped = rawKey.startsWith('ed25519:') ? rawKey.slice(8) : rawKey;
  const decoded = Buffer.from(base58.decode(stripped));
  const secretKey32 = decoded.subarray(0, 32);
  const pubKey32 =
    decoded.length >= 64
      ? decoded.subarray(32, 64)
      : Buffer.from(ed25519.getPublicKey(secretKey32));
  return {
    signerId,
    secretKey32,
    pubKey32,
    pubKeyB58: base58.encode(pubKey32),
  };
}

const RELAYER_POOL_SIZE = 16;

interface RelayerKeySlot {
  slot: number;
  signerId: string;
  secretKey32: Buffer;
  pubKey32: Buffer;
  pubKeyB58: string;
  queue: Promise<unknown>;
  inFlight: number;
  lastNonce: bigint;
  registered: boolean;
}

const relayerPools: Record<'mainnet' | 'testnet', RelayerKeySlot[] | null> = {
  mainnet: null,
  testnet: null,
};
let relayerRoundRobin: Record<'mainnet' | 'testnet', number> = {
  mainnet: 0,
  testnet: 0,
};

function getRelayerPool(network: 'mainnet' | 'testnet'): RelayerKeySlot[] {
  const existing = relayerPools[network];
  const master = getDeployerCredentials(network);
  if (existing && existing[0]?.signerId === master.signerId && existing[0]?.pubKeyB58 === master.pubKeyB58) {
    return existing;
  }
  const slots: RelayerKeySlot[] = [];
  for (let i = 0; i < RELAYER_POOL_SIZE; i++) {
    if (i === 0) {
      slots.push({
        slot: 0,
        signerId: master.signerId,
        secretKey32: master.secretKey32,
        pubKey32: master.pubKey32,
        pubKeyB58: master.pubKeyB58,
        queue: Promise.resolve(),
        inFlight: 0,
        lastNonce: 0n,
        registered: true,
      });
    } else {
      const derivedSecret = Buffer.from(
        hkdfSync(
          'sha256',
          master.secretKey32,
          Buffer.from(`man0-relayer:${network}:${master.signerId}`, 'utf8'),
          Buffer.from(`slot:${i}`, 'utf8'),
          32,
        ),
      );
      const derivedPub = Buffer.from(ed25519.getPublicKey(derivedSecret));
      slots.push({
        slot: i,
        signerId: master.signerId,
        secretKey32: derivedSecret,
        pubKey32: derivedPub,
        pubKeyB58: base58.encode(derivedPub),
        queue: Promise.resolve(),
        inFlight: 0,
        lastNonce: 0n,
        registered: false,
      });
    }
  }
  relayerPools[network] = slots;
  return slots;
}

function enqueueSlotTx<T>(slotObj: RelayerKeySlot, fn: () => Promise<T>): Promise<T> {
  slotObj.inFlight += 1;
  const next = slotObj.queue.then(fn, fn);
  slotObj.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next.finally(() => {
    slotObj.inFlight = Math.max(0, slotObj.inFlight - 1);
  });
}

function selectRelayerSlot(pool: RelayerKeySlot[], network: 'mainnet' | 'testnet'): RelayerKeySlot {
  const primary = pool[0]!;
  if (primary.inFlight === 0) {
    return primary;
  }
  let best = primary;
  const start = relayerRoundRobin[network] % pool.length;
  relayerRoundRobin[network] = (start + 1) % pool.length;
  for (let offset = 0; offset < pool.length; offset++) {
    const candidate = pool[(start + offset) % pool.length]!;
    if (candidate.inFlight === 0) {
      return candidate;
    }
    if (candidate.inFlight < best.inFlight) {
      best = candidate;
    }
  }
  return best;
}

export interface BroadcastOutcome {
  txHash: string;
  result: unknown;
  logs: string[];
}

function decodeSuccessValue(b64?: string): unknown {
  if (!b64) return undefined;
  const raw = Buffer.from(b64, 'base64').toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function executeSignedBroadcastOnSlot(
  rpcUrl: string,
  slotObj: RelayerKeySlot,
  receiverId: string,
  actions: Uint8Array[],
): Promise<BroadcastOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ak = await rpcCall<{ nonce: number; block_hash: string }>(rpcUrl, 'query', {
      request_type: 'view_access_key',
      finality: 'optimistic',
      account_id: slotObj.signerId,
      public_key: `ed25519:${slotObj.pubKeyB58}`,
    });
    slotObj.registered = true;
    const candidateNonce = BigInt(ak.nonce) + 1n;
    const prevNonce = slotObj.lastNonce;
    const nonce = candidateNonce > prevNonce ? candidateNonce : prevNonce + 1n;
    const blockHash = Buffer.from(base58.decode(ak.block_hash));
    const txBytes = serializeTransaction({
      signerId: slotObj.signerId,
      publicKey: slotObj.pubKey32,
      nonce,
      receiverId,
      blockHash,
      actions,
    });
    const txHashBytes = createHash('sha256').update(txBytes).digest();
    const signature = Buffer.from(ed25519.sign(txHashBytes, slotObj.secretKey32));
    const signedTxBytes = Buffer.concat([txBytes, Buffer.from([0]), signature]);

    try {
      const outcome = await rpcCall<{
        status?: { Failure?: unknown; SuccessValue?: string };
        transaction?: { hash?: string };
        transaction_outcome?: {
          id?: string;
          outcome?: { logs?: string[]; status?: { Failure?: unknown; SuccessValue?: string } };
        };
        receipts_outcome?: Array<{
          outcome?: { logs?: string[]; status?: { Failure?: unknown; SuccessValue?: string } };
        }>;
      }>(rpcUrl, 'broadcast_tx_commit', [signedTxBytes.toString('base64')]);

      slotObj.lastNonce = nonce;

      const txHash =
        outcome.transaction?.hash ||
        outcome.transaction_outcome?.id ||
        base58.encode(txHashBytes);

      if (outcome.status?.Failure || outcome.transaction_outcome?.outcome?.status?.Failure) {
        const failureJson = JSON.stringify(
          outcome.status?.Failure ?? outcome.transaction_outcome?.outcome?.status?.Failure,
        );
        if (failureJson.includes('InvalidNonce') && attempt < 2) {
          slotObj.lastNonce = 0n;
          continue;
        }
        throw Object.assign(
          new Error(`NEAR transaction ${txHash} failed: ${failureJson}`),
          { txHash },
        );
      }
      const logs: string[] = [...(outcome.transaction_outcome?.outcome?.logs ?? [])];
      let latestReceiptSuccess: unknown;
      for (const receipt of outcome.receipts_outcome ?? []) {
        if (receipt.outcome?.logs) {
          logs.push(...receipt.outcome.logs);
        }
        if (receipt.outcome?.status?.Failure) {
          throw Object.assign(
            new Error(
              `NEAR receipt in ${txHash} failed: ${JSON.stringify(receipt.outcome.status.Failure)}`,
            ),
            { txHash },
          );
        }
        const decoded = decodeSuccessValue(receipt.outcome?.status?.SuccessValue);
        if (decoded !== undefined && decoded !== null) {
          latestReceiptSuccess = decoded;
        }
      }
      let result = decodeSuccessValue(outcome.status?.SuccessValue);
      if (result === undefined || result === null) {
        result = latestReceiptSuccess;
      }
      if (result === undefined || result === null) {
        for (const log of logs) {
          if (log.startsWith('EVENT_JSON:')) {
            try {
              const parsedEvent = JSON.parse(log.slice('EVENT_JSON:'.length)) as {
                data?: Record<string, unknown>;
              };
              const eventId =
                parsedEvent.data?.workflow_id ??
                parsedEvent.data?.agent_id ??
                parsedEvent.data?.rfa_id ??
                parsedEvent.data?.lease_id;
              if (eventId !== undefined) {
                result = eventId;
              }
            } catch {
              // ignore non-JSON log
            }
          }
        }
      }
      return { txHash, result, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rpcData = JSON.stringify((err as { rpcError?: unknown }).rpcError ?? '');
      if ((msg.includes('InvalidNonce') || rpcData.includes('InvalidNonce')) && attempt < 2) {
        slotObj.lastNonce = 0n;
        continue;
      }
      throw err;
    }
  }
  throw new Error('NEAR broadcast failed after InvalidNonce retries.');
}

async function ensureRelayerSlotRegistered(
  rpcUrl: string,
  primarySlot: RelayerKeySlot,
  targetSlot: RelayerKeySlot,
): Promise<void> {
  if (targetSlot.registered || targetSlot.slot === 0) return;
  try {
    await rpcCall<{ nonce: number; block_hash: string }>(rpcUrl, 'query', {
      request_type: 'view_access_key',
      finality: 'optimistic',
      account_id: targetSlot.signerId,
      public_key: `ed25519:${targetSlot.pubKeyB58}`,
    });
    targetSlot.registered = true;
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rpcErr = JSON.stringify((err as { rpcError?: unknown }).rpcError ?? '');
    if (
      !msg.includes('UNKNOWN_ACCESS_KEY') &&
      !rpcErr.includes('UNKNOWN_ACCESS_KEY') &&
      !msg.toLowerCase().includes('does not exist')
    ) {
      throw err;
    }
  }
  await enqueueSlotTx(primarySlot, async () => {
    if (targetSlot.registered) return;
    await executeSignedBroadcastOnSlot(rpcUrl, primarySlot, primarySlot.signerId, [
      addFullAccessKeyAction(targetSlot.pubKey32),
    ]);
    targetSlot.registered = true;
  });
}

export async function broadcastActionsWithOutcome(
  rpcUrl: string,
  receiverId: string,
  actions: Uint8Array[],
  explicitNetwork?: 'mainnet' | 'testnet',
): Promise<BroadcastOutcome> {
  const network: 'mainnet' | 'testnet' =
    explicitNetwork ??
    (rpcUrl.includes('testnet') || receiverId.endsWith('.testnet') ? 'testnet' : 'mainnet');
  const pool = getRelayerPool(network);
  const chosenSlot = selectRelayerSlot(pool, network);
  return enqueueSlotTx(chosenSlot, async () => {
    if (!chosenSlot.registered && chosenSlot.slot > 0) {
      await ensureRelayerSlotRegistered(rpcUrl, pool[0]!, chosenSlot);
    }
    return executeSignedBroadcastOnSlot(rpcUrl, chosenSlot, receiverId, actions);
  });
}

export async function broadcastActions(
  rpcUrl: string,
  receiverId: string,
  actions: Uint8Array[],
): Promise<string> {
  const outcome = await broadcastActionsWithOutcome(rpcUrl, receiverId, actions);
  return outcome.txHash;
}

export async function deployWallet(
  userAddress: string,
): Promise<{ userAddress: string; status: string; transaction: string | null }> {
  const [account] = await user`
    SELECT "userAddress", network, state, code, status, transaction
    FROM accounts
    WHERE "userAddress" = ${userAddress}
  `;
  if (!account) {
    throw Object.assign(new Error(`Account ${userAddress} not found.`), { statusCode: 404 });
  }

  const network = (account.network === 'testnet' ? 'testnet' : 'mainnet') as
    | 'mainnet'
    | 'testnet';
  const rpcUrl = rpcFor(network);
  const rawStateInit = Buffer.from(account.state as string, 'base64');
  const expectedKey = extractStateKey(rawStateInit);
  const expectedWalletPublicKey = `p256:${base58.encode(expectedKey)}`;

  let txHash: string | null = (account.transaction as string | null) ?? null;

  try {
    let existing = await viewAccount(rpcUrl, userAddress);

    if (!existing) {
      await user`
        UPDATE accounts
        SET status = 'pending'
        WHERE "userAddress" = ${userAddress} AND status != 'active'
      `;

      const actions: Uint8Array[] = [];
      const [identity] = await user`
        SELECT id FROM identities WHERE "userAddress" = ${userAddress} LIMIT 1
      `;
      const intentsMeta =
        network === 'testnet'
          ? await discoverNearIntentsContracts('testnet').catch(() => null)
          : { verifier: 'intents.near' };

      if (identity?.id && intentsMeta?.verifier) {
        const derivedKey = derive(identity.id as string);
        if (derivedKey.equals(expectedKey)) {
          actions.push(transferAction(5_000_000_000_000_000_000_000n));
          actions.push(universalStateInitAction(rawStateInit, 0n));
          const privKey = derivePrivate(identity.id as string);
          const ownerIntentsKey = intentsPublicKey('p256', expectedKey);
          const msg = buildWalletAddPublicKeyMessage({
            signerId: userAddress,
            networkId: network,
            publicKey: ownerIntentsKey,
            nonce: randomInt(1, 0x100000000),
            intentsContractId: intentsMeta.verifier,
          });
          const proof = signWebAuthnP256(privKey, commitment(msg));
          const execArgs = Buffer.from(
            JSON.stringify({ msg, proof: JSON.stringify(proof) }),
            'utf8',
          );
          actions.push(
            functionCallAction('w_execute_signed', execArgs, 100_000_000_000_000n, 1n),
          );
        } else {
          actions.push(universalStateInitAction(rawStateInit, 0n));
        }
      } else {
        actions.push(universalStateInitAction(rawStateInit, 0n));
      }

      txHash = await broadcastActions(rpcUrl, userAddress, actions);
      await user`
        UPDATE accounts
        SET transaction = ${txHash}
        WHERE "userAddress" = ${userAddress}
      `;
      existing = await viewAccount(rpcUrl, userAddress);
    }

    if (!existing) {
      throw new Error(`Account ${userAddress} is still not visible on-chain after initialization.`);
    }

    const expectedCode = account.code as string;
    const matchesContract =
      existing.global_contract_account_id === expectedCode ||
      existing.global_contract_hash === expectedCode;
    if (!matchesContract) {
      throw new Error(
        `Account ${userAddress} global contract mismatch on-chain (expected ${expectedCode}).`,
      );
    }

    const onChainKey = await callViewFunction<string>(rpcUrl, userAddress, 'w_public_key', {});
    if (onChainKey !== expectedWalletPublicKey) {
      throw new Error(
        `Account ${userAddress} w_public_key mismatch (expected ${expectedWalletPublicKey}, got ${String(onChainKey)}).`,
      );
    }

    await user`
      UPDATE accounts
      SET status = 'active',
          transaction = COALESCE(${txHash}, transaction)
      WHERE "userAddress" = ${userAddress}
    `;
    return { userAddress, status: 'active', transaction: txHash };
  } catch (err) {
    const failedTx = (err as { txHash?: string }).txHash ?? txHash;
    await user`
      UPDATE accounts
      SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'failed' END,
          transaction = COALESCE(${failedTx}, transaction)
      WHERE "userAddress" = ${userAddress}
    `;
    const [updated] = await user`
      SELECT status, transaction FROM accounts WHERE "userAddress" = ${userAddress}
    `;
    return {
      userAddress,
      status: (updated?.status as string) ?? 'failed',
      transaction: (updated?.transaction as string | null) ?? failedTx ?? null,
    };
  }
}

export const activate = deployWallet;

export async function reconcile(
  userAddress: string,
): Promise<{ userAddress: string; status: string }> {
  const [account] = await user`
    SELECT status FROM accounts WHERE "userAddress" = ${userAddress}
  `;
  if (!account) {
    return { userAddress, status: 'ready' };
  }
  const currentStatus = account.status as string;
  if (currentStatus !== 'active') {
    const deployed = await deployWallet(userAddress);
    return {
      userAddress,
      status: deployed.status,
    };
  }
  return {
    userAddress,
    status: currentStatus,
  };
}

export interface Input {
  key: Uint8Array;
  identity?: {
    id: string;
    provider: string;
  };
  credential?: {
    id: string;
    kind: string;
    proof: Record<string, unknown>;
    counter?: number;
  };
}

export async function provision(
  input: Input,
): Promise<{ userAddress: string; status: string }> {
  await ensureAccountColumns();
  const prepared = await prepare(input.key, config.network);
  const spending = prepareSpending(input.key, config.network);
  let userAddress = prepared.account;

  if (input.identity) {
    const [existing] = await user`
      SELECT "userAddress" FROM identities WHERE id = ${input.identity.id}
    `;
    if (existing?.userAddress) {
      userAddress = existing.userAddress as string;
    }
  } else if (input.credential) {
    const [existingCred] = await user`
      SELECT "userAddress" FROM credentials WHERE id = ${input.credential.id}
    `;
    if (existingCred?.userAddress) {
      userAddress = existingCred.userAddress as string;
    }
  }

  await user`
    INSERT INTO users("userAddress", name, image)
    VALUES (${userAddress}, '', null)
    ON CONFLICT ("userAddress") DO NOTHING
  `;

  await user`
    INSERT INTO accounts("userAddress", network, state, code, status, "spendingAddress", "spendingState")
    VALUES (${userAddress}, ${config.network}, ${prepared.state}, ${prepared.code}, 'ready', ${spending.account}, ${spending.state})
    ON CONFLICT ("userAddress") DO UPDATE
    SET "spendingAddress" = COALESCE(accounts."spendingAddress", EXCLUDED."spendingAddress"),
        "spendingState" = COALESCE(accounts."spendingState", EXCLUDED."spendingState")
  `;

  if (input.identity) {
    await user`
      INSERT INTO identities(id, "userAddress", provider)
      VALUES (${input.identity.id}, ${userAddress}, ${input.identity.provider})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  if (input.credential) {
    const proof = JSON.stringify(input.credential.proof);
    await user`
      INSERT INTO credentials(id, "userAddress", kind, proof, counter)
      VALUES (
        ${input.credential.id},
        ${userAddress},
        ${input.credential.kind},
        ${proof}::jsonb,
        ${input.credential.counter ?? 0}
      )
      ON CONFLICT (id) DO UPDATE
      SET proof = EXCLUDED.proof,
          counter = EXCLUDED.counter
    `;
  }

  const [account] = await user`
    SELECT status FROM accounts WHERE "userAddress" = ${userAddress}
  `;
  return {
    userAddress,
    status: (account?.status as string) ?? 'ready',
  };
}

function normalizeExternalAddress(network: 'evm' | 'svm', rawAddress: string): string {
  const trimmed = rawAddress.trim();
  if (network === 'evm') {
    const lower = trimmed.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lower)) {
      throw Object.assign(new Error('Invalid EVM wallet address.'), { statusCode: 400 });
    }
    return lower;
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(trimmed);
  } catch {
    throw Object.assign(new Error('Invalid Solana wallet address.'), { statusCode: 400 });
  }
  if (decoded.length !== 32) {
    throw Object.assign(new Error('Invalid Solana wallet address length.'), { statusCode: 400 });
  }
  return trimmed;
}

export interface LinkedWalletRecord {
  id: string;
  userAddress: string;
  network: 'evm' | 'svm';
  address: string;
  publicKey: string;
  status: 'pending' | 'active' | 'failed';
  transaction: string | null;
}

export async function listLinkedWallets(userAddress: string): Promise<LinkedWalletRecord[]> {
  const rows = await user`
    SELECT id, "userAddress", network, address, "publicKey", status, transaction
    FROM links
    WHERE "userAddress" = ${userAddress}
    ORDER BY created ASC
  `;
  return rows.map(row => ({
    id: row.id as string,
    userAddress: row.userAddress as string,
    network: row.network as 'evm' | 'svm',
    address: row.address as string,
    publicKey: row.publicKey as string,
    status: row.status as 'pending' | 'active' | 'failed',
    transaction: (row.transaction as string | null) ?? null,
  }));
}

export async function attachExternalWallet(
  userAddress: string,
  input: {
    network: 'evm' | 'svm';
    address: string;
  },
): Promise<LinkedWalletRecord> {
  const normalizedAddress = normalizeExternalAddress(input.network, input.address);

  const [existingLink] = await user`
    SELECT id, "userAddress" FROM links
    WHERE network = ${input.network} AND address = ${normalizedAddress}
  `;
  if (existingLink && existingLink.userAddress !== userAddress) {
    throw Object.assign(
      new Error('This external wallet is already linked to another account.'),
      { statusCode: 409 },
    );
  }

  const linkId = (existingLink?.id as string | undefined) ?? randomBytes(16).toString('hex');
  const serializedAuth = JSON.stringify({ mode: 'smart' });
  const [saved] = await user`
    INSERT INTO links(id, "userAddress", network, address, "publicKey", status, "authorization", modified)
    VALUES (
      ${linkId},
      ${userAddress},
      ${input.network},
      ${normalizedAddress},
      ${normalizedAddress},
      'active',
      ${serializedAuth}::jsonb,
      now()
    )
    ON CONFLICT (network, address) DO UPDATE
    SET status = 'active',
        modified = now()
    RETURNING id, "userAddress", network, address, "publicKey", status, transaction
  `;

  return {
    id: saved.id as string,
    userAddress: saved.userAddress as string,
    network: saved.network as 'evm' | 'svm',
    address: saved.address as string,
    publicKey: saved.publicKey as string,
    status: 'active',
    transaction: (saved.transaction as string | null) ?? null,
  };
}

export async function assertAllowedNearContract(
  contractId: string,
): Promise<'mainnet' | 'testnet'> {
  const trimmed = contractId.trim();
  const mainnetUsdc = usdcFor('mainnet');
  const testnetUsdc = usdcFor('testnet');
  const activeIntents = await discoverNearIntentsContracts(config.network).catch(() => null);
  const allowed = new Set<string>([
    config.contracts.factory,
    config.contracts.workflow,
    config.contracts.reputation,
    config.contracts.validation,
    'intents.near',
    mainnetUsdc,
    testnetUsdc,
    ...(activeIntents ? [activeIntents.verifier, ...activeIntents.nearTokenContracts] : []),
  ]);
  if (!allowed.has(trimmed)) {
    throw Object.assign(new Error(`Contract ${trimmed} is not a configured man0 contract.`), {
      statusCode: 400,
    });
  }
  if (trimmed === testnetUsdc) return 'testnet';
  if (
    config.network === 'testnet' &&
    activeIntents &&
    (trimmed === activeIntents.verifier || activeIntents.nearTokenContracts.includes(trimmed))
  ) {
    return 'testnet';
  }
  return trimmed.endsWith('.testnet') ? 'testnet' : 'mainnet';
}

export async function ensureFtStorageDeposit(
  rpcUrl: string,
  ftContract: string,
  accountId: string,
  network: 'mainnet' | 'testnet',
): Promise<void> {
  const existing = await callViewFunction<{ total: string; available: string } | null>(
    rpcUrl,
    ftContract,
    'storage_balance_of',
    { account_id: accountId },
  ).catch(() => null);
  if (existing && existing.total) return;

  const args = Buffer.from(
    JSON.stringify({ account_id: accountId, registration_only: true }),
    'utf8',
  );
  await broadcastActionsWithOutcome(
    rpcUrl,
    ftContract,
    [functionCallAction('storage_deposit', args, 30_000_000_000_000n, 1_250_000_000_000_000_000_000n)],
    network,
  );
}

export async function ensureUsdcStorageDeposit(
  rpcUrl: string,
  accountId: string,
  network: 'mainnet' | 'testnet',
): Promise<void> {
  return ensureFtStorageDeposit(rpcUrl, usdcFor(network), accountId, network);
}

export async function readFtBalanceWei(
  rpcUrl: string,
  ftContract: string,
  accountId: string,
): Promise<string> {
  try {
    const raw = await callViewFunction<string>(rpcUrl, ftContract, 'ft_balance_of', {
      account_id: accountId,
    });
    return typeof raw === 'string' && /^\d+$/.test(raw) ? raw : '0';
  } catch {
    return '0';
  }
}

export async function readUsdcBalanceWei(
  rpcUrl: string,
  accountId: string,
  network: 'mainnet' | 'testnet',
): Promise<string> {
  return readFtBalanceWei(rpcUrl, usdcFor(network), accountId);
}

const derivedAddressToCanonical = new Map<string, string>();
let derivedIndexHydratedFor: 'mainnet' | 'testnet' | null = null;

export async function resolveMainUserAddress(addressOrSpending: string): Promise<string> {
  const trimmed = addressOrSpending.trim();
  if (!trimmed) return trimmed;
  const cachedMain = derivedAddressToCanonical.get(trimmed);
  if (cachedMain) return cachedMain;

  await ensureAccountColumns();
  const [row] = await user`
    SELECT "userAddress"
    FROM accounts
    WHERE "userAddress" = ${trimmed}
       OR "spendingAddress" = ${trimmed}
    LIMIT 1
  `;
  if (row?.userAddress) {
    return row.userAddress as string;
  }

  if (trimmed.startsWith('0u') && derivedIndexHydratedFor !== config.network) {
    const allRows = await user`
      SELECT "userAddress", network, state
      FROM accounts
    `;
    for (const r of allRows) {
      try {
        const canonical = r.userAddress as string;
        const rawInit = Buffer.from(r.state as string, 'base64');
        const ownerKey = extractStateKey(rawInit);
        const mainOnActive = await prepare(ownerKey, config.network);
        const spendOnActive = prepareSpending(ownerKey, config.network);
        derivedAddressToCanonical.set(mainOnActive.account, canonical);
        derivedAddressToCanonical.set(spendOnActive.account, canonical);
      } catch {
        // ignore malformed state rows
      }
    }
    derivedIndexHydratedFor = config.network;
    const afterHydration = derivedAddressToCanonical.get(trimmed);
    if (afterHydration) return afterHydration;
  }

  return trimmed;
}

export interface SpendingRecord {
  userAddress: string;
  accountNetwork: 'mainnet' | 'testnet';
  rpcUrl: string;
  ownerCompressedKey: Buffer;
  rawMainInit: Buffer;
  spendingAddress: string;
  rawSpendingInit: Buffer;
  activeMainAddress: string;
  rawActiveMainInit: Buffer;
  activeSpendingAddress: string;
  rawActiveSpendingInit: Buffer;
  seedId: string;
}

export async function ensureSpendingRecord(userAddress: string): Promise<SpendingRecord> {
  await ensureAccountColumns();
  const [account] = await user`
    SELECT "userAddress", network, state, code, "spendingAddress", "spendingState"
    FROM accounts
    WHERE "userAddress" = ${userAddress}
  `;
  if (!account) {
    throw Object.assign(new Error(`Universal account ${userAddress} not found.`), {
      statusCode: 404,
    });
  }
  const [identity] = await user`
    SELECT id FROM identities WHERE "userAddress" = ${userAddress} LIMIT 1
  `;
  if (!identity?.id) {
    throw Object.assign(new Error(`Smart account identity not found for ${userAddress}.`), {
      statusCode: 401,
    });
  }
  const seedId = identity.id as string;
  const accountNetwork = (account.network === 'testnet' ? 'testnet' : 'mainnet') as
    | 'mainnet'
    | 'testnet';
  const rpcUrl = rpcFor(accountNetwork);
  const rawMainInit = Buffer.from(account.state as string, 'base64');
  const ownerCompressedKey = extractStateKey(rawMainInit);
  const computed = prepareSpending(ownerCompressedKey, accountNetwork);

  if (!account.spendingAddress || !account.spendingState) {
    await user`
      UPDATE accounts
      SET "spendingAddress" = COALESCE("spendingAddress", ${computed.account}),
          "spendingState" = COALESCE("spendingState", ${computed.state})
      WHERE "userAddress" = ${userAddress}
    `;
  }

  const persistedSpendingAddress = (account.spendingAddress as string | null) ?? computed.account;
  const persistedSpendingState = (account.spendingState as string | null) ?? computed.state;

  const activeMainPrepared =
    accountNetwork === config.network
      ? { account: userAddress, state: account.state as string }
      : await prepare(ownerCompressedKey, config.network);
  const activeSpendingPrepared =
    accountNetwork === config.network
      ? { account: persistedSpendingAddress, state: persistedSpendingState }
      : prepareSpending(ownerCompressedKey, config.network);

  derivedAddressToCanonical.set(activeMainPrepared.account, userAddress);
  derivedAddressToCanonical.set(activeSpendingPrepared.account, userAddress);

  return {
    userAddress,
    accountNetwork,
    rpcUrl,
    ownerCompressedKey,
    rawMainInit,
    spendingAddress: persistedSpendingAddress,
    rawSpendingInit: Buffer.from(persistedSpendingState, 'base64'),
    activeMainAddress: activeMainPrepared.account,
    rawActiveMainInit: Buffer.from(activeMainPrepared.state, 'base64'),
    activeSpendingAddress: activeSpendingPrepared.account,
    rawActiveSpendingInit: Buffer.from(activeSpendingPrepared.state, 'base64'),
    seedId,
  };
}

interface ActiveAccountBalances {
  mainWei: bigint;
  spendingWei: bigint;
  settlementUsdc: string;
}

async function readActiveAccountBalances(rec: SpendingRecord): Promise<ActiveAccountBalances> {
  const activeNet = config.network;
  const activeRpc = rpcFor(activeNet);
  const settlementUsdc = usdcFor(activeNet);

  const [mainStr, spendingStr] = await Promise.all([
    readFtBalanceWei(activeRpc, settlementUsdc, rec.activeMainAddress),
    readFtBalanceWei(activeRpc, settlementUsdc, rec.activeSpendingAddress),
  ]);

  return {
    mainWei: BigInt(mainStr),
    spendingWei: BigInt(spendingStr),
    settlementUsdc,
  };
}

export function nearBalanceCacheKey(userAddress: string): string {
  return `near:bal:${config.network}:${userAddress.trim().toLowerCase()}`;
}

export async function invalidateNearBalanceCache(userAddress: string): Promise<void> {
  await cacheDel(nearBalanceCacheKey(userAddress));
}

export async function getNearBalances(userAddress: string): Promise<{
  userAddress: string;
  depositAddress: string;
  spendingAddress: string;
  mainBalanceWei: string;
  spendingBalanceWei: string;
  network: 'mainnet' | 'testnet';
}> {
  return cached(nearBalanceCacheKey(userAddress), 4, 2_500, async () => {
    const rec = await ensureSpendingRecord(userAddress);
    const balances = await readActiveAccountBalances(rec);
    return {
      userAddress: rec.userAddress,
      depositAddress: rec.activeMainAddress,
      spendingAddress: rec.activeSpendingAddress,
      mainBalanceWei: balances.mainWei.toString(),
      spendingBalanceWei: balances.spendingWei.toString(),
      network: config.network,
    };
  });
}

export async function ensureDepositReady(userAddress: string): Promise<{
  userAddress: string;
  depositAddress: string;
  spendingAddress: string;
  network: 'mainnet' | 'testnet';
  status: string;
}> {
  const rec = await ensureSpendingRecord(userAddress);
  const activeNet = config.network;
  const activeRpc = rpcFor(activeNet);
  const intentsMeta = await discoverNearIntentsContracts(activeNet).catch(() => null);

  let status = 'active';
  if (rec.accountNetwork === activeNet) {
    const deployed = await deployWallet(userAddress);
    status = deployed.status;
  } else {
    const existing = await viewAccount(activeRpc, rec.activeMainAddress);
    if (!existing) {
      const actions: Uint8Array[] = [
        transferAction(12_000_000_000_000_000_000_000n),
        universalStateInitAction(rec.rawActiveMainInit, 0n),
      ];
      if (intentsMeta?.verifier && derive(rec.seedId).equals(rec.ownerCompressedKey)) {
        const privKey = derivePrivate(rec.seedId);
        const ownerIntentsKey = intentsPublicKey('p256', rec.ownerCompressedKey);
        const msg = buildWalletAddPublicKeyMessage({
          signerId: rec.activeMainAddress,
          networkId: activeNet,
          publicKey: ownerIntentsKey,
          nonce: randomInt(1, 0x100000000),
          intentsContractId: intentsMeta.verifier,
        });
        const proof = signWebAuthnP256(privKey, commitment(msg));
        const execArgs = Buffer.from(
          JSON.stringify({ msg, proof: JSON.stringify(proof) }),
          'utf8',
        );
        actions.push(functionCallAction('w_execute_signed', execArgs, 100_000_000_000_000n, 1n));
      }
      await broadcastActionsWithOutcome(activeRpc, rec.activeMainAddress, actions, activeNet);
    } else if (BigInt(existing.amount) < 5_000_000_000_000_000_000_000n) {
      await broadcastActionsWithOutcome(
        activeRpc,
        rec.activeMainAddress,
        [transferAction(12_000_000_000_000_000_000_000n)],
        activeNet,
      );
    }
  }

  if (intentsMeta?.verifier && derive(rec.seedId).equals(rec.ownerCompressedKey)) {
    const ownerIntentsKey = intentsPublicKey('p256', rec.ownerCompressedKey);
    const hasKey = await hasIntentsPublicKey(
      activeRpc,
      rec.activeMainAddress,
      ownerIntentsKey,
      intentsMeta.verifier,
    );
    if (!hasKey) {
      const existing = await viewAccount(activeRpc, rec.activeMainAddress);
      const actions: Uint8Array[] = [];
      if (existing && BigInt(existing.amount) < 5_000_000_000_000_000_000_000n) {
        actions.push(transferAction(12_000_000_000_000_000_000_000n));
      }
      const privKey = derivePrivate(rec.seedId);
      const msg = buildWalletAddPublicKeyMessage({
        signerId: rec.activeMainAddress,
        networkId: activeNet,
        publicKey: ownerIntentsKey,
        nonce: randomInt(1, 0x100000000),
        intentsContractId: intentsMeta.verifier,
      });
      const proof = signWebAuthnP256(privKey, commitment(msg));
      const execArgs = Buffer.from(JSON.stringify({ msg, proof: JSON.stringify(proof) }), 'utf8');
      actions.push(functionCallAction('w_execute_signed', execArgs, 100_000_000_000_000n, 1n));
      await broadcastActionsWithOutcome(activeRpc, rec.activeMainAddress, actions, activeNet).catch(
        () => undefined,
      );
    }
  }

  await ensureFtStorageDeposit(activeRpc, usdcFor(activeNet), rec.activeMainAddress, activeNet);
  if (intentsMeta?.intentsUsdcContract && intentsMeta.intentsUsdcContract !== usdcFor(activeNet)) {
    await ensureFtStorageDeposit(
      activeRpc,
      intentsMeta.intentsUsdcContract,
      rec.activeMainAddress,
      activeNet,
    );
  }

  await invalidateNearBalanceCache(userAddress);
  return {
    userAddress: rec.userAddress,
    depositAddress: rec.activeMainAddress,
    spendingAddress: rec.activeSpendingAddress,
    network: activeNet,
    status,
  };
}

export async function approveSpendingLimit(
  userAddress: string,
  input: {
    amountWei: string;
  },
): Promise<{
  txHash: string;
  userAddress: string;
  depositAddress: string;
  spendingAddress: string;
  mainBalanceWei: string;
  spendingBalanceWei: string;
  network: 'mainnet' | 'testnet';
}> {
  const delta = BigInt(input.amountWei);
  if (delta <= 0n) {
    throw Object.assign(new Error('Enter an amount greater than $0.00.'), { statusCode: 400 });
  }
  const rec = await ensureSpendingRecord(userAddress);
  const activeNet = config.network;
  const activeRpc = rpcFor(activeNet);
  const balances = await readActiveAccountBalances(rec);
  if (balances.mainWei < delta) {
    const availUsd = (Number(balances.mainWei) / 1_000_000).toFixed(2);
    const reqUsd = (Number(delta) / 1_000_000).toFixed(2);
    throw Object.assign(
      new Error(
        `Insufficient available balance ($${availUsd} available, $${reqUsd} requested).`,
      ),
      { statusCode: 400 },
    );
  }

  if (!derive(rec.seedId).equals(rec.ownerCompressedKey)) {
    throw Object.assign(new Error('Account authorization mismatch.'), { statusCode: 401 });
  }

  const nearMain = rec.activeMainAddress;
  const nearMainInit = rec.rawActiveMainInit;
  const nearSpending = rec.activeSpendingAddress;
  const nearSpendingInit = rec.rawActiveSpendingInit;

  const existingSpending = await viewAccount(activeRpc, nearSpending);
  if (!existingSpending) {
    await broadcastActionsWithOutcome(
      activeRpc,
      nearSpending,
      [
        transferAction(15_000_000_000_000_000_000_000n),
        universalStateInitAction(nearSpendingInit, 0n),
      ],
      activeNet,
    );
  } else if (BigInt(existingSpending.amount) < 5_000_000_000_000_000_000_000n) {
    await broadcastActionsWithOutcome(
      activeRpc,
      nearSpending,
      [transferAction(12_000_000_000_000_000_000n)],
      activeNet,
    );
  }

  await ensureFtStorageDeposit(activeRpc, balances.settlementUsdc, nearSpending, activeNet);

  const privKey = derivePrivate(rec.seedId);
  const msg = buildWalletContractCallMessage({
    signerId: nearMain,
    networkId: activeNet,
    receiverId: balances.settlementUsdc,
    methodName: 'ft_transfer',
    args: {
      receiver_id: nearSpending,
      amount: delta.toString(),
    },
    deposit: '1',
    gas: 50_000_000_000_000,
    nonce: randomInt(1, 0x100000000),
  });
  const proof = signWebAuthnP256(privKey, commitment(msg));

  const existingMain = await viewAccount(activeRpc, nearMain);
  const mainActions: Uint8Array[] = [];
  if (!existingMain) {
    mainActions.push(transferAction(12_000_000_000_000_000_000_000n));
    mainActions.push(universalStateInitAction(nearMainInit, 0n));
  } else if (BigInt(existingMain.amount) < 5_000_000_000_000_000_000_000n) {
    mainActions.push(transferAction(12_000_000_000_000_000_000_000n));
  }
  const execArgs = Buffer.from(
    JSON.stringify({ msg, proof: JSON.stringify(proof) }),
    'utf8',
  );
  mainActions.push(functionCallAction('w_execute_signed', execArgs, 200_000_000_000_000n, 1n));
  const outcome = await broadcastActionsWithOutcome(activeRpc, nearMain, mainActions, activeNet);

  await invalidateNearBalanceCache(userAddress);
  const updated = await readActiveAccountBalances(rec);
  return {
    txHash: outcome.txHash,
    userAddress: rec.userAddress,
    depositAddress: nearMain,
    spendingAddress: nearSpending,
    mainBalanceWei: updated.mainWei.toString(),
    spendingBalanceWei: updated.spendingWei.toString(),
    network: activeNet,
  };
}

export async function reclaimSpendingLimit(
  userAddress: string,
  input: {
    amountWei?: string;
  } = {},
): Promise<{
  txHash: string;
  userAddress: string;
  depositAddress: string;
  spendingAddress: string;
  mainBalanceWei: string;
  spendingBalanceWei: string;
  network: 'mainnet' | 'testnet';
}> {
  const rec = await ensureSpendingRecord(userAddress);
  const activeNet = config.network;
  const activeRpc = rpcFor(activeNet);
  const balances = await readActiveAccountBalances(rec);
  const currentSpendingWei = balances.spendingWei.toString();
  const reclaimWei = input.amountWei ?? currentSpendingWei;
  if (BigInt(reclaimWei) <= 0n || balances.spendingWei < BigInt(reclaimWei)) {
    throw Object.assign(new Error('There are no unused approved funds to return.'), {
      statusCode: 400,
    });
  }

  if (!derive(rec.seedId).equals(rec.ownerCompressedKey)) {
    throw Object.assign(new Error('Account authorization mismatch.'), { statusCode: 401 });
  }

  const nearMain = rec.activeMainAddress;
  const nearSpending = rec.activeSpendingAddress;
  const privKey = derivePrivate(rec.seedId);

  const msg = buildWalletContractCallMessage({
    signerId: nearSpending,
    networkId: activeNet,
    receiverId: balances.settlementUsdc,
    methodName: 'ft_transfer',
    args: {
      receiver_id: nearMain,
      amount: reclaimWei,
    },
    deposit: '1',
    gas: 50_000_000_000_000,
    nonce: randomInt(1, 0x100000000),
  });
  const proof = signWebAuthnP256(privKey, commitment(msg));

  const existingMain = await viewAccount(activeRpc, nearMain);
  if (!existingMain) {
    await broadcastActionsWithOutcome(
      activeRpc,
      nearMain,
      [
        transferAction(12_000_000_000_000_000_000_000n),
        universalStateInitAction(rec.rawActiveMainInit, 0n),
      ],
      activeNet,
    );
  } else if (BigInt(existingMain.amount) < 5_000_000_000_000_000_000n) {
    await broadcastActionsWithOutcome(
      activeRpc,
      nearMain,
      [transferAction(12_000_000_000_000_000_000n)],
      activeNet,
    );
  }
  await ensureFtStorageDeposit(activeRpc, balances.settlementUsdc, nearMain, activeNet);

  const existingSpending = await viewAccount(activeRpc, nearSpending);
  const spendingActions: Uint8Array[] = [];
  if (existingSpending && BigInt(existingSpending.amount) < 5_000_000_000_000_000_000n) {
    spendingActions.push(transferAction(12_000_000_000_000_000_000n));
  }
  const execArgs = Buffer.from(JSON.stringify({ msg, proof: JSON.stringify(proof) }), 'utf8');
  spendingActions.push(functionCallAction('w_execute_signed', execArgs, 200_000_000_000_000n, 1n));
  const outcome = await broadcastActionsWithOutcome(
    activeRpc,
    nearSpending,
    spendingActions,
    activeNet,
  );

  await invalidateNearBalanceCache(userAddress);
  const updated = await readActiveAccountBalances(rec);
  return {
    txHash: outcome.txHash,
    userAddress: rec.userAddress,
    depositAddress: nearMain,
    spendingAddress: nearSpending,
    mainBalanceWei: updated.mainWei.toString(),
    spendingBalanceWei: updated.spendingWei.toString(),
    network: activeNet,
  };
}

export async function resolveUserAddressOnNetwork(
  userAddress: string,
  targetNetwork: 'mainnet' | 'testnet',
): Promise<{
  signerId: string;
  ownerCompressedKey: Buffer;
  rawStateInit: Buffer;
  network: 'mainnet' | 'testnet';
  seedId: string | null;
}> {
  const [account] = await user`
    SELECT "userAddress", network, state, code
    FROM accounts
    WHERE "userAddress" = ${userAddress}
  `;
  if (!account) {
    throw Object.assign(new Error(`Universal account ${userAddress} not found.`), {
      statusCode: 404,
    });
  }
  const [identity] = await user`
    SELECT id FROM identities WHERE "userAddress" = ${userAddress} LIMIT 1
  `;
  const identityId = (identity?.id as string | undefined) ?? null;
  const accountStateInit = Buffer.from(account.state as string, 'base64');
  const ownerCompressedKey = extractStateKey(accountStateInit);
  const accountNetwork = (account.network === 'testnet' ? 'testnet' : 'mainnet') as
    | 'mainnet'
    | 'testnet';

  if (accountNetwork === targetNetwork) {
    return {
      signerId: userAddress,
      ownerCompressedKey,
      rawStateInit: accountStateInit,
      network: targetNetwork,
      seedId: identityId,
    };
  }

  const targetOwnerCompressedKey = identityId ? derive(identityId) : ownerCompressedKey;
  const preparedOnTarget = await prepare(targetOwnerCompressedKey, targetNetwork);
  return {
    signerId: preparedOnTarget.account,
    ownerCompressedKey: targetOwnerCompressedKey,
    rawStateInit: Buffer.from(preparedOnTarget.state, 'base64'),
    network: targetNetwork,
    seedId: identityId,
  };
}

export async function viewNearContract<T = unknown>(input: {
  contractId: string;
  methodName: string;
  args?: Record<string, unknown>;
}): Promise<T> {
  const targetNetwork = await assertAllowedNearContract(input.contractId);
  const rpcUrl = rpcFor(targetNetwork);
  return callViewFunction<T>(rpcUrl, input.contractId.trim(), input.methodName, input.args ?? {});
}

export async function executeContractCall(
  userAddress: string,
  input: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    deposit?: string;
    gas?: number;
  },
): Promise<{
  txHash: string;
  signerId: string;
  network: 'mainnet' | 'testnet';
  result: unknown;
  logs: string[];
}> {
  const targetNetwork = await assertAllowedNearContract(input.contractId);
  const rpcUrl = rpcFor(targetNetwork);
  const resolved = await resolveUserAddressOnNetwork(userAddress, targetNetwork);

  if (!resolved.seedId) {
    throw Object.assign(
      new Error('Smart account identity is required to execute this contract call.'),
      { statusCode: 401 },
    );
  }
  const derivedPub = derive(resolved.seedId);
  if (!derivedPub.equals(resolved.ownerCompressedKey)) {
    throw Object.assign(
      new Error('Identity key does not match universal account owner key.'),
      { statusCode: 401 },
    );
  }

  const privKey = derivePrivate(resolved.seedId);
  const msg = buildWalletContractCallMessage({
    signerId: resolved.signerId,
    networkId: targetNetwork,
    receiverId: input.contractId.trim(),
    methodName: input.methodName,
    args: input.args,
    deposit: input.deposit ?? '0',
    gas: input.gas ?? 100_000_000_000_000,
    nonce: randomInt(1, 0x100000000),
  });
  const proof = signWebAuthnP256(privKey, commitment(msg));

  if (
    input.methodName === 'ft_transfer' &&
    typeof input.args.receiver_id === 'string' &&
    input.args.receiver_id.trim()
  ) {
    await ensureFtStorageDeposit(
      rpcUrl,
      input.contractId.trim(),
      input.args.receiver_id.trim(),
      targetNetwork,
    );
  }

  const actions: Uint8Array[] = [];
  const existing = await viewAccount(rpcUrl, resolved.signerId);
  if (!existing) {
    actions.push(transferAction(12_000_000_000_000_000_000_000n));
    actions.push(universalStateInitAction(resolved.rawStateInit, 0n));
  } else if (BigInt(existing.amount) < 5_000_000_000_000_000_000_000n) {
    actions.push(transferAction(12_000_000_000_000_000_000_000n));
  }

  const externalDeposit = BigInt(
    msg.request.external?.[0]?.actions?.[0]?.payload?.deposit ?? input.deposit ?? '0',
  );
  const execArgs = Buffer.from(
    JSON.stringify({
      msg,
      proof: JSON.stringify(proof),
    }),
    'utf8',
  );
  actions.push(
    functionCallAction('w_execute_signed', execArgs, 200_000_000_000_000n, externalDeposit),
  );

  const outcome = await broadcastActionsWithOutcome(
    rpcUrl,
    resolved.signerId,
    actions,
    targetNetwork,
  );

  return {
    txHash: outcome.txHash,
    signerId: resolved.signerId,
    network: targetNetwork,
    result: outcome.result,
    logs: outcome.logs,
  };
}

export function deriveAgentWallet(
  identitySeed: string,
  timestamp: number,
  targetNetwork: 'mainnet' | 'testnet' = config.network,
): string {
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(timestamp));
  const seed = createHash('sha256')
    .update(identitySeed.trim(), 'utf8')
    .update(tsBuf)
    .update(':agent:wallet', 'utf8')
    .digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(seed);
  const publicKey = Buffer.from(ecdh.getPublicKey(null, 'compressed'));
  return address(initialization(codeFor(targetNetwork), state(publicKey)));
}
