import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse1cs, stringify1cs, type OneCsAsset } from '@defuse-protocol/crosschain-assetid';
import type { IntentsSDK as IntentsSDKType } from '@defuse-protocol/intents-sdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

const requireCjs = createRequire(import.meta.url);
const { Chains, IntentsSDK } = requireCjs('@defuse-protocol/intents-sdk') as typeof import('@defuse-protocol/intents-sdk');
import {
  ApiError,
  GenerateSwapTransferIntentRequest,
  IntentStandardEnum,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  SubmitSwapTransferIntentRequest,
  type GetExecutionStatusResponse,
  type MultiPayload,
  type SubmitDepositTxResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { config, rpcFor, treasuryFor, usdcFor } from './config.js';
import {
  callViewFunction,
  derive,
  derivePrivate,
  discoverNearIntentsContracts,
  ensureDepositReady,
  ensureSpendingRecord,
  listLinkedWallets,
  oneClickBaseUrl,
  readFtBalanceWei,
} from './auth/account.js';
import {
  intentsPublicKey,
  signWebAuthnP256,
} from './auth/protocol.js';
import { cached, cacheGet, cacheSet } from './databases/cache.js';

export const NO_FUNDED_WALLET_CODE = 'NO_FUNDED_WALLET';
export const NO_FUNDED_WALLET_MESSAGE =
  "You didn't connect any funded wallet. Connect an external wallet to fund your Session";

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CHAINLIST_REGISTRY_URL = 'https://chainid.network/chains.json';
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SOLANA_ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOLANA_MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDG', 'USDE', 'FRAX', 'PYUSD']);

const intentsSdk = new IntentsSDK({ referral: 'man0' });

const CAIP2_TO_CHAIN_NAME = new Map<string, string>(
  Object.entries(Chains as Record<string, string>).map(([name, caip2]) => [caip2, name]),
);

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
  crossChainAsset?: OneCsAsset;
}

export interface OneClickQuotePayload {
  timestamp?: string;
  signature?: string;
  quote: {
    depositAddress?: string;
    depositMemo?: string | null;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    deadline?: string;
    timeWhenInactive?: string;
    timeEstimate?: number;
  };
}

export interface ConnectedWalletInput {
  network: 'evm' | 'svm' | 'near';
  address: string;
}

export interface WalletHolding {
  source: 'intents' | 'account' | 'external';
  walletNetwork: 'evm' | 'svm' | 'near';
  walletAddress: string;
  intentsAccountId?: string;
  token: OneClickToken;
  chainLabel: string;
  hexChainId?: string;
  originExplorerUrl?: string;
  balanceAtomic: string;
  balanceFormatted: number;
  balanceUsd: number;
  hasNativeGas?: boolean;
}

export interface ResolvedIntentLeg {
  source: 'intents' | 'account' | 'external';
  depositType: 'INTENTS' | 'ORIGIN_CHAIN';
  originToken: OneClickToken;
  originChainLabel: string;
  originWalletNetwork: 'evm' | 'svm' | 'near';
  originWalletAddress: string;
  intentsAccountId?: string;
  hexChainId?: string;
  originExplorerUrl?: string;
  destinationToken: OneClickToken;
  destinationChainLabel: string;
  recipientAddress: string;
  amountAtomic: string;
  displayAmount: string;
  quote: OneClickQuotePayload['quote'];
}

export interface ResolvedIntentRoute {
  action: 'deposit' | 'swap' | 'withdraw';
  depositType: 'INTENTS' | 'ORIGIN_CHAIN';
  originToken: OneClickToken;
  originChainLabel: string;
  originWalletNetwork: 'evm' | 'svm' | 'near';
  originWalletAddress: string;
  intentsAccountId?: string;
  hexChainId?: string;
  destinationToken: OneClickToken;
  destinationChainLabel: string;
  recipientAddress: string;
  amountAtomic: string;
  displayAmount: string;
  quote: OneClickQuotePayload['quote'];
  legs: ResolvedIntentLeg[];
  totalOutFormatted: string;
  totalOutUsd: string;
}

interface ChainListRegistryItem {
  name: string;
  chain?: string;
  shortName?: string;
  chainId: number;
  status?: string;
  rpc?: string[];
  explorers?: Array<{ url?: string }>;
}

interface BridgeHealthChain {
  name?: string;
  chainId?: number;
  cluster?: string;
  network?: string;
  payoutCapSol?: string;
  swapCapSui?: string;
  swapCapBtc?: string;
  minBtc?: string;
}

interface DynamicChainMeta {
  blockchain: string;
  caip2?: string;
  label: string;
  walletFamily: 'evm' | 'svm' | 'near' | null;
  evmChainId?: number;
  hexChainId?: string;
  explorerUrl?: string;
  rpcUrls: string[];
  keywords: string[];
  maxSwapCapDecimal?: number;
}

const latestChainCatalogByKey = new Map<string, DynamicChainMeta>();

function configureOneClickBase(network: 'mainnet' | 'testnet' = config.network): string {
  const base = oneClickBaseUrl(network);
  OpenAPI.BASE = base;
  return base;
}

function humanizeChainKey(raw: string): string {
  const spaced = raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  if (!spaced) return raw;
  if (spaced.length <= 3) return spaced.toUpperCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function normalizeCrossChainAsset(token: {
  assetId: string;
  blockchain: string;
  contractAddress?: string;
}): OneCsAsset | undefined {
  if (token.assetId.startsWith('1cs_v1:')) {
    try {
      return parse1cs(token.assetId);
    } catch {
      return undefined;
    }
  }
  try {
    const namespace = token.contractAddress ? 'token' : 'native';
    const reference = token.contractAddress || token.blockchain;
    const encoded = stringify1cs({
      version: 'v1',
      chain: token.blockchain.toLowerCase(),
      namespace,
      reference,
    });
    return parse1cs(encoded);
  } catch {
    return undefined;
  }
}

function tryParseIntentsAsset(assetId: string): { blockchain?: string } | null {
  try {
    const parsed = (
      intentsSdk as unknown as { parseAssetId: (id: string) => { blockchain?: string } }
    ).parseAssetId(assetId);
    return parsed ?? null;
  } catch {
    return null;
  }
}

async function fetchChainListRegistry(): Promise<ChainListRegistryItem[]> {
  return cached<ChainListRegistryItem[]>('evm:chainid-registry:v1', 3600, async () => {
    const res = await fetch(CHAINLIST_REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) return [];
    const data = (await res.json().catch(() => [])) as ChainListRegistryItem[];
    return Array.isArray(data) ? data : [];
  });
}

async function fetchBridgeHealthChains(
  network: 'mainnet' | 'testnet' = config.network,
): Promise<Record<string, BridgeHealthChain>> {
  const baseUrl = oneClickBaseUrl(network);
  const cacheKey = `oneclick:health-bridges:v2:${network}:${baseUrl}`;
  const hit = await cacheGet<Record<string, BridgeHealthChain>>(cacheKey);
  if (hit !== undefined) {
    return hit;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${baseUrl}/v0/health`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.status === 404) {
      await cacheSet(cacheKey, {}, 3600);
      return {};
    }
    if (!res?.ok) continue;
    const json = (await res.json().catch(() => null)) as {
      bridges?: { chains?: Record<string, BridgeHealthChain> };
    } | null;
    const chains = json?.bridges?.chains ?? {};
    if (Object.keys(chains).length > 0) {
      await cacheSet(cacheKey, chains, 300);
      return chains;
    }
    if (json && !json.bridges) {
      await cacheSet(cacheKey, {}, 900);
      return {};
    }
  }
  return {};
}

function rankPublicHttpsRpcs(rpcs: string[] | undefined): string[] {
  if (!Array.isArray(rpcs)) return [];
  const valid = rpcs.filter(
    u =>
      typeof u === 'string' &&
      u.startsWith('https://') &&
      !u.includes('${') &&
      !u.includes('{') &&
      !u.toUpperCase().includes('API_KEY') &&
      !u.includes('infura.io/v3/') &&
      !u.includes('alchemy.com/v2/'),
  );
  const score = (u: string): number => {
    const lower = u.toLowerCase();
    if (lower.includes('publicnode.com')) return 0;
    if (
      lower.includes('mainnet.base.org') ||
      lower.includes('sepolia.base.org') ||
      lower.includes('arbitrum.io/rpc') ||
      lower.includes('mainnet.optimism.io') ||
      lower.includes('rpc.sepolia.org') ||
      lower.includes('bnbchain.org') ||
      lower.includes('rpc.berachain.com') ||
      lower.includes('rpc.scroll.io') ||
      lower.includes('abs.xyz') ||
      lower.includes('monad.xyz') ||
      lower.includes('aurora.dev')
    ) {
      return 1;
    }
    if (lower.includes('drpc.org') || lower.includes('llamarpc.com')) return 2;
    return 3;
  };
  return [...new Set(valid)].sort((a, b) => score(a) - score(b)).slice(0, 3);
}

function extractChainKeywords(
  blockchain: string,
  ...names: Array<string | undefined>
): string[] {
  const stopWords = new Set([
    'mainnet',
    'testnet',
    'testnet4',
    'sepolia',
    'devnet',
    'chain',
    'network',
    'one',
    'smart',
    'ledger',
    'evm',
    'rollup',
    'c',
  ]);
  const set = new Set<string>([blockchain.toLowerCase()]);
  for (const name of names) {
    if (!name) continue;
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compact.length >= 2 && !stopWords.has(compact)) {
      set.add(compact);
    }
    const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const w of words) {
      if (w.length >= 2 && !stopWords.has(w)) {
        set.add(w);
      }
    }
  }
  return [...set];
}

export async function discoverDynamicChains(
  tokens: OneClickToken[],
  network: 'mainnet' | 'testnet' = config.network,
): Promise<Map<string, DynamicChainMeta>> {
  const [registry, bridgeChains] = await Promise.all([
    fetchChainListRegistry(),
    fetchBridgeHealthChains(network),
  ]);
  const byChainId = new Map<number, ChainListRegistryItem>();
  for (const item of registry) {
    if (typeof item?.chainId === 'number') {
      byChainId.set(item.chainId, item);
    }
  }

  const grouped = new Map<string, OneClickToken[]>();
  for (const t of tokens) {
    const key = t.blockchain.toLowerCase();
    const list = grouped.get(key);
    if (list) list.push(t);
    else grouped.set(key, [t]);
  }

  const out = new Map<string, DynamicChainMeta>();

  for (const [key, chainTokens] of grouped) {
    const bridge = bridgeChains[key];
    let caip2: string | undefined;
    for (const tok of chainTokens) {
      const parsed = tryParseIntentsAsset(tok.assetId);
      if (parsed?.blockchain && (key === 'near' || parsed.blockchain !== 'near:mainnet')) {
        caip2 = parsed.blockchain;
        break;
      }
    }
    const sdkChainName = caip2 ? CAIP2_TO_CHAIN_NAME.get(caip2) : undefined;

    if (key === 'near') {
      const label = network === 'testnet' ? 'NEAR Testnet' : 'NEAR';
      const meta: DynamicChainMeta = {
        blockchain: key,
        caip2: `near:${network}`,
        label,
        walletFamily: 'near',
        explorerUrl: network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io',
        rpcUrls: [rpcFor(network)],
        keywords: extractChainKeywords(key, label, sdkChainName),
      };
      out.set(key, meta);
      latestChainCatalogByKey.set(key, meta);
      continue;
    }

    if (key === 'sol' || caip2?.startsWith('solana:') || bridge?.cluster) {
      const isDevnet = bridge?.cluster === 'devnet' || (network === 'testnet' && key === 'sol');
      const customSolRpc = process.env.SOLANA_RPC_URL?.trim();
      const rpcUrls = customSolRpc
        ? [customSolRpc]
        : isDevnet
          ? ['https://api.devnet.solana.com']
          : ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
      const label =
        bridge?.name || (sdkChainName ? humanizeChainKey(sdkChainName) : humanizeChainKey(key));
      const capSol = bridge?.payoutCapSol ? Number(bridge.payoutCapSol) : undefined;
      const meta: DynamicChainMeta = {
        blockchain: key,
        caip2,
        label,
        walletFamily: key === 'sol' ? 'svm' : null,
        explorerUrl: isDevnet ? 'https://explorer.solana.com?cluster=devnet' : 'https://explorer.solana.com',
        rpcUrls,
        keywords: extractChainKeywords(key, label, sdkChainName),
        ...(capSol && Number.isFinite(capSol) && capSol > 0 ? { maxSwapCapDecimal: capSol } : {}),
      };
      out.set(key, meta);
      latestChainCatalogByKey.set(key, meta);
      continue;
    }

    let evmChainId =
      typeof bridge?.chainId === 'number'
        ? bridge.chainId
        : caip2?.startsWith('eip155:')
          ? Number(caip2.slice(7))
          : undefined;

    let regItem = evmChainId ? byChainId.get(evmChainId) : undefined;
    if (
      network === 'mainnet' &&
      regItem &&
      (regItem.status === 'deprecated' || /testnet|artio|sepolia/i.test(regItem.name))
    ) {
      const activeReplacement = registry.find(
        item =>
          item.status !== 'deprecated' &&
          !/testnet|artio|sepolia|devnet/i.test(item.name) &&
          (item.shortName?.toLowerCase() === key ||
            item.name.toLowerCase() === (sdkChainName ?? key).toLowerCase() ||
            item.chain?.toLowerCase() === (sdkChainName ?? key).toLowerCase()),
      );
      if (activeReplacement) {
        evmChainId = activeReplacement.chainId;
        regItem = activeReplacement;
      }
    }

    if (!evmChainId) {
      const hasEvmAddresses = chainTokens.some(
        t => t.contractAddress && /^0x[0-9a-fA-F]{40}$/.test(t.contractAddress),
      );
      if (hasEvmAddresses) {
        const matched = registry.find(item => {
          if (item.status === 'deprecated') return false;
          const isTest = /testnet|sepolia|devnet/i.test(item.name);
          if ((network === 'testnet') !== isTest) return false;
          return (
            item.shortName?.toLowerCase() === key ||
            item.name.toLowerCase() === key
          );
        });
        if (matched) {
          evmChainId = matched.chainId;
          regItem = matched;
        }
      }
    }

    if (evmChainId && Number.isFinite(evmChainId)) {
      const rpcUrls = rankPublicHttpsRpcs(regItem?.rpc);
      const explorerUrl = regItem?.explorers
        ?.find(e => typeof e?.url === 'string' && e.url.startsWith('https://'))
        ?.url?.replace(/\/+$/, '');
      const rawLabel =
        bridge?.name ||
        (sdkChainName ? humanizeChainKey(sdkChainName) : undefined) ||
        regItem?.name?.replace(/\s+Mainnet$/i, '') ||
        humanizeChainKey(key);
      const label = rawLabel === 'BNB' ? 'BNB Chain' : rawLabel === 'Layer X' ? 'X Layer' : rawLabel;
      const meta: DynamicChainMeta = {
        blockchain: key,
        caip2: `eip155:${evmChainId}`,
        label,
        walletFamily: 'evm',
        evmChainId,
        hexChainId: `0x${evmChainId.toString(16)}`,
        ...(explorerUrl ? { explorerUrl } : {}),
        rpcUrls,
        keywords: extractChainKeywords(
          key,
          label,
          sdkChainName,
          regItem?.name,
          regItem?.chain,
          regItem?.shortName,
        ),
      };
      out.set(key, meta);
      latestChainCatalogByKey.set(key, meta);
      continue;
    }

    const label =
      bridge?.name ||
      (sdkChainName ? humanizeChainKey(sdkChainName) : undefined) ||
      humanizeChainKey(key);
    const rawCap = bridge?.swapCapSui ?? bridge?.swapCapBtc;
    const capNum = rawCap ? Number(rawCap) : undefined;
    const meta: DynamicChainMeta = {
      blockchain: key,
      caip2,
      label,
      walletFamily: null,
      rpcUrls: [],
      keywords: extractChainKeywords(key, label, sdkChainName),
      ...(capNum && Number.isFinite(capNum) && capNum > 0 ? { maxSwapCapDecimal: capNum } : {}),
    };
    out.set(key, meta);
    latestChainCatalogByKey.set(key, meta);
  }

  return out;
}

export function formatChainLabel(blockchain: string): string {
  const key = blockchain.toLowerCase();
  const cachedMeta = latestChainCatalogByKey.get(key);
  if (cachedMeta) return cachedMeta.label;
  return humanizeChainKey(key);
}

function noFundedWalletError(): Error {
  return Object.assign(new Error(NO_FUNDED_WALLET_MESSAGE), {
    statusCode: 400,
    code: NO_FUNDED_WALLET_CODE,
  });
}

export function decimalToAtomic(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const precision = Math.min(decimals, 12);
  const fixed = amount.toFixed(precision);
  const [whole, frac = ''] = fixed.split('.');
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function atomicToDecimal(atomic: bigint, decimals: number): number {
  if (atomic <= 0n) return 0;
  const base = 10n ** BigInt(decimals);
  const whole = Number(atomic / base);
  const rem = Number(atomic % base) / Number(base);
  return whole + rem;
}

export async function getLiveOneClickTokens(
  network: 'mainnet' | 'testnet' = config.network,
): Promise<OneClickToken[]> {
  const base = configureOneClickBase(network);
  const tokens = await cached<OneClickToken[]>(
    `oneclick:tokens:v3:${network}:${base}`,
    300,
    async () => {
      configureOneClickBase(network);
      const raw = await OneClickService.getTokens();
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          t =>
            t &&
            typeof t.assetId === 'string' &&
            typeof t.blockchain === 'string' &&
            typeof t.symbol === 'string' &&
            !t.symbol.toUpperCase().includes('DEPRECATED'),
        )
        .map(t => {
          const blockchain = String(t.blockchain).toLowerCase();
          const crossChainAsset = normalizeCrossChainAsset({
            assetId: t.assetId,
            blockchain,
            contractAddress: t.contractAddress,
          });
          return {
            assetId: t.assetId,
            decimals: Number(t.decimals) || 0,
            blockchain,
            symbol: t.symbol,
            price: Number(t.price) || 0,
            ...(t.contractAddress ? { contractAddress: t.contractAddress } : {}),
            ...(crossChainAsset ? { crossChainAsset } : {}),
          };
        });
    },
  );
  await discoverDynamicChains(tokens, network).catch(() => undefined);
  return tokens;
}

function encodeMulticallAggregate3(
  calls: Array<{ target: string; allowFailure: boolean; callData: string }>,
): string {
  const headOffset = '0000000000000000000000000000000000000000000000000000000000000020';
  const lenHex = calls.length.toString(16).padStart(64, '0');
  const tupleOffsets: string[] = [];
  const encodedTuples: string[] = [];
  let currentOffset = calls.length * 32;
  for (const call of calls) {
    tupleOffsets.push(currentOffset.toString(16).padStart(64, '0'));
    const cleanTarget = call.target.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    const allow = (call.allowFailure ? '1' : '0').padStart(64, '0');
    const dataOffset = (96).toString(16).padStart(64, '0');
    const rawData = call.callData.replace(/^0x/i, '').toLowerCase();
    const byteLen = rawData.length / 2;
    const lenWord = byteLen.toString(16).padStart(64, '0');
    const paddedData = rawData.padEnd(Math.ceil(rawData.length / 64) * 64, '0');
    const tupleHex = cleanTarget + allow + dataOffset + lenWord + paddedData;
    encodedTuples.push(tupleHex);
    currentOffset += tupleHex.length / 2;
  }
  return '0x82ad56cb' + headOffset + lenHex + tupleOffsets.join('') + encodedTuples.join('');
}

function decodeMulticallAggregate3(
  hexResult: string,
): Array<{ success: boolean; dataHex: string }> {
  const clean = hexResult.replace(/^0x/i, '');
  if (clean.length < 128) return [];
  const arrOffset = parseInt(clean.slice(0, 64), 16) * 2;
  if (!Number.isFinite(arrOffset) || arrOffset + 64 > clean.length) return [];
  const count = parseInt(clean.slice(arrOffset, arrOffset + 64), 16);
  const elemBase = arrOffset + 64;
  const results: Array<{ success: boolean; dataHex: string }> = [];
  for (let i = 0; i < count; i++) {
    const rel = parseInt(clean.slice(elemBase + i * 64, elemBase + (i + 1) * 64), 16) * 2;
    const pos = elemBase + rel;
    if (pos + 128 > clean.length) {
      results.push({ success: false, dataHex: '' });
      continue;
    }
    const success = parseInt(clean.slice(pos, pos + 64), 16) === 1;
    const bytesRel = parseInt(clean.slice(pos + 64, pos + 128), 16) * 2;
    const bytesPos = pos + bytesRel;
    const byteLen = parseInt(clean.slice(bytesPos, bytesPos + 64), 16);
    const dataHex = clean.slice(bytesPos + 64, bytesPos + 64 + byteLen * 2);
    results.push({ success, dataHex });
  }
  return results;
}

async function readEvmBalancesViaRpc(
  rpcUrl: string,
  cleanWallet: string,
  erc20Tokens: OneClickToken[],
): Promise<{ nativeWei: bigint; erc20Balances: Map<string, bigint> } | null> {
  const paddedAddr = cleanWallet.slice(2).padStart(64, '0');
  const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [
    {
      target: MULTICALL3_ADDRESS,
      allowFailure: true,
      callData: '0x4d2301cc' + paddedAddr,
    },
    ...erc20Tokens.map(t => ({
      target: t.contractAddress!,
      allowFailure: true,
      callData: '0x70a08231' + paddedAddr,
    })),
  ];

  const multicallData = encodeMulticallAggregate3(calls);
  const mcRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data: multicallData }, 'latest'],
    }),
  }).catch(() => null);

  if (mcRes?.ok) {
    const mcJson = (await mcRes.json().catch(() => ({}))) as { result?: string };
    if (typeof mcJson.result === 'string' && mcJson.result.length > 2 && mcJson.result !== '0x') {
      const decoded = decodeMulticallAggregate3(mcJson.result);
      if (decoded.length === calls.length) {
        const nativeHex = decoded[0]?.success ? decoded[0].dataHex.slice(0, 64) : '';
        const nativeWei =
          nativeHex && /^[0-9a-fA-F]+$/.test(nativeHex) ? BigInt('0x' + nativeHex) : 0n;
        const erc20Balances = new Map<string, bigint>();
        for (let i = 0; i < erc20Tokens.length; i++) {
          const item = decoded[i + 1];
          const rawHex = item?.success ? item.dataHex.slice(0, 64) : '';
          if (rawHex && /^[0-9a-fA-F]+$/.test(rawHex)) {
            const bal = BigInt('0x' + rawHex);
            if (bal > 0n) erc20Balances.set(erc20Tokens[i]!.assetId, bal);
          }
        }
        return { nativeWei, erc20Balances };
      }
    }
  }

  const batchPayload = [
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'eth_getBalance',
      params: [cleanWallet, 'latest'],
    },
    ...erc20Tokens.map((t, idx) => ({
      jsonrpc: '2.0',
      id: idx + 1,
      method: 'eth_call',
      params: [{ to: t.contractAddress!, data: '0x70a08231' + paddedAddr }, 'latest'],
    })),
  ];

  const batchRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3500),
    body: JSON.stringify(batchPayload),
  }).catch(() => null);

  if (!batchRes?.ok) return null;
  const batchJson = (await batchRes.json().catch(() => null)) as Array<{
    id?: number;
    result?: string;
  }> | null;
  if (!Array.isArray(batchJson)) return null;

  const byId = new Map<number, string>();
  for (const item of batchJson) {
    if (typeof item?.id === 'number' && typeof item.result === 'string') {
      byId.set(item.id, item.result);
    }
  }

  const rawNative = (byId.get(0) ?? '').replace(/^0x/i, '');
  const nativeWei = rawNative && /^[0-9a-fA-F]+$/.test(rawNative) ? BigInt('0x' + rawNative) : 0n;
  const erc20Balances = new Map<string, bigint>();
  for (let i = 0; i < erc20Tokens.length; i++) {
    const rawHex = (byId.get(i + 1) ?? '').replace(/^0x/i, '').slice(0, 64);
    if (rawHex && /^[0-9a-fA-F]+$/.test(rawHex)) {
      const bal = BigInt('0x' + rawHex);
      if (bal > 0n) erc20Balances.set(erc20Tokens[i]!.assetId, bal);
    }
  }
  return { nativeWei, erc20Balances };
}

async function scanEvmChainBalances(
  chainMeta: DynamicChainMeta,
  walletAddress: string,
  chainTokens: OneClickToken[],
): Promise<WalletHolding[]> {
  if (chainTokens.length === 0 || chainMeta.rpcUrls.length === 0) return [];
  const cleanWallet = walletAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(cleanWallet)) return [];

  const nativeToken = chainTokens.find(t => !t.contractAddress);
  const erc20Tokens = chainTokens.filter(
    t => t.contractAddress && /^0x[0-9a-fA-F]{40}$/.test(t.contractAddress),
  );

  let rpcData: { nativeWei: bigint; erc20Balances: Map<string, bigint> } | null = null;
  for (const rpcUrl of chainMeta.rpcUrls.slice(0, 2)) {
    rpcData = await readEvmBalancesViaRpc(rpcUrl, cleanWallet, erc20Tokens);
    if (rpcData) break;
  }
  if (!rpcData) return [];

  const hasNativeGas = rpcData.nativeWei >= 5_000_000_000_000n;
  const holdings: WalletHolding[] = [];

  if (nativeToken && rpcData.nativeWei > 0n) {
    const formatted = atomicToDecimal(rpcData.nativeWei, nativeToken.decimals);
    const usd =
      formatted *
      (nativeToken.price > 0
        ? nativeToken.price
        : STABLE_SYMBOLS.has(nativeToken.symbol.toUpperCase())
          ? 1
          : 0);
    if (usd >= 0.01 || formatted > 0) {
      holdings.push({
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: cleanWallet,
        token: nativeToken,
        chainLabel: chainMeta.label,
        ...(chainMeta.hexChainId ? { hexChainId: chainMeta.hexChainId } : {}),
        ...(chainMeta.explorerUrl ? { originExplorerUrl: chainMeta.explorerUrl } : {}),
        balanceAtomic: rpcData.nativeWei.toString(),
        balanceFormatted: formatted,
        balanceUsd: usd,
        hasNativeGas,
      });
    }
  }

  for (const tok of erc20Tokens) {
    const bal = rpcData.erc20Balances.get(tok.assetId) ?? 0n;
    if (bal <= 0n) continue;
    const formatted = atomicToDecimal(bal, tok.decimals);
    const usd =
      formatted *
      (tok.price > 0 ? tok.price : STABLE_SYMBOLS.has(tok.symbol.toUpperCase()) ? 1 : 0);
    if (usd < 0.01 && formatted <= 0) continue;
    holdings.push({
      source: 'external',
      walletNetwork: 'evm',
      walletAddress: cleanWallet,
      token: tok,
      chainLabel: chainMeta.label,
      ...(chainMeta.hexChainId ? { hexChainId: chainMeta.hexChainId } : {}),
      ...(chainMeta.explorerUrl ? { originExplorerUrl: chainMeta.explorerUrl } : {}),
      balanceAtomic: bal.toString(),
      balanceFormatted: formatted,
      balanceUsd: usd,
      hasNativeGas,
    });
  }

  return holdings;
}

async function scanSolanaBalances(
  chainMeta: DynamicChainMeta,
  walletAddress: string,
  solTokens: OneClickToken[],
): Promise<WalletHolding[]> {
  if (solTokens.length === 0 || chainMeta.rpcUrls.length === 0) return [];
  const addr = walletAddress.trim();
  if (!addr) return [];

  const rpcFetch = async (method: string, params: unknown[]) => {
    for (const rpcUrl of chainMeta.rpcUrls) {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(3500),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }).catch(() => null);
      if (res?.ok) {
        const data = (await res.json().catch(() => ({}))) as { result?: unknown };
        if (data.result !== undefined) return data.result;
      }
    }
    return null;
  };

  const [nativeRes, splRes, spl2022Res] = await Promise.all([
    rpcFetch('getBalance', [addr]).catch(() => null),
    rpcFetch('getTokenAccountsByOwner', [
      addr,
      { programId: SPL_TOKEN_PROGRAM },
      { encoding: 'jsonParsed' },
    ]).catch(() => null),
    rpcFetch('getTokenAccountsByOwner', [
      addr,
      { programId: SPL_TOKEN_2022_PROGRAM },
      { encoding: 'jsonParsed' },
    ]).catch(() => null),
  ]);

  const holdings: WalletHolding[] = [];
  const nativeSolToken =
    solTokens.find(t => !t.contractAddress && t.symbol.toUpperCase() === 'SOL') ??
    solTokens.find(t => !t.contractAddress);

  const lamports = BigInt((nativeRes as { value?: number } | null)?.value ?? 0);
  const hasNativeGas = lamports >= 1_000_000n;

  if (nativeSolToken && lamports > 0n) {
    const formatted = atomicToDecimal(lamports, nativeSolToken.decimals);
    holdings.push({
      source: 'external',
      walletNetwork: 'svm',
      walletAddress: addr,
      token: nativeSolToken,
      chainLabel: chainMeta.label,
      ...(chainMeta.explorerUrl ? { originExplorerUrl: chainMeta.explorerUrl } : {}),
      balanceAtomic: lamports.toString(),
      balanceFormatted: formatted,
      balanceUsd: formatted * (nativeSolToken.price || 0),
      hasNativeGas,
    });
  }

  const byMint = new Map<string, OneClickToken>();
  for (const t of solTokens) {
    if (t.contractAddress) byMint.set(t.contractAddress, t);
  }

  const parsedAccounts = [
    ...(((splRes as { value?: unknown[] } | null)?.value ?? []) as Array<{
      account?: {
        data?: {
          parsed?: {
            info?: { mint?: string; tokenAmount?: { amount?: string } };
          };
        };
      };
    }>),
    ...(((spl2022Res as { value?: unknown[] } | null)?.value ?? []) as Array<{
      account?: {
        data?: {
          parsed?: {
            info?: { mint?: string; tokenAmount?: { amount?: string } };
          };
        };
      };
    }>),
  ];

  for (const entry of parsedAccounts) {
    const info = entry.account?.data?.parsed?.info;
    const mint = info?.mint;
    const amountStr = info?.tokenAmount?.amount;
    if (!mint || !amountStr || !/^\d+$/.test(amountStr)) continue;
    const raw = BigInt(amountStr);
    if (raw <= 0n) continue;
    const tok = byMint.get(mint);
    if (!tok) continue;
    const formatted = atomicToDecimal(raw, tok.decimals);
    const usd =
      formatted *
      (tok.price > 0 ? tok.price : STABLE_SYMBOLS.has(tok.symbol.toUpperCase()) ? 1 : 0);
    holdings.push({
      source: 'external',
      walletNetwork: 'svm',
      walletAddress: addr,
      token: tok,
      chainLabel: chainMeta.label,
      ...(chainMeta.explorerUrl ? { originExplorerUrl: chainMeta.explorerUrl } : {}),
      balanceAtomic: raw.toString(),
      balanceFormatted: formatted,
      balanceUsd: usd,
      hasNativeGas,
    });
  }

  return holdings;
}

async function scanIntentsMultiTokenBalances(input: {
  nearRpc: string;
  verifier: string;
  intentsAccountId: string;
  walletNetwork: 'evm' | 'svm' | 'near';
  walletAddress: string;
  tokens: OneClickToken[];
  chainMap: Map<string, DynamicChainMeta>;
}): Promise<WalletHolding[]> {
  const out: WalletHolding[] = [];
  const chunkSize = 100;
  const batches: OneClickToken[][] = [];
  for (let i = 0; i < input.tokens.length; i += chunkSize) {
    batches.push(input.tokens.slice(i, i + chunkSize));
  }

  const batchResults = await Promise.all(
    batches.map(batch =>
      callViewFunction<string[]>(input.nearRpc, input.verifier, 'mt_batch_balance_of', {
        account_id: input.intentsAccountId,
        token_ids: batch.map(t => t.assetId),
      }).catch(() => []),
    ),
  );

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const balances = batchResults[b] ?? [];
    if (!Array.isArray(balances)) continue;
    for (let i = 0; i < batch.length; i++) {
      const rawStr = balances[i];
      if (!rawStr || !/^\d+$/.test(rawStr)) continue;
      const raw = BigInt(rawStr);
      if (raw <= 0n) continue;
      const tok = batch[i]!;
      const formatted = atomicToDecimal(raw, tok.decimals);
      const usd =
        formatted *
        (tok.price > 0 ? tok.price : STABLE_SYMBOLS.has(tok.symbol.toUpperCase()) ? 1 : 0);
      out.push({
        source: 'intents',
        walletNetwork: input.walletNetwork,
        walletAddress: input.walletAddress,
        intentsAccountId: input.intentsAccountId,
        token: tok,
        chainLabel: input.chainMap.get(tok.blockchain)?.label ?? formatChainLabel(tok.blockchain),
        balanceAtomic: raw.toString(),
        balanceFormatted: formatted,
        balanceUsd: usd,
        hasNativeGas: true,
      });
    }
  }

  return out;
}

export async function scanAllWalletHoldings(input: {
  userAddress?: string;
  externalWallets: ConnectedWalletInput[];
  tokens: OneClickToken[];
}): Promise<WalletHolding[]> {
  const activeNet = config.network;
  const nearRpc = rpcFor(activeNet);
  const chainMap = await discoverDynamicChains(input.tokens, activeNet);
  const intentsMeta = await discoverNearIntentsContracts(activeNet).catch(() => null);

  const tasks: Array<Promise<WalletHolding[]>> = [];

  const evmAddresses = [
    ...new Set(
      input.externalWallets
        .filter(w => w.network === 'evm' && /^0x[0-9a-fA-F]{40}$/.test(w.address.trim()))
        .map(w => w.address.trim().toLowerCase()),
    ),
  ];
  const svmAddresses = [
    ...new Set(
      input.externalWallets
        .filter(w => w.network === 'svm' && w.address.trim().length >= 32)
        .map(w => w.address.trim()),
    ),
  ];

  for (const evmAddr of evmAddresses) {
    for (const [chainKey, chainMeta] of chainMap.entries()) {
      if (chainMeta.walletFamily !== 'evm') continue;
      const chainTokens = input.tokens.filter(t => t.blockchain === chainKey);
      tasks.push(scanEvmChainBalances(chainMeta, evmAddr, chainTokens).catch(() => []));
    }
  }

  for (const svmAddr of svmAddresses) {
    for (const [chainKey, chainMeta] of chainMap.entries()) {
      if (chainMeta.walletFamily !== 'svm') continue;
      const solTokens = input.tokens.filter(t => t.blockchain === chainKey);
      tasks.push(scanSolanaBalances(chainMeta, svmAddr, solTokens).catch(() => []));
    }
  }

  if (input.userAddress) {
    const canonicalUserAddr = input.userAddress;
    tasks.push(
      (async (): Promise<WalletHolding[]> => {
        const rec = await ensureSpendingRecord(canonicalUserAddr).catch(() => null);
        const activeNearAccount = rec?.activeMainAddress ?? canonicalUserAddr;
        const nearMeta = chainMap.get('near');
        const nearLabel = nearMeta?.label ?? formatChainLabel('near');
        const out: WalletHolding[] = [];

        const nearTokens = input.tokens.filter(t => t.blockchain === 'near');
        const settlementUsdc = usdcFor(activeNet);
        const ftChecks = await Promise.all(
          nearTokens.map(async tok => {
            const contractId =
              tok.contractAddress?.trim() ||
              (tok.assetId.startsWith('nep141:') ? tok.assetId.slice('nep141:'.length).trim() : '');
            if (!contractId) return null;
            const rawStr = await readFtBalanceWei(nearRpc, contractId, activeNearAccount);
            let raw = BigInt(rawStr);
            if (
              activeNet === 'testnet' &&
              intentsMeta?.intentsUsdcContract &&
              intentsMeta.intentsUsdcContract !== settlementUsdc &&
              contractId === intentsMeta.intentsUsdcContract
            ) {
              const circleRaw = BigInt(
                await readFtBalanceWei(nearRpc, settlementUsdc, activeNearAccount),
              );
              if (circleRaw > 0n) {
                const treasurySandboxRaw = BigInt(
                  await readFtBalanceWei(nearRpc, contractId, treasuryFor('testnet')),
                );
                const bridged = circleRaw <= treasurySandboxRaw ? circleRaw : treasurySandboxRaw;
                raw += bridged;
              }
            }
            if (raw <= 0n) return null;
            const formatted = atomicToDecimal(raw, tok.decimals);
            const usd =
              formatted *
              (tok.price > 0 ? tok.price : STABLE_SYMBOLS.has(tok.symbol.toUpperCase()) ? 1 : 0);
            return {
              source: 'account' as const,
              walletNetwork: 'near' as const,
              walletAddress: activeNearAccount,
              token: tok,
              chainLabel: nearLabel,
              ...(nearMeta?.explorerUrl ? { originExplorerUrl: nearMeta.explorerUrl } : {}),
              balanceAtomic: raw.toString(),
              balanceFormatted: formatted,
              balanceUsd: usd,
              hasNativeGas: true,
            };
          }),
        );
        for (const item of ftChecks) {
          if (item) out.push(item);
        }

        if (intentsMeta?.verifier) {
          const mtHoldings = await scanIntentsMultiTokenBalances({
            nearRpc,
            verifier: intentsMeta.verifier,
            intentsAccountId: activeNearAccount,
            walletNetwork: 'near',
            walletAddress: activeNearAccount,
            tokens: input.tokens,
            chainMap,
          });
          out.push(...mtHoldings);
        }

        return out;
      })().catch(() => []),
    );
  }

  const settled = await Promise.all(tasks);
  return settled
    .flat()
    .filter(h => BigInt(h.balanceAtomic) > 0n)
    .sort((a, b) => b.balanceUsd - a.balanceUsd);
}
