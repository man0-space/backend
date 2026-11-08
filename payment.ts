import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { chains as composeChains } from '@compose-market/sdk';
import type { FacilitatorChain, NetworkId } from '@compose-market/sdk/chains';
import { config, rpcFor, treasuryFor, usdcFor } from './config.js';
import {
  ensureFtStorageDeposit,
  listLinkedWallets,
  resolveMainUserAddress,
  resolveUserAddressOnNetwork,
} from './auth/account.js';
import * as authToken from './auth/token.js';
import { cached } from './databases/cache.js';

export type PaymentNetwork = NetworkId;

export const PLATFORM_FEE_PERCENT = 2;
export const MIN_CREATOR_FEE_PERCENT = 1;
export const MAX_CREATOR_FEE_PERCENT = 3;
export const DEFAULT_AUTHORIZATION_BUDGET_WEI = '500000';

export interface Charge {
  action: string;
  creatorUserAddress: string;
  creatorFeePercent: number;
  maxAmountWei?: string;
}
export type SessionPaymentConfig = Charge;

export interface Split {
  composeBillWei: bigint;
  creatorFeePercent: number;
  creatorFeeWei: bigint;
  platformFeePercent: number;
  platformFeeWei: bigint;
  serviceFeeWei: bigint;
  totalChargedWei: bigint;
}
export type WorkflowFeeBreakdown = Split;

export interface Payer {
  mode: 'session' | 'x402';
  paymentIntentId?: string;
  paymentPayload?: Record<string, unknown>;
  paymentRequirements?: Record<string, unknown>;
  userAddress: string;
  sessionSubject?: string;
  network: PaymentNetwork;
  token?: string;
  creatorUserAddress: string;
  creatorRecipientAddress: string;
  creatorFeePercent: number;
  treasuryAddress: string;
  action: string;
  runId: string;
}
export type PaymentSessionContext = Payer;

export interface Settlement {
  settled: boolean;
  status: string;
  txHash: string | null;
  paymentIntentId: string | null;
  composeBillWei: string;
  creatorFeePercent: number;
  creatorFeeWei: string;
  platformFeePercent: number;
  platformFeeWei: string;
  serviceFeeWei: string;
  totalChargedWei: string;
}
export type WorkflowSettlementOutcome = Settlement;

export async function chains(fetchImpl: typeof fetch = fetch): Promise<FacilitatorChain[]> {
  if (fetchImpl !== globalThis.fetch) {
    const res = await composeChains.fetchChains({
      baseUrl: config.composeApiUrl,
      fetch: fetchImpl,
      signal: AbortSignal.timeout(10_000),
    });
    return res.chains;
  }
  return cached<FacilitatorChain[]>(
    `facilitator:chains:${config.composeApiUrl}`,
    300,
    async () => {
      const res = await composeChains.fetchChains({
        baseUrl: config.composeApiUrl,
        fetch: fetchImpl,
        signal: AbortSignal.timeout(10_000),
      });
      return res.chains;
    },
  );
}

export async function chain(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FacilitatorChain> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw Object.assign(new Error('Missing payment network identifier.'), { statusCode: 400 });
  }
  const all = await chains(fetchImpl);
  const found = all.find(c => c.network.toLowerCase() === trimmed.toLowerCase());
  if (!found) {
    throw Object.assign(new Error(`Unsupported payment network "${trimmed}".`), {
      statusCode: 400,
    });
  }
  return found;
}

export function treasury(target: FacilitatorChain): string {
  if (target.namespace === 'near') {
    return treasuryFor(target.isTestnet ? 'testnet' : 'mainnet');
  }
  if (target.namespace === 'eip155') {
    const evmTreasury = process.env.TREASURY_EVM_ADDRESS?.trim();
    if (evmTreasury) return evmTreasury;
  }
  if (target.namespace === 'solana') {
    const svmTreasury = process.env.TREASURY_SVM_ADDRESS?.trim();
    if (svmTreasury) return svmTreasury;
  }
  throw Object.assign(
    new Error(`Treasury recipient is not configured for ${target.network}.`),
    { statusCode: 400 },
  );
}

export async function creator(
  creatorUserAddress: string,
  target: FacilitatorChain,
): Promise<string> {
  if (target.namespace === 'near') {
    const nearNet = target.isTestnet ? 'testnet' : 'mainnet';
    const resolved = await resolveUserAddressOnNetwork(creatorUserAddress, nearNet).catch(
      () => null,
    );
    return resolved?.signerId ?? creatorUserAddress;
  }
  const linked = await listLinkedWallets(creatorUserAddress).catch(() => []);
  if (target.namespace === 'eip155') {
    const evmLink = linked.find(l => l.network === 'evm' && l.status === 'active');
    if (evmLink) return evmLink.address;
  }
  if (target.namespace === 'solana') {
    const svmLink = linked.find(l => l.network === 'svm' && l.status === 'active');
    if (svmLink) return svmLink.address;
  }
  return treasury(target);
}

export function ceilPercent(amountWei: bigint, percent: number): bigint {
  if (amountWei <= 0n || percent <= 0) return 0n;
  const numerator = amountWei * BigInt(Math.trunc(percent));
  return (numerator - 1n) / 100n + 1n;
}

export function computeWorkflowServiceFees(
  composeBillWei: bigint,
  creatorFeePercent: number,
  isCreator: boolean,
): Split {
  const normalizedBill = composeBillWei > 0n ? composeBillWei : 0n;
  if (isCreator && creatorFeePercent === 0) {
    return {
      composeBillWei: normalizedBill,
      creatorFeePercent: 0,
      creatorFeeWei: 0n,
      platformFeePercent: 0,
      platformFeeWei: 0n,
      serviceFeeWei: 0n,
      totalChargedWei: normalizedBill,
    };
  }
  if (
    !Number.isInteger(creatorFeePercent) ||
    creatorFeePercent < MIN_CREATOR_FEE_PERCENT ||
    creatorFeePercent > MAX_CREATOR_FEE_PERCENT
  ) {
    throw Object.assign(
      new Error(
        `creatorFee must be an integer percentage between ${MIN_CREATOR_FEE_PERCENT}% and ${MAX_CREATOR_FEE_PERCENT}%.`,
      ),
      { statusCode: 400 },
    );
  }
  const effectiveCreatorPercent = isCreator ? 0 : creatorFeePercent;
  const creatorFeeWei = ceilPercent(normalizedBill, effectiveCreatorPercent);
  const platformFeeWei = ceilPercent(normalizedBill, PLATFORM_FEE_PERCENT);
  const serviceFeeWei = creatorFeeWei + platformFeeWei;
  const totalChargedWei = normalizedBill + serviceFeeWei;
  return {
    composeBillWei: normalizedBill,
    creatorFeePercent: effectiveCreatorPercent,
    creatorFeeWei,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    platformFeeWei,
    serviceFeeWei,
    totalChargedWei,
  };
}

export function usdcToWei(usdc: string | number): string {
  const str = typeof usdc === 'number' ? usdc.toFixed(6) : usdc.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(str)) {
    throw new Error(`Invalid USDC amount: ${usdc}`);
  }
  const [whole, fraction = ''] = str.split('.');
  const paddedFraction = fraction.padEnd(6, '0').slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(paddedFraction)).toString();
}

export function weiToUsdc(amountWei: bigint | string): string {
  const value = typeof amountWei === 'bigint' ? amountWei : BigInt(amountWei || '0');
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

export function extractSessionToken(request: FastifyRequest): string | null {
  const explicitKey = request.headers['x-compose-key'];
  if (typeof explicitKey === 'string') {
    const trimmed = explicitKey.trim().replace(/^Bearer\s+/i, '');
    if (trimmed.startsWith('compose-')) return trimmed;
  }
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const raw = auth.slice(7).trim();
  return raw.startsWith('compose-') ? raw : null;
}

export function extractPaymentSignature(request: FastifyRequest): string | null {
  const raw =
    (request.headers['payment-signature'] as string | undefined) ??
    (request.headers['x-payment'] as string | undefined);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function parseComposeToken(
  token: string,
): { sub?: string; keyId?: string; exp?: number; network?: string } | null {
  if (!token.startsWith('compose-')) return null;
  const jwt = token.slice('compose-'.length);
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(decoded) as {
      sub?: string;
      keyId?: string;
      exp?: number;
      network?: string;
    };
  } catch {
    return null;
  }
}

export interface ReceiptMeta {
  billWei: bigint;
  provider?: string;
  model?: string;
  requestId?: string;
}

function parsePositiveUint(value: unknown): bigint {
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }
  return 0n;
}

export function extractMetaFromReceiptPayload(
  receiptObj: Record<string, unknown> | null | undefined,
): ReceiptMeta {
  if (!receiptObj || typeof receiptObj !== 'object') {
    return { billWei: 0n };
  }

  const finalWei = parsePositiveUint(receiptObj.finalAmountWei ?? receiptObj.final_amount_wei);
  let billWei = finalWei;

  const isRuntimeAgentReceipt =
    receiptObj.service === 'runtime' ||
    (Array.isArray(receiptObj.bills) &&
      receiptObj.bills.some(
        b =>
          Boolean(b && typeof b === 'object') &&
          ((b as Record<string, unknown>).kind === 'agent' ||
            (b as Record<string, unknown>).source === 'runtime'),
      ));

  if (isRuntimeAgentReceipt) {
    const cumulativeObj =
      receiptObj.cumulative && typeof receiptObj.cumulative === 'object'
        ? (receiptObj.cumulative as Record<string, unknown>)
        : null;
    const cumulativeTotalWei = parsePositiveUint(
      cumulativeObj?.totalAmountWei ?? cumulativeObj?.total_amount_wei,
    );
    const firstBill =
      Array.isArray(receiptObj.bills) &&
        receiptObj.bills[0] &&
        typeof receiptObj.bills[0] === 'object'
        ? (receiptObj.bills[0] as Record<string, unknown>)
        : null;
    const billTotalWei = parsePositiveUint(firstBill?.total);
    const underlyingWei = parsePositiveUint(
      receiptObj.underlyingTotalWei ??
      receiptObj.underlying_total_wei ??
      receiptObj.feeBaseWei ??
      receiptObj.fee_base_wei,
    );

    if (cumulativeTotalWei > 0n) {
      billWei = cumulativeTotalWei;
    } else if (billTotalWei > 0n) {
      billWei = billTotalWei;
    } else if (underlyingWei > 0n) {
      billWei = underlyingWei + finalWei;
    }
  }

  let provider =
    typeof receiptObj.provider === 'string' && receiptObj.provider.trim()
      ? receiptObj.provider.trim()
      : undefined;
  let model =
    typeof receiptObj.model === 'string' && receiptObj.model.trim()
      ? receiptObj.model.trim()
      : undefined;

  const parseSubjectPair = (subjectValue: unknown) => {
    if (typeof subjectValue !== 'string') return;
    const trimmed = subjectValue.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const prefix = trimmed.slice(0, colonIdx).trim();
      const suffix = trimmed.slice(colonIdx + 1).trim();
      if (
        prefix &&
        !['mcp', 'onchain', 'account', 'agent', 'workflow', 'near'].includes(prefix.toLowerCase())
      ) {
        provider ??= prefix;
        model ??= suffix || undefined;
      }
    }
  };

  parseSubjectPair(receiptObj.subject);

  if ((!provider || !model) && Array.isArray(receiptObj.bills)) {
    for (const bill of receiptObj.bills) {
      if (!bill || typeof bill !== 'object') continue;
      const b = bill as Record<string, unknown>;
      if (typeof b.provider === 'string' && b.provider.trim()) {
        provider ??= b.provider.trim();
      }
      if (typeof b.model === 'string' && b.model.trim()) {
        model ??= b.model.trim();
      }
      parseSubjectPair(b.subject);
      if (Array.isArray(b.children)) {
        for (const child of b.children) {
          if (child && typeof child === 'object') {
            const cb = child as Record<string, unknown>;
            if (typeof cb.provider === 'string' && cb.provider.trim()) {
              provider ??= cb.provider.trim();
            }
            if (typeof cb.model === 'string' && cb.model.trim()) {
              model ??= cb.model.trim();
            }
            parseSubjectPair(cb.subject);
          }
        }
      }
    }
  }

  const requestId =
    (typeof receiptObj.executionRunId === 'string' && receiptObj.executionRunId.trim()) ||
    (typeof receiptObj.id === 'string' && receiptObj.id.trim()) ||
    (typeof receiptObj.rootRunId === 'string' && receiptObj.rootRunId.trim()) ||
    undefined;

  return {
    billWei,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function extractReceiptMeta(
  response: Response,
  body?: Record<string, unknown> | null,
): ReceiptMeta {
  const receiptHeader = response.headers.get('x-receipt') ?? response.headers.get('X-Receipt');
  const headerReqId =
    response.headers.get('x-request-id') ?? response.headers.get('x-execution-run-id') ?? undefined;
  if (receiptHeader) {
    try {
      const normalizedB64 = receiptHeader.replace(/-/g, '+').replace(/_/g, '/');
      const paddedB64 = normalizedB64 + '='.repeat((4 - (normalizedB64.length % 4)) % 4);
      const decoded = JSON.parse(Buffer.from(paddedB64, 'base64').toString('utf8')) as Record<
        string,
        unknown
      >;
      const meta = extractMetaFromReceiptPayload(decoded);
      if (meta.billWei > 0n || meta.provider || meta.model) {
        return {
          ...meta,
          ...(meta.requestId ? {} : headerReqId ? { requestId: headerReqId } : {}),
        };
      }
    } catch {
      // Fall through to JSON body inspection
    }
  }

  if (body && typeof body === 'object') {
    const receiptObj =
      (body.receipt && typeof body.receipt === 'object'
        ? (body.receipt as Record<string, unknown>)
        : null) ??
      (body.compose &&
        typeof body.compose === 'object' &&
        (body.compose as Record<string, unknown>).receipt &&
        typeof (body.compose as Record<string, unknown>).receipt === 'object'
        ? ((body.compose as Record<string, unknown>).receipt as Record<string, unknown>)
        : null);

    if (receiptObj) {
      const meta = extractMetaFromReceiptPayload(receiptObj);
      return {
        ...meta,
        ...(meta.requestId
          ? {}
          : typeof body.id === 'string' && body.id
            ? { requestId: body.id }
            : headerReqId
              ? { requestId: headerReqId }
              : {}),
      };
    }
  }

  return {
    billWei: 0n,
    ...(typeof body?.id === 'string' && body.id
      ? { requestId: body.id }
      : headerReqId
        ? { requestId: headerReqId }
        : {}),
  };
}

export function extractReceiptBillWei(
  response: Response,
  body?: Record<string, unknown> | null,
): bigint {
  return extractReceiptMeta(response, body).billWei;
}
