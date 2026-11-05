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
