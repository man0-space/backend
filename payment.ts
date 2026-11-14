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
export const VIBE_PRICE_WEI = 20_000n;
export const BANNER_PRICE_WEI = 30_000n;

export interface MeterLineItem {
  key: string;
  unit: string;
  quantity: number;
  unitPriceUsd: number;
  amountWei: string;
}

export interface FixedChargeSpec {
  service: 'vibe' | 'banner';
  action: string;
  amountWei: bigint;
  meterSubject: string;
  lineItems: MeterLineItem[];
}

export const VIBE_CHARGE_SPEC: FixedChargeSpec = {
  service: 'vibe',
  action: 'generate',
  amountWei: VIBE_PRICE_WEI,
  meterSubject: 'vibe',
  lineItems: [
    {
      key: 'turn',
      unit: 'request',
      quantity: 1,
      unitPriceUsd: 0.02,
      amountWei: VIBE_PRICE_WEI.toString(),
    },
  ],
};

export const BANNER_CHARGE_SPEC: FixedChargeSpec = {
  service: 'banner',
  action: 'generate',
  amountWei: BANNER_PRICE_WEI,
  meterSubject: 'banner',
  lineItems: [
    {
      key: 'image',
      unit: 'image',
      quantity: 1,
      unitPriceUsd: 0.03,
      amountWei: BANNER_PRICE_WEI.toString(),
    },
  ],
};

export interface Charge {
  service?: 'workflow' | 'vibe' | 'banner';
  action: string;
  meterSubject?: string;
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
  service: 'workflow' | 'vibe' | 'banner';
  action: string;
  meterSubject: string;
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
  isSelfRecipient: boolean,
): Split {
  const normalizedBill = composeBillWei > 0n ? composeBillWei : 0n;
  if (creatorFeePercent === 0) {
    const platformFeeWei = ceilPercent(normalizedBill, PLATFORM_FEE_PERCENT);
    return {
      composeBillWei: normalizedBill,
      creatorFeePercent: 0,
      creatorFeeWei: 0n,
      platformFeePercent: PLATFORM_FEE_PERCENT,
      platformFeeWei,
      serviceFeeWei: platformFeeWei,
      totalChargedWei: normalizedBill + platformFeeWei,
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
  const effectiveCreatorPercent = isSelfRecipient ? 0 : creatorFeePercent;
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
    receiptObj.service === 'agent' ||
    receiptObj.service === 'runtime' ||
    (Array.isArray(receiptObj.bills) &&
      receiptObj.bills.some(
        b =>
          Boolean(b && typeof b === 'object') &&
          ((b as Record<string, unknown>).kind === 'agent' ||
            (b as Record<string, unknown>).source === 'agent' ||
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

function buildPaymentRequiredHeader(input: {
  resource: string;
  targetChain: FacilitatorChain;
  maxAmountWei: string;
  treasuryAddress: string;
  creatorRecipientAddress: string;
  description: string;
}): string {
  const payload = {
    x402Version: 2,
    error: 'Payment Required',
    resource: {
      url: input.resource,
      description: input.description,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'upto',
        network: input.targetChain.network,
        amount: input.maxAmountWei,
        maxAmountRequired: input.maxAmountWei,
        asset: input.targetChain.assetAddress,
        payTo: input.treasuryAddress,
        maxTimeoutSeconds: 300,
        extra: {
          royalties: {
            creator: input.creatorRecipientAddress,
            treasury: input.treasuryAddress,
          },
        },
      },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function resolveRequestResourceUrl(request: FastifyRequest): string {
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol ?? 'https';
  const host = request.headers.host ?? 'localhost';
  return `${proto}://${host}${request.url}`;
}

export function getPaymentContext(request: FastifyRequest): Payer | null {
  return (request as unknown as { paymentContext?: Payer }).paymentContext ?? null;
}

export function requireSessionPayment(
  resolveConfig: (request: FastifyRequest) => Promise<Charge | null> | Charge | null,
  options: { fetchImpl?: typeof fetch } = {},
) {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const paymentConfig = await resolveConfig(request);
    if (!paymentConfig) {
      return;
    }

    const composeUrl = config.composeApiUrl;
    const requestedNetwork =
      (request.headers['x-network-id'] as string | undefined)?.trim() ||
      (request.headers['x-network'] as string | undefined)?.trim() ||
      (request.headers['x-chain-id'] as string | undefined)?.trim();

    const maxAmountWei = paymentConfig.maxAmountWei ?? DEFAULT_AUTHORIZATION_BUDGET_WEI;
    const resourceUrl = resolveRequestResourceUrl(request);
    const runId = (request.headers['x-run-id'] as string | undefined)?.trim() || randomUUID();

    const sessionToken = extractSessionToken(request);
    const paymentSignature = extractPaymentSignature(request);

    if (!sessionToken && !paymentSignature) {
      const challengeNetworkId = requestedNetwork || `near:${config.network}`;
      const targetChain = await chain(challengeNetworkId, fetchFn);
      const treasuryAddress = treasury(targetChain);
      const creatorRecipientAddress = await creator(paymentConfig.creatorUserAddress, targetChain);
      const paymentRequiredB64 = buildPaymentRequiredHeader({
        resource: resourceUrl,
        targetChain,
        maxAmountWei,
        treasuryAddress,
        creatorRecipientAddress,
        description: `man0 ${paymentConfig.action}`,
      });
      reply.header('PAYMENT-REQUIRED', paymentRequiredB64);
      reply.code(402).send({
        error:
          'Payment Required: Active session or x402 PAYMENT-SIGNATURE header is required.',
      });
      return;
    }

    if (sessionToken) {
      const parsed = parseComposeToken(sessionToken);
      if (!parsed || !parsed.sub) {
        reply.code(401).send({ error: 'Invalid session token format.' });
        return;
      }
      if (parsed.exp && parsed.exp * 1000 < Date.now()) {
        reply.code(401).send({ error: 'session token has expired.' });
        return;
      }

      const tokenNetworkId = parsed.network?.trim() || requestedNetwork;
      if (!tokenNetworkId) {
        reply.code(400).send({ error: 'session token is missing network identifier.' });
        return;
      }
      const targetChain = await chain(tokenNetworkId, fetchFn);
      const network = targetChain.network;
      const treasuryAddress = treasury(targetChain);
      const creatorRecipientAddress = await creator(paymentConfig.creatorUserAddress, targetChain);

      let canonicalUserAddress = await resolveMainUserAddress(parsed.sub);
      if (canonicalUserAddress === parsed.sub) {
        const rawAuth = request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice(7).trim()
          : '';
        if (rawAuth && !rawAuth.startsWith('compose-')) {
          const verified = await authToken.read(rawAuth).catch(() => null);
          if (verified?.userAddress) {
            canonicalUserAddress = verified.userAddress;
          }
        }
      }
      const callerHeader = (
        request.headers['x-session-user-address'] as string | undefined
      )?.trim();
      if (callerHeader && callerHeader !== parsed.sub && callerHeader !== canonicalUserAddress) {
        reply.code(403).send({
          error: 'x-session-user-address does not match session token subject.',
        });
        return;
      }

      const serviceName = paymentConfig.service ?? 'workflow';
      const meterSubject = paymentConfig.meterSubject?.trim() || serviceName;
      const idempotencyKey = `${serviceName}:${paymentConfig.action}:${parsed.keyId ?? parsed.sub}:${runId}`;
      const prepareRes = await fetchFn(`${composeUrl}/api/payments/prepare`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
          'x-network-id': network,
          'x-session-user-address': parsed.sub,
        },
        body: JSON.stringify({
          service: serviceName,
          action: paymentConfig.action,
          meterSubject,
          resource: resourceUrl,
          method: request.method,
          maxAmountWei,
          payTo: treasuryAddress,
          royalties: {
            creator: creatorRecipientAddress,
            treasury: treasuryAddress,
          },
          runId,
          rootRunId: runId,
          idempotencyKey,
        }),
      });

      const preparePayload = (await prepareRes.json().catch(() => ({}))) as {
        paymentIntentId?: string;
        userAddress?: string;
        error?: string;
      };

      const requiredHeader =
        prepareRes.headers.get('payment-required') ?? prepareRes.headers.get('PAYMENT-REQUIRED');
      if (requiredHeader) {
        reply.header('PAYMENT-REQUIRED', requiredHeader);
      }

      if (!prepareRes.ok || !preparePayload.paymentIntentId) {
        reply.code(prepareRes.status || 402).send({
          error: preparePayload.error || 'Payment preparation failed.',
        });
        return;
      }

      const sessionSubject = preparePayload.userAddress ?? parsed.sub;
      let resolvedCanonical = await resolveMainUserAddress(sessionSubject);
      if (resolvedCanonical === sessionSubject && canonicalUserAddress !== parsed.sub) {
        resolvedCanonical = canonicalUserAddress;
      }
      request.headers['x-session-user-address'] = sessionSubject;
      request.headers['x-network-id'] = network;
      request.headers['x-run-id'] = runId;

      (request as unknown as { paymentContext: Payer }).paymentContext = {
        mode: 'session',
        paymentIntentId: preparePayload.paymentIntentId,
        userAddress: resolvedCanonical,
        sessionSubject,
        network,
        token: sessionToken,
        creatorUserAddress: paymentConfig.creatorUserAddress,
        creatorRecipientAddress,
        creatorFeePercent: paymentConfig.creatorFeePercent,
        treasuryAddress,
        service: serviceName,
        action: paymentConfig.action,
        meterSubject,
        runId,
      };
      return;
    }

    let paymentPayload: Record<string, unknown>;
    try {
      const decoded = Buffer.from(paymentSignature!, 'base64').toString('utf8');
      paymentPayload = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      reply.code(400).send({ error: 'Invalid base64 PAYMENT-SIGNATURE header.' });
      return;
    }

    const acceptedObj = paymentPayload.accepted as { network?: string } | undefined;
    const x402NetworkId =
      acceptedObj?.network?.trim() ||
      (typeof paymentPayload.network === 'string' ? paymentPayload.network.trim() : '') ||
      requestedNetwork;
    if (!x402NetworkId) {
      reply.code(400).send({ error: 'x402 payment payload is missing network identifier.' });
      return;
    }

    const targetChain = await chain(x402NetworkId, fetchFn);
    const network = targetChain.network;
    const treasuryAddress = treasury(targetChain);
    const creatorRecipientAddress = await creator(paymentConfig.creatorUserAddress, targetChain);

    const paymentRequirements: Record<string, unknown> = {
      scheme: 'upto',
      network,
      amount: maxAmountWei,
      maxAmountRequired: maxAmountWei,
      resource: resourceUrl,
      description: `man0 ${paymentConfig.action}`,
      mimeType: 'application/json',
      payTo: treasuryAddress,
      maxTimeoutSeconds: 300,
      asset: targetChain.assetAddress,
      extra: {
        royalties: {
          creator: creatorRecipientAddress,
          treasury: treasuryAddress,
        },
      },
    };

    const verifyRes = await fetchFn(`${composeUrl}/api/x402/facilitator/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-network-id': network,
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });

    const verifyBody = (await verifyRes.json().catch(() => ({}))) as {
      isValid?: boolean;
      invalidReason?: string;
      payer?: string;
      error?: string;
    };

    if (!verifyRes.ok || !verifyBody.isValid || !verifyBody.payer) {
      const paymentRequiredB64 = buildPaymentRequiredHeader({
        resource: resourceUrl,
        targetChain,
        maxAmountWei,
        treasuryAddress,
        creatorRecipientAddress,
        description: `man0 ${paymentConfig.action}`,
      });
      reply.header('PAYMENT-REQUIRED', paymentRequiredB64);
      reply.code(402).send({
        error:
          verifyBody.invalidReason ?? verifyBody.error ?? 'x402 payment verification failed.',
      });
      return;
    }

    const canonicalPayer = await resolveMainUserAddress(verifyBody.payer);
    request.headers['x-session-user-address'] = verifyBody.payer;
    request.headers['x-network-id'] = network;
    request.headers['x-run-id'] = runId;

    const serviceName = paymentConfig.service ?? 'workflow';
    const meterSubject = paymentConfig.meterSubject?.trim() || serviceName;

    (request as unknown as { paymentContext: Payer }).paymentContext = {
      mode: 'x402',
      paymentPayload,
      paymentRequirements,
      userAddress: canonicalPayer,
      sessionSubject: verifyBody.payer,
      network,
      creatorUserAddress: paymentConfig.creatorUserAddress,
      creatorRecipientAddress,
      creatorFeePercent: paymentConfig.creatorFeePercent,
      treasuryAddress,
      service: serviceName,
      action: paymentConfig.action,
      meterSubject,
      runId,
    };
  };
}

export async function abortWorkflowPayment(
  request: FastifyRequest,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ctx = getPaymentContext(request);
  if (!ctx || ctx.mode !== 'session' || !ctx.paymentIntentId) {
    return;
  }
  await fetchImpl(`${config.composeApiUrl}/api/payments/abort`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-network-id': ctx.network,
    },
    body: JSON.stringify({
      paymentIntentId: ctx.paymentIntentId,
      reason,
    }),
  }).catch(() => undefined);
}

export async function settleWorkflowPayment(
  request: FastifyRequest,
  reply: FastifyReply,
  composeBillWei: bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<Settlement> {
  const ctx = getPaymentContext(request);
  if (!ctx) {
    throw Object.assign(new Error('Missing prepared workflow payment context.'), {
      statusCode: 402,
    });
  }

  const isSelfRecipient = Boolean(
    ctx.sessionSubject &&
    ctx.creatorRecipientAddress &&
    ctx.sessionSubject.toLowerCase() === ctx.creatorRecipientAddress.toLowerCase(),
  );
  const fees = computeWorkflowServiceFees(composeBillWei, ctx.creatorFeePercent, isSelfRecipient);

  if (fees.serviceFeeWei === 0n || (!ctx.paymentIntentId && ctx.mode === 'session')) {
    if (ctx.mode === 'session' && ctx.paymentIntentId) {
      await abortWorkflowPayment(request, 'zero_service_fee', fetchImpl);
    }
    return {
      settled: true,
      status: 'exempt',
      txHash: null,
      paymentIntentId: ctx.paymentIntentId ?? null,
      composeBillWei: fees.composeBillWei.toString(),
      creatorFeePercent: fees.creatorFeePercent,
      creatorFeeWei: fees.creatorFeeWei.toString(),
      platformFeePercent: fees.platformFeePercent,
      platformFeeWei: fees.platformFeeWei.toString(),
      serviceFeeWei: fees.serviceFeeWei.toString(),
      totalChargedWei: fees.totalChargedWei.toString(),
    };
  }

  if (
    fetchImpl === globalThis.fetch &&
    ctx.network.startsWith('near:') &&
    fees.creatorFeeWei > 0n &&
    ctx.creatorRecipientAddress &&
    ctx.creatorRecipientAddress !== ctx.treasuryAddress
  ) {
    const nearNet = ctx.network === 'near:testnet' ? 'testnet' : 'mainnet';
    await ensureFtStorageDeposit(
      rpcFor(nearNet),
      usdcFor(nearNet),
      ctx.creatorRecipientAddress,
      nearNet,
    ).catch(() => undefined);
  }

  const lineItems: MeterLineItem[] = [
    ...(fees.creatorFeeWei > 0n
      ? [
        {
          key: 'royalty',
          unit: 'percent',
          quantity: fees.creatorFeePercent,
          unitPriceUsd:
            Number(fees.creatorFeeWei) / (1_000_000 * Math.max(1, fees.creatorFeePercent)),
          amountWei: fees.creatorFeeWei.toString(),
        },
      ]
      : []),
    ...(fees.platformFeeWei > 0n
      ? [
        {
          key: 'treasury',
          unit: 'percent',
          quantity: fees.platformFeePercent,
          unitPriceUsd:
            Number(fees.platformFeeWei) / (1_000_000 * Math.max(1, fees.platformFeePercent)),
          amountWei: fees.platformFeeWei.toString(),
        },
      ]
      : []),
  ];

  if (ctx.mode === 'session') {
    const settleRes = await fetchImpl(`${config.composeApiUrl}/api/payments/settle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-network-id': ctx.network,
        ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
      },
      body: JSON.stringify({
        paymentIntentId: ctx.paymentIntentId,
        finalAmountWei: fees.serviceFeeWei.toString(),
        ...(fees.creatorFeeWei > 0n ? { providerAmountWei: fees.creatorFeeWei.toString() } : {}),
        ...(fees.platformFeeWei > 0n ? { platformFeeWei: fees.platformFeeWei.toString() } : {}),
        executeImmediately: true,
        meterSubject: ctx.meterSubject || 'workflow',
        lineItems,
        royalties: {
          ...(fees.creatorFeeWei > 0n && ctx.creatorRecipientAddress
            ? { creator: ctx.creatorRecipientAddress }
            : {}),
          treasury: ctx.treasuryAddress,
        },
      }),
    });

    const settlePayload = (await settleRes.json().catch(() => ({}))) as {
      status?: string;
      txHash?: string;
      paymentIntentId?: string;
      error?: string;
    };

    if (!settleRes.ok) {
      throw Object.assign(
        new Error(settlePayload.error || 'Workflow fee settlement failed.'),
        { statusCode: settleRes.status || 402 },
      );
    }

    if (settlePayload.txHash) {
      reply.header('X-Transaction-Hash', settlePayload.txHash);
    }

    return {
      settled: true,
      status: settlePayload.status ?? 'confirmed',
      txHash: settlePayload.txHash ?? null,
      paymentIntentId: settlePayload.paymentIntentId ?? ctx.paymentIntentId ?? null,
      composeBillWei: fees.composeBillWei.toString(),
      creatorFeePercent: fees.creatorFeePercent,
      creatorFeeWei: fees.creatorFeeWei.toString(),
      platformFeePercent: fees.platformFeePercent,
      platformFeeWei: fees.platformFeeWei.toString(),
      serviceFeeWei: fees.serviceFeeWei.toString(),
      totalChargedWei: fees.totalChargedWei.toString(),
    };
  }

  const updatedRequirements: Record<string, unknown> = {
    ...(ctx.paymentRequirements ?? {}),
    amount: fees.serviceFeeWei.toString(),
    maxAmountRequired: fees.serviceFeeWei.toString(),
    extra: {
      service: ctx.service,
      ...(fees.creatorFeeWei > 0n ? { providerAmountWei: fees.creatorFeeWei.toString() } : {}),
      ...(fees.platformFeeWei > 0n ? { platformFeeWei: fees.platformFeeWei.toString() } : {}),
      royalties: {
        ...(fees.creatorFeeWei > 0n && ctx.creatorRecipientAddress
          ? { creator: ctx.creatorRecipientAddress }
          : {}),
        treasury: ctx.treasuryAddress,
      },
    },
  };

  const settleRes = await fetchImpl(`${config.composeApiUrl}/api/x402/facilitator/settle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-network-id': ctx.network,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: ctx.paymentPayload,
      paymentRequirements: updatedRequirements,
    }),
  });

  const settleBody = (await settleRes.json().catch(() => ({}))) as {
    success?: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    errorReason?: string;
    error?: string;
  };

  if (!settleRes.ok || !settleBody.success) {
    throw Object.assign(
      new Error(
        settleBody.errorReason ?? settleBody.error ?? 'x402 facilitator settlement failed.',
      ),
      { statusCode: 402 },
    );
  }

  const paymentResponseB64 = Buffer.from(JSON.stringify(settleBody), 'utf8').toString('base64');
  reply.header('PAYMENT-RESPONSE', paymentResponseB64);
  if (settleBody.transaction) {
    reply.header('X-Transaction-Hash', settleBody.transaction);
  }

  return {
    settled: true,
    status: 'confirmed',
    txHash: settleBody.transaction ?? null,
    paymentIntentId: null,
    composeBillWei: fees.composeBillWei.toString(),
    creatorFeePercent: fees.creatorFeePercent,
    creatorFeeWei: fees.creatorFeeWei.toString(),
    platformFeePercent: fees.platformFeePercent,
    platformFeeWei: fees.platformFeeWei.toString(),
    serviceFeeWei: fees.serviceFeeWei.toString(),
    totalChargedWei: fees.totalChargedWei.toString(),
  };
}

export interface PreparedFixedCharge {
  spec: FixedChargeSpec;
  mode: 'session' | 'x402';
  network: PaymentNetwork;
  treasuryAddress: string;
  token?: string;
  sessionSubject?: string;
  keyId?: string;
  paymentIntentId?: string;
  paymentPayload?: Record<string, unknown>;
  paymentRequirements?: Record<string, unknown>;
  runId: string;
  resourceUrl: string;
  settled: boolean;
  aborted: boolean;
}

export async function prepareFixedCharge(
  request: FastifyRequest,
  reply: FastifyReply,
  spec: FixedChargeSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedFixedCharge | null> {
  const composeUrl = config.composeApiUrl;
  const requestedNetwork =
    (request.headers['x-network-id'] as string | undefined)?.trim() ||
    (request.headers['x-network'] as string | undefined)?.trim() ||
    (request.headers['x-chain-id'] as string | undefined)?.trim();
  const amountStr = spec.amountWei.toString();
  const resourceUrl = resolveRequestResourceUrl(request);
  const runId = (request.headers['x-run-id'] as string | undefined)?.trim() || randomUUID();

  const sessionToken = extractSessionToken(request);
  const paymentSignature = extractPaymentSignature(request);

  if (!sessionToken && !paymentSignature) {
    const challengeNetworkId = requestedNetwork || `near:${config.network}`;
    const targetChain = await chain(challengeNetworkId, fetchImpl);
    const treasuryAddress = treasury(targetChain);
    const paymentRequiredB64 = buildPaymentRequiredHeader({
      resource: resourceUrl,
      targetChain,
      maxAmountWei: amountStr,
      treasuryAddress,
      creatorRecipientAddress: treasuryAddress,
      description: `${spec.service} ${spec.action}`,
    });
    reply.header('PAYMENT-REQUIRED', paymentRequiredB64);
    reply.code(402).send({
      error: 'Payment Required: Active session or x402 PAYMENT-SIGNATURE header is required.',
    });
    return null;
  }

  if (sessionToken) {
    const parsed = parseComposeToken(sessionToken);
    if (!parsed || !parsed.sub) {
      reply.code(401).send({ error: 'Invalid session token format.' });
      return null;
    }
    if (parsed.exp && parsed.exp * 1000 < Date.now()) {
      reply.code(401).send({ error: 'session token has expired.' });
      return null;
    }
    const tokenNetworkId = parsed.network?.trim() || requestedNetwork;
    if (!tokenNetworkId) {
      reply.code(400).send({ error: 'session token is missing network identifier.' });
      return null;
    }
    const targetChain = await chain(tokenNetworkId, fetchImpl);
    const network = targetChain.network;
    const treasuryAddress = treasury(targetChain);
    const idempotencyKey = `${spec.service}:${spec.action}:${parsed.keyId ?? parsed.sub}:${runId}`;

    const prepareRes = await fetchImpl(`${composeUrl}/api/payments/prepare`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json',
        'x-network-id': network,
        'x-session-user-address': parsed.sub,
      },
      body: JSON.stringify({
        service: spec.service,
        action: spec.action,
        meterSubject: spec.meterSubject,
        lineItems: spec.lineItems,
        resource: resourceUrl,
        method: request.method,
        maxAmountWei: amountStr,
        payTo: treasuryAddress,
        royalties: { treasury: treasuryAddress },
        runId,
        rootRunId: runId,
        idempotencyKey,
      }),
    });

    const preparePayload = (await prepareRes.json().catch(() => ({}))) as {
      paymentIntentId?: string;
      userAddress?: string;
      error?: string;
    };

    const requiredHeader =
      prepareRes.headers.get('payment-required') ?? prepareRes.headers.get('PAYMENT-REQUIRED');
    if (requiredHeader) {
      reply.header('PAYMENT-REQUIRED', requiredHeader);
    }

    if (!prepareRes.ok || !preparePayload.paymentIntentId) {
      reply.code(prepareRes.status || 402).send({
        error: preparePayload.error || 'Payment preparation failed.',
      });
      return null;
    }

    return {
      spec,
      mode: 'session',
      network,
      treasuryAddress,
      token: sessionToken,
      sessionSubject: preparePayload.userAddress ?? parsed.sub,
      keyId: parsed.keyId ?? parsed.sub,
      paymentIntentId: preparePayload.paymentIntentId,
      runId,
      resourceUrl,
      settled: false,
      aborted: false,
    };
  }

  let paymentPayload: Record<string, unknown>;
  try {
    const decoded = Buffer.from(paymentSignature!, 'base64').toString('utf8');
    paymentPayload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    reply.code(400).send({ error: 'Invalid base64 PAYMENT-SIGNATURE header.' });
    return null;
  }

  const acceptedObj = paymentPayload.accepted as { network?: string } | undefined;
  const x402NetworkId =
    acceptedObj?.network?.trim() ||
    (typeof paymentPayload.network === 'string' ? paymentPayload.network.trim() : '') ||
    requestedNetwork;
  if (!x402NetworkId) {
    reply.code(400).send({ error: 'x402 payment payload is missing network identifier.' });
    return null;
  }

  const targetChain = await chain(x402NetworkId, fetchImpl);
  const network = targetChain.network;
  const treasuryAddress = treasury(targetChain);
  const paymentRequirements: Record<string, unknown> = {
    scheme: 'exact',
    network,
    amount: amountStr,
    maxAmountRequired: amountStr,
    resource: resourceUrl,
    description: `${spec.service} ${spec.action}`,
    mimeType: 'application/json',
    payTo: treasuryAddress,
    maxTimeoutSeconds: 300,
    asset: targetChain.assetAddress,
    extra: {
      service: spec.service,
      royalties: { treasury: treasuryAddress },
    },
  };

  const verifyRes = await fetchImpl(`${composeUrl}/api/x402/facilitator/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-network-id': network,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    }),
  });
  const verifyBody = (await verifyRes.json().catch(() => ({}))) as {
    isValid?: boolean;
    invalidReason?: string;
    payer?: string;
    error?: string;
  };
  if (!verifyRes.ok || !verifyBody.isValid || !verifyBody.payer) {
    const paymentRequiredB64 = buildPaymentRequiredHeader({
      resource: resourceUrl,
      targetChain,
      maxAmountWei: amountStr,
      treasuryAddress,
      creatorRecipientAddress: treasuryAddress,
      description: `${spec.service} ${spec.action}`,
    });
    reply.header('PAYMENT-REQUIRED', paymentRequiredB64);
    reply.code(402).send({
      error: verifyBody.invalidReason ?? verifyBody.error ?? 'x402 payment verification failed.',
    });
    return null;
  }

  return {
    spec,
    mode: 'x402',
    network,
    treasuryAddress,
    sessionSubject: verifyBody.payer,
    paymentPayload,
    paymentRequirements,
    runId,
    resourceUrl,
    settled: false,
    aborted: false,
  };
}

export async function abortPreparedFixedCharge(
  charge: PreparedFixedCharge,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (charge.settled || charge.aborted) return;
  charge.aborted = true;
  if (charge.mode !== 'session' || !charge.paymentIntentId) return;
  await fetchImpl(`${config.composeApiUrl}/api/payments/abort`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-network-id': charge.network,
    },
    body: JSON.stringify({
      paymentIntentId: charge.paymentIntentId,
      reason,
    }),
  }).catch(() => undefined);
}

export async function settlePreparedFixedCharge(
  charge: PreparedFixedCharge,
  reply?: FastifyReply,
  fetchImpl: typeof fetch = fetch,
): Promise<{ txHash: string | null }> {
  if (charge.settled || charge.aborted) {
    return { txHash: null };
  }
  charge.settled = true;
  const amountStr = charge.spec.amountWei.toString();

  if (charge.mode === 'session') {
    const settleRes = await fetchImpl(`${config.composeApiUrl}/api/payments/settle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-network-id': charge.network,
        ...(charge.token ? { authorization: `Bearer ${charge.token}` } : {}),
      },
      body: JSON.stringify({
        paymentIntentId: charge.paymentIntentId,
        finalAmountWei: amountStr,
        providerAmountWei: amountStr,
        executeImmediately: true,
        meterSubject: charge.spec.meterSubject,
        lineItems: charge.spec.lineItems,
        royalties: { treasury: charge.treasuryAddress },
      }),
    });
    const settlePayload = (await settleRes.json().catch(() => ({}))) as {
      txHash?: string;
      error?: string;
    };
    if (!settleRes.ok) {
      charge.settled = false;
      throw Object.assign(
        new Error(settlePayload.error || `${charge.spec.service} payment settlement failed.`),
        { statusCode: settleRes.status || 402 },
      );
    }
    if (reply && !reply.sent && settlePayload.txHash) {
      reply.header('X-Transaction-Hash', settlePayload.txHash);
    }
    return { txHash: settlePayload.txHash ?? null };
  }

  const settleRes = await fetchImpl(`${config.composeApiUrl}/api/x402/facilitator/settle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-network-id': charge.network,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: charge.paymentPayload,
      paymentRequirements: charge.paymentRequirements,
    }),
  });
  const settleBody = (await settleRes.json().catch(() => ({}))) as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
    error?: string;
  };
  if (!settleRes.ok || !settleBody.success) {
    charge.settled = false;
    throw Object.assign(
      new Error(settleBody.errorReason ?? settleBody.error ?? 'x402 settlement failed.'),
      { statusCode: 402 },
    );
  }
  if (reply && !reply.sent) {
    reply.header('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settleBody), 'utf8').toString('base64'));
    if (settleBody.transaction) {
      reply.header('X-Transaction-Hash', settleBody.transaction);
    }
  }
  return { txHash: settleBody.transaction ?? null };
}

export async function runWithChildSessionCharge<T>(
  parent: PreparedFixedCharge,
  spec: FixedChargeSpec,
  work: () => Promise<T>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (parent.mode !== 'session' || !parent.token || !parent.sessionSubject) {
    return work();
  }
  const amountStr = spec.amountWei.toString();
  const childExecId = `${parent.runId}:${spec.service}:${randomUUID().slice(0, 8)}`;
  const prepareRes = await fetchImpl(`${config.composeApiUrl}/api/payments/prepare`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${parent.token}`,
      'content-type': 'application/json',
      'x-network-id': parent.network,
      'x-session-user-address': parent.sessionSubject,
    },
    body: JSON.stringify({
      service: spec.service,
      action: spec.action,
      meterSubject: spec.meterSubject,
      lineItems: spec.lineItems,
      resource: parent.resourceUrl.replace(/\/api\/[^/?#]+$/, `/api/generate-${spec.service}`),
      method: 'POST',
      maxAmountWei: amountStr,
      payTo: parent.treasuryAddress,
      royalties: { treasury: parent.treasuryAddress },
      runId: parent.runId,
      rootRunId: parent.runId,
      executionRunId: childExecId,
      idempotencyKey: `${spec.service}:${spec.action}:${parent.keyId ?? parent.sessionSubject}:${childExecId}`,
    }),
  });
  const preparePayload = (await prepareRes.json().catch(() => ({}))) as {
    paymentIntentId?: string;
    error?: string;
  };
  if (!prepareRes.ok || !preparePayload.paymentIntentId) {
    throw Object.assign(
      new Error(preparePayload.error || `${spec.service} payment preparation failed.`),
      { statusCode: prepareRes.status || 402 },
    );
  }
  const childCharge: PreparedFixedCharge = {
    spec,
    mode: 'session',
    network: parent.network,
    treasuryAddress: parent.treasuryAddress,
    token: parent.token,
    sessionSubject: parent.sessionSubject,
    keyId: parent.keyId,
    paymentIntentId: preparePayload.paymentIntentId,
    runId: parent.runId,
    resourceUrl: parent.resourceUrl,
    settled: false,
    aborted: false,
  };
  try {
    const out = await work();
    await settlePreparedFixedCharge(childCharge, undefined, fetchImpl);
    return out;
  } catch (err) {
    await abortPreparedFixedCharge(childCharge, `${spec.service}_failed`, fetchImpl);
    throw err;
  }
}
