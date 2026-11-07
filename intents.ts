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
