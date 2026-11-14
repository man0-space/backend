import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ceilPercent,
  computeWorkflowServiceFees,
  extractMetaFromReceiptPayload,
  extractReceiptBillWei,
  extractSessionToken,
  usdcToWei,
  weiToUsdc,
} from '../payment.js';
import type { FastifyRequest } from 'fastify';

test('ceilPercent and computeWorkflowServiceFees calculate creatorFee (1-3%) and platformFee (2%) on top of composeBillWei', () => {
  assert.equal(ceilPercent(0n, 2), 0n);
  assert.equal(ceilPercent(100_000n, 1), 1_000n);
  assert.equal(ceilPercent(100_000n, 2), 2_000n);
  assert.equal(ceilPercent(100_000n, 3), 3_000n);
  assert.equal(ceilPercent(101n, 2), 3n);

  const nonCreator = computeWorkflowServiceFees(100_000n, 3, false);
  assert.equal(nonCreator.composeBillWei, 100_000n);
  assert.equal(nonCreator.creatorFeePercent, 3);
  assert.equal(nonCreator.creatorFeeWei, 3_000n);
  assert.equal(nonCreator.platformFeePercent, 2);
  assert.equal(nonCreator.platformFeeWei, 2_000n);
  assert.equal(nonCreator.serviceFeeWei, 5_000n);
  assert.equal(nonCreator.totalChargedWei, 105_000n);

  const creatorSelf = computeWorkflowServiceFees(100_000n, 3, true);
  assert.equal(creatorSelf.composeBillWei, 100_000n);
  assert.equal(creatorSelf.creatorFeePercent, 0);
  assert.equal(creatorSelf.creatorFeeWei, 0n);
  assert.equal(creatorSelf.platformFeePercent, 2);
  assert.equal(creatorSelf.platformFeeWei, 2_000n);
  assert.equal(creatorSelf.serviceFeeWei, 2_000n);
  assert.equal(creatorSelf.totalChargedWei, 102_000n);

  const draftRun = computeWorkflowServiceFees(100_000n, 0, false);
  assert.equal(draftRun.composeBillWei, 100_000n);
  assert.equal(draftRun.creatorFeePercent, 0);
  assert.equal(draftRun.creatorFeeWei, 0n);
  assert.equal(draftRun.platformFeePercent, 2);
  assert.equal(draftRun.platformFeeWei, 2_000n);
  assert.equal(draftRun.serviceFeeWei, 2_000n);
  assert.equal(draftRun.totalChargedWei, 102_000n);

  assert.throws(() => computeWorkflowServiceFees(100_000n, -1, false), /between 1% and 3%/);
  assert.throws(() => computeWorkflowServiceFees(100_000n, 4, false), /between 1% and 3%/);
});

test('extractReceiptBillWei reads authoritative compose.market X-Receipt header and JSON receipt', () => {
  const receiptB64 = Buffer.from(
    JSON.stringify({
      finalAmountWei: '42500',
      providerAmountWei: '42079',
      platformFeeWei: '421',
    }),
    'utf8',
  ).toString('base64');

  const responseWithHeader = new Response('{}', {
    status: 200,
    headers: { 'X-Receipt': receiptB64 },
  });
  assert.equal(extractReceiptBillWei(responseWithHeader, {}), 42_500n);

  const responseWithBody = new Response('{}', { status: 200 });
  assert.equal(
    extractReceiptBillWei(responseWithBody, {
      receipt: { final_amount_wei: '19800' },
    }),
    19_800n,
  );

  assert.equal(usdcToWei('0.125'), '125000');
  assert.equal(weiToUsdc(125_000n), '0.125000');
});

test('extractSessionToken accepts both x-compose-key and Authorization Bearer compose-*', () => {
  const withComposeKey = {
    headers: {
      authorization: 'Bearer man0-user-jwt',
      'x-compose-key': 'compose-abc.def.ghi',
    },
  } as unknown as FastifyRequest;
  assert.equal(extractSessionToken(withComposeKey), 'compose-abc.def.ghi');

  const withBearerCompose = {
    headers: {
      authorization: 'Bearer compose-xyz.123.456',
    },
  } as unknown as FastifyRequest;
  assert.equal(extractSessionToken(withBearerCompose), 'compose-xyz.123.456');

  const withoutCompose = {
    headers: {
      authorization: 'Bearer man0-user-jwt',
    },
  } as unknown as FastifyRequest;
  assert.equal(extractSessionToken(withoutCompose), null);
});

test('extractMetaFromReceiptPayload computes full {agentCreatorFee%&&agentPlatformFee%{modelInference ; agentRun ; connector}} base for workflowCreatorFee%&&workflowPlatform%', () => {
  // Runtime SSE / SDK receipt parsed by @compose-market/core:
  // finalAmountWei is ONLY the coordinator agent fee (e.g. 3640 wei),
  // while cumulative.totalAmountWei and bills[0].total hold full Compose spend (186940 wei).
  const coreParsedRuntimeReceipt = {
    id: 'rcpt_runtime_intent_1',
    service: 'agent',
    action: 'stream',
    subject: 'agent:0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g',
    providerAmountWei: '1820',
    platformFeeWei: '1820',
    finalAmountWei: '3640',
    network: 'near:testnet',
    settledAt: Date.now(),
    bills: [
      {
        kind: 'agent',
        source: 'agent',
        name: 'Fast executor',
        amountWei: '3640',
        total: '186940',
        agentWallet: '0usamczf9mc35z6ek779cbtax780t8gn0qa192sww6k5004wrtp07g',
        lineItems: [],
      },
    ],
    cumulative: {
      totalAmountWei: '186940',
      providerAmountWei: '183300',
      platformFeeWei: '3640',
      receiptCount: 4,
    },
  };

  const meta = extractMetaFromReceiptPayload(coreParsedRuntimeReceipt);
  assert.equal(meta.billWei, 186_940n);

  // Apply workflowCreatorFee% (3%) && workflowPlatform% (2%) on top of 186,940 wei:
  const wfFees = computeWorkflowServiceFees(meta.billWei, 3, false);
  // ceil(186940 * 3 / 100) = 5609 wei; ceil(186940 * 2 / 100) = 3739 wei; serviceFee = 9348 wei
  assert.equal(wfFees.composeBillWei, 186_940n);
  assert.equal(wfFees.creatorFeeWei, 5_609n);
  assert.equal(wfFees.platformFeeWei, 3_739n);
  assert.equal(wfFees.serviceFeeWei, 9_348n);
  assert.equal(wfFees.totalChargedWei, 196_288n);

  // Also verify base64url X-Receipt header decoding from runtime /responses
  const headerB64Url = Buffer.from(JSON.stringify(coreParsedRuntimeReceipt), 'utf8').toString(
    'base64url',
  );
  const resWithRuntimeHeader = new Response('{}', {
    status: 200,
    headers: { 'X-Receipt': headerB64Url },
  });
  assert.equal(extractReceiptBillWei(resWithRuntimeHeader, {}), 186_940n);
});
