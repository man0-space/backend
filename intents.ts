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
  deriveIntentsEd25519,
  derivePrivate,
  discoverNearIntentsContracts,
  ensureDepositReady,
  ensureIntentsPublicKeyRegistered,
  ensureSpendingRecord,
  executeContractCall,
  invalidateNearBalanceCache,
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
  nativeEthPayable?: boolean;
  swapCapEth?: string;
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
      const evmCapNum = bridge?.swapCapEth
        ? Number(bridge.swapCapEth)
        : network === 'testnet' && bridge?.nativeEthPayable
          ? 0.006
          : undefined;
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
        ...(evmCapNum && Number.isFinite(evmCapNum) && evmCapNum > 0
          ? { maxSwapCapDecimal: evmCapNum }
          : {}),
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
    const capNum = rawCap
      ? Number(rawCap)
      : network === 'testnet' && (key === 'stellar' || key === 'xrp')
        ? 100
        : network === 'testnet' && key === 'hypercore'
          ? 5
          : undefined;
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

function buildDynamicKeywordIndex(tokens: OneClickToken[]): Map<string, string> {
  const index = new Map<string, string>();
  const knownChains = new Set(tokens.map(t => t.blockchain.toLowerCase()));

  for (const chainKey of knownChains) {
    index.set(chainKey, chainKey);
    const cachedMeta = latestChainCatalogByKey.get(chainKey);
    if (cachedMeta) {
      for (const kw of cachedMeta.keywords) {
        if (!index.has(kw)) index.set(kw, chainKey);
      }
    }
  }

  for (const tok of tokens) {
    const chainKey = tok.blockchain.toLowerCase();
    const parsed = tryParseIntentsAsset(tok.assetId);
    const sdkName = parsed?.blockchain ? CAIP2_TO_CHAIN_NAME.get(parsed.blockchain) : undefined;
    if (sdkName) {
      for (const kw of extractChainKeywords(chainKey, sdkName)) {
        if (!index.has(kw)) index.set(kw, chainKey);
      }
    }
  }

  return index;
}

export function detectAllChainsInSegment(segment: string, tokens: OneClickToken[]): string[] {
  const index = buildDynamicKeywordIndex(tokens);
  const words = segment.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const found: string[] = [];
  for (const w of words) {
    const matched = index.get(w);
    if (matched && !found.includes(matched)) {
      found.push(matched);
    }
  }
  return found;
}

export function detectChainInSegment(segment: string, tokens: OneClickToken[]): string | null {
  return detectAllChainsInSegment(segment, tokens)[0] ?? null;
}

export function detectSymbolInSegment(segment: string, tokens: OneClickToken[]): string | null {
  const knownSymbols = new Map<string, string>();
  for (const t of tokens) {
    knownSymbols.set(t.symbol.toUpperCase(), t.symbol.toUpperCase());
  }
  if (knownSymbols.has('WNEAR') && !knownSymbols.has('NEAR')) {
    knownSymbols.set('NEAR', 'WNEAR');
  }

  const ignore = new Set(['USD', 'DOLLAR', 'DOLLARS', 'TO', 'IN', 'ON', 'FROM', 'AND', 'FOR']);
  const words = segment.match(/[A-Za-z0-9_]+/g) ?? [];
  for (const rawWord of words) {
    const upper = rawWord.toUpperCase();
    if (ignore.has(upper)) continue;
    if (knownSymbols.has(upper)) {
      return knownSymbols.get(upper)!;
    }
  }
  return null;
}

function extractExplicitAddress(text: string): string | null {
  const evmMatch = text.match(/\b(0x[a-fA-F0-9]{40})\b/);
  if (evmMatch) return evmMatch[1]!;
  const btcMatch = text.match(/\b((?:bc1|tb1)[a-zA-HJ-NP-Z0-9]{25,62})\b/);
  if (btcMatch) return btcMatch[1]!;
  const nearNamed = text.match(/\b([a-z0-9_-]{2,64}\.(?:near|testnet))\b/i);
  if (nearNamed) return nearNamed[1]!.toLowerCase();
  const universalMatch = text.match(/\b(0u[0-9a-z]{52})\b/);
  if (universalMatch) return universalMatch[1]!;
  const base58Match = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
  if (base58Match) return base58Match[1]!;
  return null;
}

function selectPreferredTokenOnChain(
  chainTokens: OneClickToken[],
  desiredSymbol?: string | null,
): OneClickToken | undefined {
  if (desiredSymbol) {
    const exact = chainTokens.find(t => t.symbol.toUpperCase() === desiredSymbol.toUpperCase());
    if (exact) return exact;
  }
  return (
    chainTokens.find(t => t.symbol.toUpperCase() === 'USDC') ??
    chainTokens.find(t => t.symbol.toUpperCase() === 'USDT') ??
    chainTokens.find(t => !t.contractAddress) ??
    chainTokens.find(t => t.symbol.toUpperCase() === t.blockchain.toUpperCase()) ??
    chainTokens[0]
  );
}

function effectiveTokenUsdPrice(token: OneClickToken): number {
  if (
    STABLE_SYMBOLS.has(token.symbol.toUpperCase()) &&
    (!token.price || Math.abs(token.price - 1) < 0.05)
  ) {
    return 1;
  }
  return token.price > 0 ? token.price : 1;
}

function rawWalletSpendableAtomic(holding: WalletHolding): bigint {
  const bal = BigInt(holding.balanceAtomic);
  if (bal <= 0n) return 0n;
  if (holding.source === 'external' && !holding.token.contractAddress) {
    const price = effectiveTokenUsdPrice(holding.token);
    const fixedReserve = decimalToAtomic(0.15 / price, holding.token.decimals);
    const pctReserve = bal / 20n;
    const gasReserve = fixedReserve > pctReserve ? fixedReserve : pctReserve;
    return bal > gasReserve ? bal - gasReserve : 0n;
  }
  return bal;
}

function maxSpendableAtomic(
  holding: WalletHolding,
  chainMeta?: DynamicChainMeta,
): bigint {
  let usable = rawWalletSpendableAtomic(holding);
  if (usable <= 0n) return 0n;

  if (chainMeta?.maxSwapCapDecimal && !holding.token.contractAddress) {
    const capAtomic = decimalToAtomic(chainMeta.maxSwapCapDecimal, holding.token.decimals);
    if (capAtomic > 0n && usable > capAtomic) {
      usable = capAtomic;
    }
  }

  return usable;
}

function parsePromptAmount(
  prompt: string,
  hasExplicitSymbol: boolean,
): { mode: 'usd' | 'token' | 'max'; value: number } {
  if (/\b(all|max|everything|entire\s+balance)\b/i.test(prompt)) {
    return { mode: 'max', value: 0 };
  }
  const usdPrefix = prompt.match(/\$\s*(\d+(?:\.\d+)?)/);
  const usdSuffix = prompt.match(/(\d+(?:\.\d+)?)\s*(?:usd|dollars?)\b/i);
  if (usdPrefix || usdSuffix) {
    const v = Number((usdPrefix ?? usdSuffix)![1]);
    if (!Number.isFinite(v) || v <= 0) {
      throw Object.assign(new Error('Enter an amount greater than zero.'), { statusCode: 400 });
    }
    return { mode: 'usd', value: v };
  }
  const numMatch = prompt.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) {
    throw Object.assign(
      new Error('Include an amount in your request, e.g. "Fund $20" or "Swap 0.1 SOL".'),
      { statusCode: 400 },
    );
  }
  const v = Number(numMatch[1]);
  if (!Number.isFinite(v) || v <= 0) {
    throw Object.assign(new Error('Enter an amount greater than zero.'), { statusCode: 400 });
  }
  return { mode: hasExplicitSymbol ? 'token' : 'usd', value: v };
}

function formatLegDisplayAmount(amountAtomic: bigint, token: OneClickToken): string {
  const humanIn = atomicToDecimal(amountAtomic, token.decimals);
  return token.symbol.toUpperCase() === 'USDC'
    ? `$${humanIn.toFixed(2)}`
    : `${Number(humanIn.toFixed(Math.min(6, token.decimals)))} ${token.symbol}`;
}

function extractOriginBridgeCapAtomicFromError(
  err: unknown,
  originToken: OneClickToken,
  destToken: OneClickToken,
): bigint | null {
  if (typeof err !== 'object' || err === null) return null;
  const msg = extractOneClickErrorMessage(err, '');
  if (/would\s+pay\s+out/i.test(msg)) {
    return null;
  }
  const symMatch = msg.match(/\b([A-Za-z0-9]+)\s+is\s+capped\s+at\s+(\d+(?:\.\d+)?)/i);
  if (
    symMatch?.[1] &&
    symMatch[1].toUpperCase() === destToken.symbol.toUpperCase() &&
    symMatch[1].toUpperCase() !== originToken.symbol.toUpperCase()
  ) {
    return null;
  }
  const body =
    'body' in err
      ? ((err as { body?: unknown }).body as
          | {
              capWei?: string;
              capLamports?: string;
              capAtomic?: string;
              maxUnits?: string;
            }
          | undefined)
      : undefined;
  const direct = body?.capWei ?? body?.capLamports ?? body?.capAtomic ?? body?.maxUnits;
  if (typeof direct === 'string' && /^\d+$/.test(direct) && BigInt(direct) > 0n) {
    return BigInt(direct);
  }
  if (!msg) return null;
  const parenUnits = msg.match(/\((\d{4,})\s*[a-zA-Z]*\)/);
  if (parenUnits?.[1]) {
    const v = BigInt(parenUnits[1]);
    if (v > 0n) return v;
  }
  if (symMatch?.[2]) {
    const v = decimalToAtomic(Number(symMatch[2]), originToken.decimals);
    if (v > 0n) return v;
  }
  return null;
}

export function isUniversalNearAccountId(address: string): boolean {
  return /^0u[0-9a-z]{52}$/.test(address.trim());
}

export function extractOneClickErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'body' in err) {
    const body = (err as { body?: unknown }).body as
      | { message?: string | string[]; error?: string }
      | undefined;
    if (Array.isArray(body?.message) && body.message.length > 0) {
      return body.message.join('; ');
    }
    if (typeof body?.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }
    if (typeof body?.error === 'string' && body.error.trim()) {
      return body.error.trim();
    }
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return String(err || fallback);
}

async function quoteSingleLegWithRetry(input: {
  network?: 'mainnet' | 'testnet';
  dry: boolean;
  holding: WalletHolding;
  amountAtomic: bigint;
  destToken: OneClickToken;
  destChainLabel: string;
  recipientAddress: string;
  connectedWallets: string[];
}): Promise<ResolvedIntentLeg> {
  const activeNet = input.network ?? config.network;
  configureOneClickBase(activeNet);
  const isIntentsDeposit = input.holding.source === 'intents' && Boolean(input.holding.intentsAccountId);
  const depositType = isIntentsDeposit
    ? QuoteRequest.depositType.INTENTS
    : QuoteRequest.depositType.ORIGIN_CHAIN;
  const refundType = isIntentsDeposit
    ? QuoteRequest.refundType.INTENTS
    : QuoteRequest.refundType.ORIGIN_CHAIN;
  const refundTo = isIntentsDeposit
    ? input.holding.intentsAccountId!
    : input.holding.walletAddress;

  const isNearUniversalRecipient =
    input.destToken.blockchain === 'near' && isUniversalNearAccountId(input.recipientAddress);
  let recipientType =
    activeNet === 'mainnet' && isNearUniversalRecipient
      ? QuoteRequest.recipientType.INTENTS
      : QuoteRequest.recipientType.DESTINATION_CHAIN;

  const tryQuote = async (
    amt: bigint,
    depositMode: QuoteRequest.depositMode,
    reqRecipientType: QuoteRequest.recipientType = recipientType,
  ): Promise<OneClickQuotePayload['quote']> => {
    const res = await OneClickService.getQuote({
      dry: input.dry,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      ...(depositType === QuoteRequest.depositType.ORIGIN_CHAIN ? { depositMode } : {}),
      slippageTolerance: 100,
      originAsset: input.holding.token.assetId,
      depositType,
      destinationAsset: input.destToken.assetId,
      recipientType: reqRecipientType,
      refundType,
      amount: amt.toString(),
      refundTo,
      recipient: input.recipientAddress,
      connectedWallets: input.connectedWallets,
      referral: 'man0',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    return {
      ...res.quote,
      depositMemo: res.quote.depositMemo ?? null,
    };
  };

  let finalAmount = input.amountAtomic;
  let currentMode =
    input.holding.token.blockchain === 'stellar' || input.holding.token.blockchain === 'xrp'
      ? QuoteRequest.depositMode.MEMO
      : QuoteRequest.depositMode.SIMPLE;

  let quote: OneClickQuotePayload['quote'] | undefined;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      quote = await tryQuote(finalAmount, currentMode, recipientType);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const errMsg = extractOneClickErrorMessage(err, 'NEAR Intents quote failed.');
      const capAtomic = extractOriginBridgeCapAtomicFromError(
        err,
        input.holding.token,
        input.destToken,
      );
      if (capAtomic && capAtomic < finalAmount) {
        finalAmount = capAtomic;
        continue;
      }
      if (/memo/i.test(errMsg) && currentMode === QuoteRequest.depositMode.SIMPLE) {
        currentMode = QuoteRequest.depositMode.MEMO;
        continue;
      }
      if (
        isNearUniversalRecipient &&
        recipientType === QuoteRequest.recipientType.DESTINATION_CHAIN
      ) {
        recipientType = QuoteRequest.recipientType.INTENTS;
        continue;
      }
      break;
    }
  }
  if (!quote) {
    const errMsg = extractOneClickErrorMessage(lastErr, 'NEAR Intents quote failed.');
    throw Object.assign(new Error(errMsg || 'NEAR Intents quote failed.'), {
      statusCode: 400,
    });
  }

  return {
    source: input.holding.source,
    depositType: isIntentsDeposit ? 'INTENTS' : 'ORIGIN_CHAIN',
    originToken: input.holding.token,
    originChainLabel: input.holding.chainLabel,
    originWalletNetwork: input.holding.walletNetwork,
    originWalletAddress: input.holding.walletAddress,
    ...(input.holding.intentsAccountId ? { intentsAccountId: input.holding.intentsAccountId } : {}),
    ...(input.holding.hexChainId ? { hexChainId: input.holding.hexChainId } : {}),
    ...(input.holding.originExplorerUrl ? { originExplorerUrl: input.holding.originExplorerUrl } : {}),
    destinationToken: input.destToken,
    destinationChainLabel: input.destChainLabel,
    recipientAddress: input.recipientAddress,
    amountAtomic: finalAmount.toString(),
    displayAmount: formatLegDisplayAmount(finalAmount, input.holding.token),
    quote,
  };
}

export async function resolveUserIntentQuote(input: {
  userAddress: string;
  prompt: string;
  dry: boolean;
  network?: 'mainnet' | 'testnet';
  connectedWallets?: ConnectedWalletInput[];
  holdingsOverride?: WalletHolding[];
  tokensOverride?: OneClickToken[];
}): Promise<ResolvedIntentRoute> {
  const activeNet = input.network ?? config.network;
  const cleanPrompt = input.prompt.trim();
  if (!cleanPrompt) {
    throw Object.assign(new Error('Describe what you want to fund, swap, or withdraw.'), {
      statusCode: 400,
    });
  }

  const rec =
    activeNet === config.network
      ? await ensureSpendingRecord(input.userAddress).catch(() => null)
      : null;
  const depositAccountId = rec?.activeMainAddress ?? input.userAddress;

  const linked = await listLinkedWallets(input.userAddress).catch(() => []);
  const externalMap = new Map<string, ConnectedWalletInput>();
  for (const item of linked) {
    const key = `${item.network}:${item.address.toLowerCase()}`;
    externalMap.set(key, { network: item.network, address: item.address });
  }
  for (const extra of input.connectedWallets ?? []) {
    if (!extra?.address?.trim()) continue;
    const key = `${extra.network}:${extra.address.trim().toLowerCase()}`;
    if (!externalMap.has(key)) {
      externalMap.set(key, { network: extra.network, address: extra.address.trim() });
    }
  }
  const externalWallets = [...externalMap.values()];

  const tokens = input.tokensOverride ?? (await getLiveOneClickTokens(activeNet));
  const chainMap = await discoverDynamicChains(tokens, activeNet);

  const preferredUsdcId = `nep141:${usdcFor(activeNet)}`;
  const nearUsdcToken =
    tokens.find(t => t.assetId === preferredUsdcId) ??
    tokens.find(t => t.blockchain === 'near' && t.symbol.toUpperCase() === 'USDC');
  if (!nearUsdcToken) {
    throw Object.assign(new Error('NEAR USDC asset is unavailable in 1Click catalog.'), {
      statusCode: 502,
    });
  }

  const holdings =
    input.holdingsOverride ??
    (await scanAllWalletHoldings({
      userAddress: input.userAddress,
      externalWallets,
      tokens,
    }));

  const lower = cleanPrompt.toLowerCase();
  const isWithdraw = /\b(withdraw|cash\s*out|payout|transfer\s+out|move\s+out)\b/i.test(lower);
  const splitArrow = cleanPrompt.split(/\s+(?:to|into|for)\s+|->|→/i);
  const targetClause = splitArrow.length >= 2 ? splitArrow.slice(1).join(' ').trim() : '';
  const targetIsSessionSelf =
    !targetClause || /\b(my\s+session|session|my\s+account|account|balance|man0)\b/i.test(targetClause);

  const action: 'deposit' | 'swap' | 'withdraw' = isWithdraw
    ? 'withdraw'
    : splitArrow.length >= 2 && !targetIsSessionSelf
      ? 'swap'
      : 'deposit';

  const originSegment = splitArrow[0] ?? cleanPrompt;
  const originChainHints = detectAllChainsInSegment(originSegment, tokens);
  const originSymbolHint = detectSymbolInSegment(originSegment, tokens);
  const parsedAmount = parsePromptAmount(originSegment, Boolean(originSymbolHint));

  const allWalletAddresses = [
    ...new Set([...externalWallets.map(w => w.address), depositAccountId]),
  ];

  if (action === 'withdraw') {
    const withdrawable = holdings.filter(
      h =>
        (h.source === 'account' || h.source === 'intents') &&
        h.token.assetId === nearUsdcToken.assetId,
    );
    const primaryHolding = withdrawable[0];
    const availableAtomic = BigInt(primaryHolding?.balanceAtomic ?? '0');
    const reqAtomic =
      parsedAmount.mode === 'max'
        ? availableAtomic
        : decimalToAtomic(parsedAmount.value, nearUsdcToken.decimals);

    if (!primaryHolding || availableAtomic < reqAtomic || reqAtomic <= 0n) {
      const availUsd = atomicToDecimal(availableAtomic, nearUsdcToken.decimals).toFixed(2);
      throw Object.assign(
        new Error(`Insufficient available balance ($${availUsd}) for this withdrawal.`),
        { statusCode: 400 },
      );
    }

    const destSegment = targetClause || cleanPrompt;
    const destChainHint = detectChainInSegment(destSegment, tokens);
    const destSymbolHint = detectSymbolInSegment(destSegment, tokens);
    const explicitRecipient = extractExplicitAddress(destSegment);

    const externalHoldings = holdings.filter(h => h.source === 'external');
    const fallbackFamily =
      externalWallets.some(w => w.network === 'svm') && !externalWallets.some(w => w.network === 'evm')
        ? 'svm'
        : 'evm';
    const fallbackChain = [...chainMap.values()].find(c => c.walletFamily === fallbackFamily)?.blockchain;

    const inferredChain =
      destChainHint ?? externalHoldings[0]?.token.blockchain ?? fallbackChain ?? tokens[0]!.blockchain;

    const chainTokens = tokens.filter(t => t.blockchain === inferredChain);
    const pickedDest =
      selectPreferredTokenOnChain(chainTokens, destSymbolHint) ??
      (destSymbolHint
        ? tokens.find(t => t.symbol.toUpperCase() === destSymbolHint && t.blockchain !== 'near')
        : undefined);
    if (!pickedDest) {
      throw Object.assign(
        new Error(`No supported asset found on ${formatChainLabel(inferredChain)}.`),
        { statusCode: 400 },
      );
    }

    const destFamily = chainMap.get(pickedDest.blockchain)?.walletFamily ?? null;
    const matchedExternal =
      explicitRecipient ??
      (destFamily === 'svm'
        ? externalWallets.find(w => w.network === 'svm')?.address
        : destFamily === 'evm'
          ? externalWallets.find(w => w.network === 'evm')?.address
          : null);

    if (!matchedExternal) {
      throw Object.assign(
        new Error(
          `Connect a ${formatChainLabel(pickedDest.blockchain)} wallet or include a recipient address in your request.`,
        ),
        { statusCode: 400 },
      );
    }

    const destChainLabel = chainMap.get(pickedDest.blockchain)?.label ?? formatChainLabel(pickedDest.blockchain);
    const leg = await quoteSingleLegWithRetry({
      network: activeNet,
      dry: input.dry,
      holding: primaryHolding,
      amountAtomic: reqAtomic,
      destToken: pickedDest,
      destChainLabel,
      recipientAddress: matchedExternal,
      connectedWallets: allWalletAddresses,
    });

    return {
      action,
      depositType: leg.depositType,
      originToken: leg.originToken,
      originChainLabel: leg.originChainLabel,
      originWalletNetwork: leg.originWalletNetwork,
      originWalletAddress: leg.originWalletAddress,
      ...(leg.intentsAccountId ? { intentsAccountId: leg.intentsAccountId } : {}),
      ...(leg.hexChainId ? { hexChainId: leg.hexChainId } : {}),
      destinationToken: leg.destinationToken,
      destinationChainLabel: leg.destinationChainLabel,
      recipientAddress: leg.recipientAddress,
      amountAtomic: leg.amountAtomic,
      displayAmount: leg.displayAmount,
      quote: leg.quote,
      legs: [leg],
      totalOutFormatted: leg.quote.amountOutFormatted,
      totalOutUsd: leg.quote.amountOutUsd ?? leg.quote.amountOutFormatted,
    };
  }

  let destToken: OneClickToken = nearUsdcToken;
  let destChainLabel: string = chainMap.get('near')?.label ?? formatChainLabel('near');
  let recipientAddress: string = depositAccountId;

  if (action === 'swap') {
    const destChainHint = detectChainInSegment(targetClause, tokens);
    const destSymbolHint = detectSymbolInSegment(targetClause, tokens);
    const explicitRecipient = extractExplicitAddress(targetClause);

    let pickedDest: OneClickToken | undefined;
    if (destChainHint) {
      const chainTokens = tokens.filter(t => t.blockchain === destChainHint);
      pickedDest = selectPreferredTokenOnChain(chainTokens, destSymbolHint);
    } else if (destSymbolHint) {
      pickedDest =
        tokens.find(
          t =>
            t.symbol.toUpperCase() === destSymbolHint &&
            (chainMap.get(t.blockchain)?.walletFamily ?? null) !== null,
        ) ?? tokens.find(t => t.symbol.toUpperCase() === destSymbolHint);
    }

    pickedDest = pickedDest ?? nearUsdcToken;
    const destFamily = chainMap.get(pickedDest.blockchain)?.walletFamily ?? null;
    const matchedRecipient =
      explicitRecipient ??
      (destFamily === 'near'
        ? depositAccountId
        : destFamily === 'svm'
          ? externalWallets.find(w => w.network === 'svm')?.address
          : destFamily === 'evm'
            ? externalWallets.find(w => w.network === 'evm')?.address
            : null);

    if (!matchedRecipient) {
      throw Object.assign(
        new Error(
          `Include a ${formatChainLabel(pickedDest.blockchain)} destination address or connect a matching wallet.`,
        ),
        { statusCode: 400 },
      );
    }

    destToken = pickedDest;
    destChainLabel = chainMap.get(pickedDest.blockchain)?.label ?? formatChainLabel(pickedDest.blockchain);
    recipientAddress = matchedRecipient;
  }

  const smartAccountHoldings = holdings.filter(
    h => h.source === 'account' || h.source === 'intents',
  );
  const hasExplicitExternalOrigin =
    originChainHints.some(ch => ch !== 'near') ||
    Boolean(
      originSymbolHint &&
        !smartAccountHoldings.some(h => h.token.symbol.toUpperCase() === originSymbolHint),
    );
  const restrictToSmartAccount = action === 'swap' && !hasExplicitExternalOrigin;

  const candidatePool = holdings.filter(h => {
    if (restrictToSmartAccount && h.source !== 'account' && h.source !== 'intents') {
      return false;
    }
    if (h.token.assetId === destToken.assetId && h.source === 'account') {
      return false;
    }
    if (h.source === 'external' && Boolean(h.token.contractAddress) && h.hasNativeGas === false) {
      return false;
    }
    return true;
  });

  if (candidatePool.length === 0) {
    if (restrictToSmartAccount) {
      throw Object.assign(
        new Error(
          'Your Smart Account has no available balance for this swap. Deposit funds first or specify an external origin chain.',
        ),
        { statusCode: 400 },
      );
    }
    throw noFundedWalletError();
  }

  let filtered = candidatePool;
  if (
    originChainHints.length === 1 &&
    originSymbolHint &&
    originChainHints[0] === originSymbolHint.toLowerCase()
  ) {
    const bySymbolOrChain = candidatePool.filter(
      h =>
        h.token.symbol.toUpperCase() === originSymbolHint ||
        h.token.blockchain === originChainHints[0],
    );
    if (bySymbolOrChain.length > 0) filtered = bySymbolOrChain;
  } else {
    if (originChainHints.length > 0) {
      const hintSet = new Set(originChainHints);
      const byChain = filtered.filter(h => hintSet.has(h.token.blockchain));
      if (byChain.length > 0) {
        filtered = byChain;
      } else {
        throw Object.assign(
          new Error(
            `No funded balance found on ${originChainHints.map(formatChainLabel).join(' or ')} in your connected wallets.`,
          ),
          { statusCode: 400 },
        );
      }
    }
    if (originSymbolHint) {
      const bySym = filtered.filter(h => h.token.symbol.toUpperCase() === originSymbolHint);
      if (bySym.length > 0) {
        filtered = bySym;
      } else {
        throw Object.assign(
          new Error(`No funded ${originSymbolHint} balance found in your connected wallets.`),
          { statusCode: 400 },
        );
      }
    }
  }

  const sourcePriority = (s: WalletHolding['source']): number =>
    s === 'intents' ? 0 : s === 'account' ? 1 : 2;

  const sortedCandidates = [...filtered]
    .map(h => {
      const spendable = maxSpendableAtomic(h, chainMap.get(h.token.blockchain));
      const spendableUsd =
        atomicToDecimal(spendable, h.token.decimals) * effectiveTokenUsdPrice(h.token);
      return {
        holding: h,
        spendable,
        spendableUsd,
      };
    })
    .filter(x => x.spendable > 0n)
    .sort((a, b) => {
      const pDiff = sourcePriority(a.holding.source) - sourcePriority(b.holding.source);
      if (pDiff !== 0) return pDiff;
      if (!originSymbolHint) {
        const aStable = STABLE_SYMBOLS.has(a.holding.token.symbol.toUpperCase()) ? 1 : 0;
        const bStable = STABLE_SYMBOLS.has(b.holding.token.symbol.toUpperCase()) ? 1 : 0;
        if (aStable !== bStable) return bStable - aStable;
      }
      if (Math.abs(b.spendableUsd - a.spendableUsd) > 1e-6) {
        return b.spendableUsd - a.spendableUsd;
      }
      return b.holding.balanceUsd - a.holding.balanceUsd;
    });

  if (sortedCandidates.length === 0) {
    throw noFundedWalletError();
  }

  if (!input.dry && recipientAddress === depositAccountId) {
    await ensureDepositReady(input.userAddress);
  }

  const legs: ResolvedIntentLeg[] = [];
  let lastQuoteError: unknown = null;

  if (parsedAmount.mode === 'max') {
    for (const cand of sortedCandidates.slice(0, 6)) {
      try {
        const leg = await quoteSingleLegWithRetry({
          network: activeNet,
          dry: input.dry,
          holding: cand.holding,
          amountAtomic: cand.spendable,
          destToken,
          destChainLabel,
          recipientAddress,
          connectedWallets: allWalletAddresses,
        });
        legs.push(leg);
      } catch (err) {
        lastQuoteError = err;
      }
    }
    if (legs.length === 0) {
      throw lastQuoteError ?? Object.assign(new Error('NEAR Intents quote failed.'), { statusCode: 400 });
    }
  } else if (parsedAmount.mode === 'token') {
    const singleTokenCandidates =
      originChainHints.length < 2
        ? sortedCandidates.filter(
            c => c.spendable >= decimalToAtomic(parsedAmount.value * 0.98, c.holding.token.decimals),
          )
        : [];
    const orderedTokenCandidates =
      singleTokenCandidates.length > 0
        ? [
            ...singleTokenCandidates,
            ...sortedCandidates.filter(c => !singleTokenCandidates.includes(c)),
          ]
        : sortedCandidates;

    let remainingTokens = parsedAmount.value;
    for (const cand of orderedTokenCandidates) {
      if (remainingTokens <= 1e-9 || legs.length >= 6) break;
      const desiredAtomic = decimalToAtomic(remainingTokens, cand.holding.token.decimals);
      const takeAtomic = desiredAtomic <= cand.spendable ? desiredAtomic : cand.spendable;
      if (takeAtomic <= 0n) continue;
      try {
        const leg = await quoteSingleLegWithRetry({
          network: activeNet,
          dry: input.dry,
          holding: cand.holding,
          amountAtomic: takeAtomic,
          destToken,
          destChainLabel,
          recipientAddress,
          connectedWallets: allWalletAddresses,
        });
        legs.push(leg);
        remainingTokens -= atomicToDecimal(BigInt(leg.amountAtomic), leg.originToken.decimals);
      } catch (err) {
        lastQuoteError = err;
      }
    }
    if (legs.length === 0 && lastQuoteError) {
      throw lastQuoteError;
    }
    if (remainingTokens > parsedAmount.value * 0.02) {
      const best = sortedCandidates[0]!.holding;
      throw Object.assign(
        new Error(
          `Insufficient funded balance: highest spendable balance is ${best.balanceFormatted.toFixed(
            Math.min(4, best.token.decimals),
          )} ${best.token.symbol} (~$${sortedCandidates[0]!.spendableUsd.toFixed(2)}) on ${best.chainLabel}.`,
        ),
        { statusCode: 400 },
      );
    }
  } else {
    const totalSpendableUsd = sortedCandidates.reduce((acc, c) => acc + c.spendableUsd, 0);
    if (totalSpendableUsd < parsedAmount.value * 0.95) {
      const best = sortedCandidates[0]!;
      throw Object.assign(
        new Error(
          restrictToSmartAccount
            ? `Insufficient Smart Account balance for this swap (~$${totalSpendableUsd.toFixed(2)} available). Deposit funds first or swap a smaller amount.`
            : `Insufficient spendable balance: ~$${totalSpendableUsd.toFixed(2)} available across connected wallets (highest: ${best.holding.balanceFormatted.toFixed(
                Math.min(4, best.holding.token.decimals),
              )} ${best.holding.token.symbol} / ~$${best.spendableUsd.toFixed(2)} spendable on ${best.holding.chainLabel}).`,
        ),
        { statusCode: 400 },
      );
    }

    const explicitMultiChainCount = originChainHints.length >= 2 ? originChainHints.length : 1;
    const perChainCapUsd =
      explicitMultiChainCount >= 2 ? parsedAmount.value / explicitMultiChainCount : Infinity;
    const singleUsdCandidates =
      explicitMultiChainCount === 1
        ? sortedCandidates.filter(c => c.spendableUsd >= parsedAmount.value * 0.98)
        : [];
    const orderedUsdCandidates =
      singleUsdCandidates.length > 0
        ? [
            ...singleUsdCandidates,
            ...sortedCandidates.filter(c => !singleUsdCandidates.includes(c)),
          ]
        : sortedCandidates;

    const usedChains = new Set<string>();
    let remainingUsd = parsedAmount.value;

    for (const cand of orderedUsdCandidates) {
      if (remainingUsd <= 0.01 || legs.length >= 6) break;
      if (explicitMultiChainCount >= 2 && usedChains.has(cand.holding.token.blockchain)) {
        continue;
      }
      const price = effectiveTokenUsdPrice(cand.holding.token);
      const legTargetUsd = Math.min(remainingUsd, perChainCapUsd);
      const desiredAtomic = decimalToAtomic(legTargetUsd / price, cand.holding.token.decimals);
      const takeAtomic = desiredAtomic <= cand.spendable ? desiredAtomic : cand.spendable;
      if (takeAtomic <= 0n) continue;
      try {
        const leg = await quoteSingleLegWithRetry({
          network: activeNet,
          dry: input.dry,
          holding: cand.holding,
          amountAtomic: takeAtomic,
          destToken,
          destChainLabel,
          recipientAddress,
          connectedWallets: allWalletAddresses,
        });
        legs.push(leg);
        usedChains.add(cand.holding.token.blockchain);
        const outUsd = Number(leg.quote.amountOutUsd || leg.quote.amountOutFormatted || 0);
        const inUsd = atomicToDecimal(BigInt(leg.amountAtomic), leg.originToken.decimals) * price;
        // If we selected a single-leg candidate covering the full requested input USD, treat slight DEX slippage (<10%) as satisfied so it never spills a tiny dust remainder onto a second wallet
        if (
          explicitMultiChainCount === 1 &&
          legs.length === 1 &&
          takeAtomic === desiredAtomic &&
          inUsd >= parsedAmount.value * 0.98
        ) {
          remainingUsd = 0;
          break;
        }
        remainingUsd -= outUsd > 0 ? outUsd : inUsd;
      } catch (err) {
        lastQuoteError = err;
      }
    }

    if (legs.length === 0 && lastQuoteError) {
      throw lastQuoteError;
    }
    if (remainingUsd > Math.max(0.05, parsedAmount.value * 0.05)) {
      const totalSpendableUsd = sortedCandidates.reduce((acc, c) => acc + c.spendableUsd, 0);
      const best = sortedCandidates[0]!;
      throw Object.assign(
        new Error(
          restrictToSmartAccount
            ? `Insufficient Smart Account balance for this swap (~$${totalSpendableUsd.toFixed(2)} available). Deposit funds first or swap a smaller amount.`
            : `Insufficient spendable balance: ~$${totalSpendableUsd.toFixed(2)} available across connected wallets (highest: ${best.holding.balanceFormatted.toFixed(
                Math.min(4, best.holding.token.decimals),
              )} ${best.holding.token.symbol} / ~$${best.spendableUsd.toFixed(2)} spendable on ${best.holding.chainLabel}).`,
        ),
        { statusCode: 400 },
      );
    }
  }

  const primary = legs[0]!;
  const totalOutAtomic = legs.reduce((acc, l) => acc + BigInt(l.quote.amountOut || '0'), 0n);
  const totalOutFormatted = atomicToDecimal(totalOutAtomic, destToken.decimals).toFixed(
    Math.min(6, destToken.decimals),
  );
  const totalOutUsd = legs
    .reduce((acc, l) => acc + Number(l.quote.amountOutUsd || l.quote.amountOutFormatted || 0), 0)
    .toFixed(2);
  const combinedDisplay =
    legs.length === 1
      ? primary.displayAmount
      : legs.map(l => `${l.displayAmount} (${l.originChainLabel})`).join(' + ');

  return {
    action,
    depositType: primary.depositType,
    originToken: primary.originToken,
    originChainLabel:
      legs.length === 1
        ? primary.originChainLabel
        : legs.map(l => l.originChainLabel).join(' + '),
    originWalletNetwork: primary.originWalletNetwork,
    originWalletAddress: primary.originWalletAddress,
    ...(primary.intentsAccountId ? { intentsAccountId: primary.intentsAccountId } : {}),
    ...(primary.hexChainId ? { hexChainId: primary.hexChainId } : {}),
    destinationToken: destToken,
    destinationChainLabel: destChainLabel,
    recipientAddress,
    amountAtomic: primary.amountAtomic,
    displayAmount: combinedDisplay,
    quote: {
      ...primary.quote,
      amountOut: totalOutAtomic.toString(),
      amountOutFormatted: Number(totalOutFormatted).toString(),
      amountOutUsd: totalOutUsd,
    },
    legs,
    totalOutFormatted: Number(totalOutFormatted).toString(),
    totalOutUsd,
  };
}

export async function generateUserIntent(
  userAddress: string,
  input: {
    depositAddress: string;
  },
): Promise<{
  mode: 'submitted';
  intentHash: string;
  correlationId: string;
}> {
  configureOneClickBase(config.network);
  const rec = await ensureSpendingRecord(userAddress);
  await ensureDepositReady(userAddress);
  if (!derive(rec.seedId).equals(rec.ownerCompressedKey)) {
    throw Object.assign(new Error('Account authorization mismatch.'), { statusCode: 401 });
  }

  const signerId = rec.activeMainAddress;
  const generated = await OneClickService.generateIntent({
    type: GenerateSwapTransferIntentRequest.type.SWAP_TRANSFER,
    standard: IntentStandardEnum.WEBAUTHN,
    signerId,
    depositAddress: input.depositAddress,
  });
  const payload = String(generated.intent.payload);
  const challenge32 = createHash('sha256').update(payload, 'utf8').digest();
  const publicKey = intentsPublicKey('p256', rec.ownerCompressedKey);
  const proof = signWebAuthnP256(
    derivePrivate(rec.seedId),
    challenge32,
    'https://man0.space',
    'man0.space',
  );
  const submitted = await OneClickService.submitIntent({
    type: SubmitSwapTransferIntentRequest.type.SWAP_TRANSFER,
    signedData: {
      standard: 'webauthn' as MultiPayload.standard,
      payload,
      public_key: publicKey,
      signature: proof.signature,
      authenticator_data: proof.authenticator_data,
      client_data_json: proof.client_data_json,
    } as MultiPayload,
  });
  return {
    mode: 'submitted',
    intentHash: submitted.intentHash,
    correlationId: submitted.correlationId,
  };
}

export async function submitUserDepositTx(input: {
  txHash: string;
  depositAddress: string;
  nearSenderAccount?: string;
  memo?: string;
}): Promise<SubmitDepositTxResponse> {
  configureOneClickBase(config.network);
  return OneClickService.submitDepositTx({
    txHash: input.txHash,
    depositAddress: input.depositAddress,
    ...(input.nearSenderAccount ? { nearSenderAccount: input.nearSenderAccount } : {}),
    ...(input.memo ? { memo: input.memo } : {}),
  });
}

export async function getUserIntentStatus(input: {
  depositAddress: string;
  depositMemo?: string;
}): Promise<GetExecutionStatusResponse> {
  configureOneClickBase(config.network);
  return OneClickService.getExecutionStatus(input.depositAddress, input.depositMemo);
}

interface SolanaInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface SolanaRawInstruction {
  programId: string;
  accounts: SolanaInstructionAccount[];
  data: Uint8Array;
}

function encodeCompactU16(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len);
  if (len < 0x4000) return Uint8Array.of((len & 0x7f) | 0x80, len >> 7);
  return Uint8Array.of((len & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, len >> 14);
}

function decodeSolanaPubkey(addr: string, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(addr.trim());
  } catch {
    throw Object.assign(new Error(`Invalid Solana ${label} address.`), { statusCode: 400 });
  }
  if (bytes.length !== 32) {
    throw Object.assign(new Error(`Invalid Solana ${label} address length.`), { statusCode: 400 });
  }
  return bytes;
}

function isEd25519OnCurve(bytes32: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes32, true);
    return true;
  } catch {
    return false;
  }
}

export function deriveSolanaAssociatedTokenAddress(
  ownerAddr: string,
  mintAddr: string,
  tokenProgramAddr: string = SPL_TOKEN_PROGRAM,
): string {
  const owner = decodeSolanaPubkey(ownerAddr, 'owner');
  const mint = decodeSolanaPubkey(mintAddr, 'mint');
  const tokenProg = decodeSolanaPubkey(tokenProgramAddr, 'token program');
  const ataProg = decodeSolanaPubkey(SOLANA_ATA_PROGRAM, 'ATA program');
  const marker = Buffer.from('ProgramDerivedAddress', 'utf8');

  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    h.update(owner);
    h.update(tokenProg);
    h.update(mint);
    h.update(Uint8Array.of(bump));
    h.update(ataProg);
    h.update(marker);
    const candidate = new Uint8Array(h.digest());
    if (!isEd25519OnCurve(candidate)) {
      return base58.encode(candidate);
    }
  }
  throw new Error('Failed to derive Solana Associated Token Account PDA.');
}

function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  buf.writeBigUInt64LE(value, offset);
}

export function encodeSolanaTransferTransaction(input: {
  senderAddress: string;
  depositAddress: string;
  amountAtomic: string;
  recentBlockhash: string;
  tokenContract?: string;
  tokenProgramId?: string;
  decimals?: number;
  destIsTokenAccount?: boolean;
  memo?: string;
}): {
  wireBytes: Uint8Array;
  messageBytes: Uint8Array;
  messageBase58: string;
  transactionBase64: string;
} {
  const amount = BigInt(input.amountAtomic);
  if (amount <= 0n) {
    throw Object.assign(new Error('Solana transfer amount must be positive.'), {
      statusCode: 400,
    });
  }
  const sender = input.senderAddress.trim();
  const recipient = input.depositAddress.trim();
  decodeSolanaPubkey(sender, 'sender');
  decodeSolanaPubkey(recipient, 'recipient');
  const blockhashBytes = decodeSolanaPubkey(input.recentBlockhash, 'blockhash');

  const instructions: SolanaRawInstruction[] = [];
  const tokenMint = input.tokenContract?.trim();

  if (!tokenMint) {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0); // SystemProgram.transfer = 2
    writeU64LE(data, amount, 4);
    instructions.push({
      programId: SOLANA_SYSTEM_PROGRAM,
      accounts: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
      ],
      data,
    });
  } else {
    const tokenProg = input.tokenProgramId ?? SPL_TOKEN_PROGRAM;
    const decimals = input.decimals ?? 6;
    const senderAta = deriveSolanaAssociatedTokenAddress(sender, tokenMint, tokenProg);
    const destTokenAccount = input.destIsTokenAccount
      ? recipient
      : deriveSolanaAssociatedTokenAddress(recipient, tokenMint, tokenProg);

    if (!input.destIsTokenAccount) {
      instructions.push({
        programId: SOLANA_ATA_PROGRAM,
        accounts: [
          { pubkey: sender, isSigner: true, isWritable: true },
          { pubkey: destTokenAccount, isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: false },
          { pubkey: tokenMint, isSigner: false, isWritable: false },
          { pubkey: SOLANA_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: tokenProg, isSigner: false, isWritable: false },
        ],
        data: Uint8Array.of(1), // AssociatedTokenAccountInstruction::CreateIdempotent
      });
    }

    const transferData = Buffer.alloc(10);
    transferData.writeUInt8(12, 0); // TokenInstruction::TransferChecked = 12
    writeU64LE(transferData, amount, 1);
    transferData.writeUInt8(decimals & 0xff, 9);

    instructions.push({
      programId: tokenProg,
      accounts: [
        { pubkey: senderAta, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: destTokenAccount, isSigner: false, isWritable: true },
        { pubkey: sender, isSigner: true, isWritable: false },
      ],
      data: transferData,
    });
  }

  if (input.memo?.trim()) {
    instructions.push({
      programId: SOLANA_MEMO_PROGRAM,
      accounts: [{ pubkey: sender, isSigner: true, isWritable: false }],
      data: Buffer.from(input.memo.trim(), 'utf8'),
    });
  }

  const metaMap = new Map<
    string,
    { pubkey: string; bytes: Uint8Array; isSigner: boolean; isWritable: boolean }
  >();
  const upsertAccount = (pubkey: string, isSigner: boolean, isWritable: boolean) => {
    const clean = pubkey.trim();
    const existing = metaMap.get(clean);
    if (existing) {
      existing.isSigner = existing.isSigner || isSigner;
      existing.isWritable = existing.isWritable || isWritable;
    } else {
      metaMap.set(clean, {
        pubkey: clean,
        bytes: decodeSolanaPubkey(clean, 'account'),
        isSigner,
        isWritable,
      });
    }
  };

  // Fee payer must always be index 0 (writable signer)
  upsertAccount(sender, true, true);
  for (const ix of instructions) {
    for (const acc of ix.accounts) {
      upsertAccount(acc.pubkey, acc.isSigner, acc.isWritable);
    }
    upsertAccount(ix.programId, false, false);
  }

  const feePayerEntry = metaMap.get(sender)!;
  const rest = [...metaMap.values()].filter(a => a.pubkey !== sender);
  const rank = (a: { isSigner: boolean; isWritable: boolean }): number => {
    if (a.isSigner && a.isWritable) return 0;
    if (a.isSigner && !a.isWritable) return 1;
    if (!a.isSigner && a.isWritable) return 2;
    return 3;
  };
  rest.sort((a, b) => rank(a) - rank(b));

  const orderedAccounts = [feePayerEntry, ...rest];
  const indexByPubkey = new Map<string, number>();
  orderedAccounts.forEach((acc, idx) => indexByPubkey.set(acc.pubkey, idx));

  const numRequiredSignatures = orderedAccounts.filter(a => a.isSigner).length;
  const numReadonlySignedAccounts = orderedAccounts.filter(a => a.isSigner && !a.isWritable).length;
  const numReadonlyUnsignedAccounts = orderedAccounts.filter(
    a => !a.isSigner && !a.isWritable,
  ).length;

  const messageChunks: Uint8Array[] = [
    Uint8Array.of(
      numRequiredSignatures,
      numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts,
    ),
    encodeCompactU16(orderedAccounts.length),
    ...orderedAccounts.map(a => a.bytes),
    blockhashBytes,
    encodeCompactU16(instructions.length),
  ];

  for (const ix of instructions) {
    const progIdx = indexByPubkey.get(ix.programId)!;
    const accIndices = Uint8Array.from(ix.accounts.map(a => indexByPubkey.get(a.pubkey)!));
    messageChunks.push(
      Uint8Array.of(progIdx),
      encodeCompactU16(accIndices.length),
      accIndices,
      encodeCompactU16(ix.data.length),
      ix.data,
    );
  }

  const messageBytes = new Uint8Array(Buffer.concat(messageChunks));
  const sigCountBytes = encodeCompactU16(numRequiredSignatures);
  const blankSignatures = new Uint8Array(64 * numRequiredSignatures);
  const wireBytes = new Uint8Array(
    Buffer.concat([sigCountBytes, blankSignatures, messageBytes]),
  );

  return {
    wireBytes,
    messageBytes,
    messageBase58: base58.encode(wireBytes),
    transactionBase64: Buffer.from(wireBytes).toString('base64'),
  };
}

async function resolveSolanaChainMeta(
  network: 'mainnet' | 'testnet' = config.network,
): Promise<{ rpcUrls: string[]; explorerBase: string }> {
  const tokens = await getLiveOneClickTokens(network).catch(() => []);
  const chainMap =
    tokens.length > 0 ? await discoverDynamicChains(tokens, network).catch(() => null) : null;
  const solMeta = chainMap?.get('sol') ?? latestChainCatalogByKey.get('sol');
  const customSolRpc = process.env.SOLANA_RPC_URL?.trim();
  const fallbackRpcs = customSolRpc
    ? [customSolRpc]
    : network === 'testnet'
      ? ['https://api.devnet.solana.com']
      : ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
  const rpcUrls = solMeta && solMeta.rpcUrls.length > 0 ? solMeta.rpcUrls : fallbackRpcs;
  const explorerBase =
    solMeta?.explorerUrl ||
    (network === 'testnet'
      ? 'https://explorer.solana.com?cluster=devnet'
      : 'https://explorer.solana.com');
  return { rpcUrls, explorerBase };
}

async function solanaRpcCall<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
): Promise<T> {
  let lastError = `Solana RPC ${method} failed.`;
  for (const rpcUrl of rpcUrls) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).catch(() => null);
    if (!res?.ok) continue;
    const json = (await res.json().catch(() => null)) as {
      result?: T;
      error?: { message?: string; data?: unknown };
    } | null;
    if (json?.error) {
      lastError = json.error.message || lastError;
      continue;
    }
    if (json && 'result' in json && json.result !== undefined) {
      return json.result;
    }
  }
  throw Object.assign(new Error(lastError), { statusCode: 502 });
}

export async function prepareSolanaOriginTransfer(input: {
  senderAddress: string;
  depositAddress: string;
  amountAtomic: string;
  tokenContract?: string;
  decimals?: number;
  memo?: string;
  network?: 'mainnet' | 'testnet';
}): Promise<{
  messageBase58: string;
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}> {
  const activeNet = input.network ?? config.network;
  const { rpcUrls } = await resolveSolanaChainMeta(activeNet);

  const blockhashRes = await solanaRpcCall<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(rpcUrls, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);

  const tokenContract = input.tokenContract?.trim();
  let tokenProgramId = SPL_TOKEN_PROGRAM;
  let decimals = input.decimals;
  let destIsTokenAccount = false;

  if (tokenContract) {
    const accountsRes = await solanaRpcCall<{
      value: Array<{ owner?: string; data?: [string, string] } | null>;
    }>(rpcUrls, 'getMultipleAccounts', [
      [tokenContract, input.depositAddress.trim()],
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    const mintInfo = accountsRes.value?.[0];
    const destInfo = accountsRes.value?.[1];
    if (mintInfo?.owner === SPL_TOKEN_2022_PROGRAM) {
      tokenProgramId = SPL_TOKEN_2022_PROGRAM;
    }
    if (decimals === undefined && mintInfo?.data?.[0]) {
      const rawMint = Buffer.from(mintInfo.data[0], 'base64');
      if (rawMint.length > 44) {
        decimals = rawMint[44];
      }
    }
    if (destInfo?.owner === tokenProgramId) {
      destIsTokenAccount = true;
    }
  }

  const encoded = encodeSolanaTransferTransaction({
    senderAddress: input.senderAddress,
    depositAddress: input.depositAddress,
    amountAtomic: input.amountAtomic,
    recentBlockhash: blockhashRes.value.blockhash,
    tokenContract,
    tokenProgramId,
    decimals,
    destIsTokenAccount,
    memo: input.memo,
  });

  return {
    messageBase58: encoded.messageBase58,
    transactionBase64: encoded.transactionBase64,
    recentBlockhash: blockhashRes.value.blockhash,
    lastValidBlockHeight: blockhashRes.value.lastValidBlockHeight,
  };
}

function buildSolanaExplorerTxUrl(explorerBase: string, txHash: string): string {
  try {
    const parsed = new URL(explorerBase);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/tx/${txHash}`;
    return parsed.toString();
  } catch {
    return `https://explorer.solana.com/tx/${txHash}`;
  }
}

export async function broadcastSolanaOriginTransfer(input: {
  signedTransactionBase64: string;
  depositAddress: string;
  memo?: string;
  network?: 'mainnet' | 'testnet';
}): Promise<{
  txHash: string;
  explorerUrl: string;
}> {
  const activeNet = input.network ?? config.network;
  const rawBytes = Buffer.from(input.signedTransactionBase64, 'base64');
  if (rawBytes.length < 66 || rawBytes[0] === 0) {
    throw Object.assign(new Error('Invalid signed Solana transaction payload.'), {
      statusCode: 400,
    });
  }
  const sigSlice = rawBytes.subarray(1, 65);
  if (sigSlice.every(b => b === 0)) {
    throw Object.assign(new Error('Solana transaction is missing wallet signature.'), {
      statusCode: 400,
    });
  }

  const { rpcUrls, explorerBase } = await resolveSolanaChainMeta(activeNet);
  const txHash = await solanaRpcCall<string>(rpcUrls, 'sendTransaction', [
    input.signedTransactionBase64,
    {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    },
  ]);

  for (let i = 0; i < 6; i++) {
    const statusRes = await solanaRpcCall<{
      value: Array<{
        confirmationStatus?: string | null;
        err?: unknown;
      } | null>;
    }>(rpcUrls, 'getSignatureStatuses', [[txHash], { searchTransactionHistory: false }]).catch(
      () => null,
    );
    const st = statusRes?.value?.[0];
    if (st?.err) {
      throw Object.assign(
        new Error(`Solana transaction failed on-chain: ${JSON.stringify(st.err)}`),
        { statusCode: 400 },
      );
    }
    if (
      st?.confirmationStatus === 'confirmed' ||
      st?.confirmationStatus === 'finalized' ||
      st?.confirmationStatus === 'processed'
    ) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await submitUserDepositTx({
    txHash,
    depositAddress: input.depositAddress,
    memo: input.memo,
  }).catch(() => undefined);

  return {
    txHash,
    explorerUrl: buildSolanaExplorerTxUrl(explorerBase, txHash),
  };
}
