import type { z } from 'zod';
import { graph, type Terms, type Listing, type Thread } from '../schema.js';
import { resolveCanonicalTasks } from '../options.js';
import { workflow } from './client.js';
import { cached, cacheDel, composer } from './cache.js';
import { digest } from '../auth/digest.js';

type Flow = z.infer<typeof graph>;

export const WIP_TTL_SECONDS = 86_400;
export const MARKET_LIST_CACHE_KEY = 'workflows:market';

export function userWorkflowsCacheKey(userAddress: string): string {
  return `workflows:user:${userAddress.trim().toLowerCase()}`;
}

export function workflowPublicCacheKey(id: string): string {
  return `workflow:pub:${id}`;
}

export function workflowOwnerCacheKey(id: string): string {
  return `workflow:owner:${id}`;
}

function activeDraftKey(userAddress: string): string {
  return `draft:${digest(userAddress)}:active`;
}

function flowDraftKey(userAddress: string, flowId: string): string {
  return `draft:${digest(userAddress)}:${flowId}`;
}

async function deleteFlowDraftFromComposer(userAddress: string, flowId: string): Promise<void> {
  const activeKey = activeDraftKey(userAddress);
  const targetKey = flowDraftKey(userAddress, flowId);
  const currentActive = await composer.get(activeKey);
  if (currentActive === targetKey) {
    await composer.del(activeKey, targetKey);
  } else {
    await composer.del(targetKey);
  }
}

const select = `id,"userAddress",name,graph,terms,published,modified`;

let runsInitialized = false;
async function ensureRunsTable() {
  if (runsInitialized) return;
  await workflow.query(
    `CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, "workflowId" text NOT NULL, "workflowName" text NOT NULL, "userAddress" text NOT NULL, "creatorAddress" text NOT NULL, network text NOT NULL, status text NOT NULL, "durationMs" bigint NOT NULL DEFAULT 0, "composeBillWei" text NOT NULL DEFAULT '0', "creatorFeeWei" text NOT NULL DEFAULT '0', "platformFeeWei" text NOT NULL DEFAULT '0', "totalChargedWei" text NOT NULL DEFAULT '0', "txHash" text, "proofCid" text, steps jsonb NOT NULL DEFAULT '[]'::jsonb, created timestamptz NOT NULL DEFAULT now())`,
  );
  await workflow.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS "proofCid" text`);
  runsInitialized = true;
}

function listing(row: Record<string, unknown>, privateBrief = false): Listing {
  const { brief, banner, tasks, coordinator, ...rest } = row.graph as Pick<
    Listing,
    'nodes' | 'edges' | 'brief' | 'banner' | 'tasks' | 'coordinator'
  >;
  const rowTerms = row.terms as Terms | null;
  const canonicalTasks = resolveCanonicalTasks(rowTerms?.tasks ?? tasks);
  return {
    id: row.id as string,
    userAddress: row.userAddress as string,
    name: row.name as string,
    ...rest,
    ...(canonicalTasks.length > 0 ? { tasks: canonicalTasks } : {}),
    ...(banner ? { banner } : {}),
    ...(coordinator ? { coordinator } : {}),
    ...(privateBrief && brief !== undefined ? { brief } : {}),
    terms: rowTerms
      ? {
          ...rowTerms,
          tasks: canonicalTasks,
        }
      : null,
    published: row.published ? new Date(row.published as string).toISOString() : null,
    modified: new Date(row.modified as string).toISOString(),
  };
}

export async function list(userAddress?: string) {
  if (userAddress) {
    return cached(userWorkflowsCacheKey(userAddress), 30, 5_000, async () => {
      const rows = await workflow.query(
        `SELECT ${select} FROM workflows WHERE "userAddress"=$1 AND deleted IS NULL ORDER BY modified DESC`,
        [userAddress],
      );
      return rows.map(row => listing(row, true));
    });
  }
  return cached(MARKET_LIST_CACHE_KEY, 30, 5_000, async () => {
    const rows = await workflow.query(
      `SELECT ${select} FROM workflows WHERE published IS NOT NULL AND deleted IS NULL ORDER BY published DESC`,
    );
    return rows.map(row => listing(row, false));
  });
}

export async function get(id: string, userAddress?: string) {
  if (!userAddress) {
    const pub = await cached<Listing | null>(workflowPublicCacheKey(id), 30, 5_000, async () => {
      const rows = await workflow.query(
        `SELECT ${select} FROM workflows WHERE id=$1 AND deleted IS NULL AND published IS NOT NULL`,
        [id],
      );
      return rows[0] ? listing(rows[0], false) : null;
    });
    if (!pub) throw Object.assign(new Error('Workflow not found.'), { statusCode: 404 });
    return pub;
  }

  const full = await cached<Listing | null>(workflowOwnerCacheKey(id), 30, 5_000, async () => {
    const rows = await workflow.query(
      `SELECT ${select} FROM workflows WHERE id=$1 AND deleted IS NULL`,
      [id],
    );
    return rows[0] ? listing(rows[0], true) : null;
  });

  if (!full || (!full.published && full.userAddress !== userAddress)) {
    throw Object.assign(new Error('Workflow not found.'), { statusCode: 404 });
  }
  if (full.userAddress === userAddress) {
    return full;
  }
  const { brief: _omitBrief, ...publicView } = full;
  return publicView as Listing;
}

export async function save(flow: Flow, userAddress: string, match?: string) {
  const canonicalTasks = resolveCanonicalTasks(flow.tasks);
  const payload = JSON.stringify({
    nodes: flow.nodes,
    edges: flow.edges,
    brief: flow.brief,
    ...(canonicalTasks.length > 0 ? { tasks: canonicalTasks } : {}),
    ...(flow.banner ? { banner: flow.banner } : {}),
    ...(flow.coordinator ? { coordinator: flow.coordinator } : {}),
  });
  const rows = match
    ? await workflow.query(
        `UPDATE workflows SET name=$3,graph=$4::jsonb,modified=greatest(date_trunc('milliseconds',clock_timestamp()),modified+interval '1 millisecond') WHERE id=$1 AND "userAddress"=$2 AND published IS NULL AND deleted IS NULL AND modified=$5::timestamptz RETURNING ${select}`,
        [flow.id, userAddress, flow.name, payload, match],
      )
    : await workflow.query(
        `INSERT INTO workflows(id,"userAddress",name,graph,modified) VALUES ($1,$2,$3,$4::jsonb,date_trunc('milliseconds',clock_timestamp())) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,graph=EXCLUDED.graph,modified=greatest(date_trunc('milliseconds',clock_timestamp()),workflows.modified+interval '1 millisecond') WHERE workflows."userAddress"=$2 AND workflows.published IS NULL AND workflows.deleted IS NULL RETURNING ${select}`,
        [flow.id, userAddress, flow.name, payload],
      );
  if (!rows[0])
    throw Object.assign(
      new Error('This workflow changed elsewhere, or is already published. Reload before saving.'),
      { statusCode: 409 },
    );
  await Promise.all([
    deleteFlowDraftFromComposer(userAddress, flow.id),
    cacheDel(
      userWorkflowsCacheKey(userAddress),
      workflowOwnerCacheKey(flow.id),
      workflowPublicCacheKey(flow.id),
    ),
  ]);
  return listing(rows[0], true);
}

export async function publish(id: string, userAddress: string, terms: Terms, match: string) {
  const normalizedTerms: Terms = {
    ...terms,
    tasks: resolveCanonicalTasks(terms.tasks),
  };
  const rows = await workflow.query(
    `UPDATE workflows SET terms=$3::jsonb,published=date_trunc('milliseconds',clock_timestamp()),modified=greatest(date_trunc('milliseconds',clock_timestamp()),modified+interval '1 millisecond') WHERE id=$1 AND "userAddress"=$2 AND published IS NULL AND deleted IS NULL AND modified=$4::timestamptz RETURNING ${select}`,
    [id, userAddress, JSON.stringify(normalizedTerms), match],
  );
  if (!rows[0])
    throw Object.assign(new Error('The workflow changed. Reload before publishing.'), {
      statusCode: 409,
    });
  await Promise.all([
    deleteFlowDraftFromComposer(userAddress, id),
    cacheDel(
      MARKET_LIST_CACHE_KEY,
      userWorkflowsCacheKey(userAddress),
      workflowOwnerCacheKey(id),
      workflowPublicCacheKey(id),
    ),
  ]);
  return listing(rows[0], true);
}

export async function remove(id: string, userAddress: string, match: string) {
  const rows = await workflow.query(
    `UPDATE workflows SET deleted=date_trunc('milliseconds',clock_timestamp()),modified=greatest(date_trunc('milliseconds',clock_timestamp()),modified+interval '1 millisecond') WHERE id=$1 AND "userAddress"=$2 AND deleted IS NULL AND modified=$3::timestamptz RETURNING id`,
    [id, userAddress, match],
  );
  if (!rows[0])
    throw Object.assign(new Error('The workflow changed. Reload before deleting.'), {
      statusCode: 409,
    });
  await Promise.all([
    deleteFlowDraftFromComposer(userAddress, id),
    cacheDel(
      MARKET_LIST_CACHE_KEY,
      userWorkflowsCacheKey(userAddress),
      workflowOwnerCacheKey(id),
      workflowPublicCacheKey(id),
    ),
  ]);
}

export async function draft(flow: Flow, userAddress: string, match?: string) {
  const key = flowDraftKey(userAddress, flow.id);
  const activeKey = activeDraftKey(userAddress);
  const canonicalTasks = resolveCanonicalTasks(flow.tasks);
  const stored = JSON.stringify({
    ...flow,
    ...(canonicalTasks.length > 0 ? { tasks: canonicalTasks } : { tasks: undefined }),
    modified: new Date().toISOString(),
  });
  const result = await composer.eval(
    `if ARGV[1]~='' then local previous=redis.call('GET',KEYS[1]); if not previous or cjson.decode(previous).modified~=ARGV[1] then return 0 end end; local prevActive=redis.call('GET',KEYS[2]); if prevActive and prevActive~=KEYS[1] then redis.call('DEL',prevActive) end; redis.call('SET',KEYS[1],ARGV[2],'EX',tonumber(ARGV[3])); redis.call('SET',KEYS[2],KEYS[1],'EX',tonumber(ARGV[3])); return 1`,
    2,
    key,
    activeKey,
    match ?? '',
    stored,
    String(WIP_TTL_SECONDS),
  );
  if (result !== 1)
    throw Object.assign(new Error('The draft changed in another tab. Reload before editing.'), {
      statusCode: 409,
    });
  return JSON.parse(stored) as Flow;
}

export async function current(userAddress: string) {
  const prefix = `draft:${digest(userAddress)}:`;
  const activeKey = `${prefix}active`;
  const key = await composer.get(activeKey);
  if (!key || !key.startsWith(prefix)) return null;
  const value = await composer.get(key);
  if (!value) return null;
  const parsed = graph.parse(JSON.parse(value));
  const existing = await workflow.query(
    'SELECT published FROM workflows WHERE id=$1 AND "userAddress"=$2 AND deleted IS NULL LIMIT 1',
    [parsed.id, userAddress],
  );
  if (existing[0]?.published) {
    await deleteFlowDraftFromComposer(userAddress, parsed.id);
    return null;
  }
  const ttl = await composer.ttl(key);
  if (ttl < 0 || ttl > WIP_TTL_SECONDS) {
    await Promise.all([
      composer.expire(key, WIP_TTL_SECONDS),
      composer.expire(activeKey, WIP_TTL_SECONDS),
    ]);
  }
  return parsed;
}

export async function clearDraft(userAddress: string) {
  const prefix = `draft:${digest(userAddress)}:`;
  const activeKey = `${prefix}active`;
  const currentKey = await composer.get(activeKey);
  const keys = currentKey && currentKey.startsWith(prefix) ? [activeKey, currentKey] : [activeKey];
  await composer.del(...keys);
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName: string;
  userAddress: string;
  creatorAddress: string;
  network: string;
  status: 'succeeded' | 'failed';
  durationMs: number;
  composeBillWei: string;
  creatorFeeWei: string;
  platformFeeWei: string;
  totalChargedWei: string;
  txHash: string | null;
  proofCid?: string | null;
  steps: Array<Record<string, unknown>>;
}

export async function recordRun(input: Run): Promise<void> {
  await ensureRunsTable();
  await workflow.query(
    `INSERT INTO runs (id, "workflowId", "workflowName", "userAddress", "creatorAddress", network, status, "durationMs", "composeBillWei", "creatorFeeWei", "platformFeeWei", "totalChargedWei", "txHash", "proofCid", steps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      input.workflowId,
      input.workflowName,
      input.userAddress,
      input.creatorAddress,
      input.network,
      input.status,
      Math.max(0, Math.round(input.durationMs)),
      input.composeBillWei,
      input.creatorFeeWei,
      input.platformFeeWei,
      input.totalChargedWei,
      input.txHash,
      input.proofCid ?? null,
      JSON.stringify(input.steps),
    ],
  );
}

export async function analytics(input: {
  userAddress: string;
  from?: string;
  to?: string;
  interval?: 'minute' | 'hour' | 'day';
  networks?: string[];
  limit?: number;
}) {
  await ensureRunsTable();
  const [clockRow] = await workflow.query(`SELECT now() AS now`);
  const dbNow = clockRow?.now ? new Date(String(clockRow.now)) : new Date();
  const toDate = input.to ? new Date(input.to) : dbNow;
  const fromDate = input.from
    ? new Date(input.from)
    : new Date(toDate.getTime() - 7 * 24 * 3600 * 1000);
  const interval = input.interval ?? 'day';
  const limit = input.limit ?? 100;

  const rows = await workflow.query(
    `SELECT id, "workflowId", "workflowName", "userAddress", "creatorAddress", network, status, "durationMs", "composeBillWei", "creatorFeeWei", "platformFeeWei", "totalChargedWei", "txHash", steps, created FROM runs WHERE LOWER("userAddress") = LOWER($1) AND created >= $2::timestamptz AND created <= $3::timestamptz ORDER BY created DESC LIMIT $4`,
    [input.userAddress, fromDate.toISOString(), toDate.toISOString(), limit],
  );

  const filtered = input.networks?.length
    ? rows.filter(r => input.networks!.includes(String(r.network)))
    : rows;

  let succeeded = 0;
  let failed = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let finalAmountAtomic = 0n;
  let composeBillAtomic = 0n;
  let creatorFeeAtomic = 0n;

  const buckets = new Map<
    string,
    {
      total: number;
      succeeded: number;
      failed: number;
      latencySum: number;
      latencyCount: number;
      finalAmountAtomic: bigint;
      composeBillAtomic: bigint;
      creatorFeeAtomic: bigint;
    }
  >();

  const requestRows = [];
  const settlementRows = [];

  for (const row of filtered) {
    const status = String(row.status);
    const durationMs = Number(row.durationMs ?? 0);
    const charged = BigInt(String(row.totalChargedWei ?? '0'));
    const composeBill = BigInt(String(row.composeBillWei ?? '0'));
    const creatorFee =
      String(row.creatorAddress) === input.userAddress
        ? BigInt(String(row.creatorFeeWei ?? '0'))
        : 0n;
    const createdIso = new Date(row.created as string).toISOString();
    const stepsArr = Array.isArray(row.steps) ? row.steps : [];

    if (status === 'succeeded') succeeded += 1;
    else failed += 1;
    if (durationMs > 0) {
      latencySum += durationMs;
      latencyCount += 1;
    }
    finalAmountAtomic += charged;
    composeBillAtomic += composeBill;
    creatorFeeAtomic += creatorFee;

    const d = new Date(createdIso);
    if (interval === 'day') d.setUTCHours(0, 0, 0, 0);
    else if (interval === 'hour') d.setUTCMinutes(0, 0, 0);
    else d.setUTCSeconds(0, 0);
    const bucketKey = d.toISOString();
    const bucket = buckets.get(bucketKey) ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      latencySum: 0,
      latencyCount: 0,
      finalAmountAtomic: 0n,
      composeBillAtomic: 0n,
      creatorFeeAtomic: 0n,
    };
    bucket.total += 1;
    if (status === 'succeeded') bucket.succeeded += 1;
    else bucket.failed += 1;
    if (durationMs > 0) {
      bucket.latencySum += durationMs;
      bucket.latencyCount += 1;
    }
    bucket.finalAmountAtomic += charged;
    bucket.composeBillAtomic += composeBill;
    bucket.creatorFeeAtomic += creatorFee;
    buckets.set(bucketKey, bucket);

    requestRows.push({
      id: String(row.id),
      workflowId: String(row.workflowId),
      model: String(row.workflowName),
      status,
      network: String(row.network),
      startedAt: createdIso,
      completedAt: createdIso,
      latencyMs: durationMs,
      composeBillAtomic: String(row.composeBillWei ?? '0'),
      creatorFeeAtomic: String(row.creatorFeeWei ?? '0'),
      billing: {
        quotedAmountAtomic: String(row.totalChargedWei ?? '0'),
        finalAmountAtomic: String(row.totalChargedWei ?? '0'),
        composeBillAtomic: String(row.composeBillWei ?? '0'),
        creatorFeeAtomic: String(row.creatorFeeWei ?? '0'),
        currency: 'USDC',
      },
      usage: {
        units: [{ key: 'steps', quantity: stepsArr.length, unit: 'steps' }],
      },
    });

    if (charged > 0n || row.txHash) {
      settlementRows.push({
        id: String(row.id),
        workflowId: String(row.workflowId),
        model: String(row.workflowName),
        status: row.txHash ? 'settled' : status,
        network: String(row.network),
        createdAt: createdIso,
        composeBillAtomic: String(row.composeBillWei ?? '0'),
        creatorFeeAtomic: String(row.creatorFeeWei ?? '0'),
        billing: {
          quotedAmountAtomic: String(row.totalChargedWei ?? '0'),
          finalAmountAtomic: String(row.totalChargedWei ?? '0'),
          composeBillAtomic: String(row.composeBillWei ?? '0'),
          creatorFeeAtomic: String(row.creatorFeeWei ?? '0'),
          currency: 'USDC',
        },
        settleTransactionHash: (row.txHash as string | null) ?? undefined,
        transactionHash: (row.txHash as string | null) ?? undefined,
      });
    }
  }

  const timeline = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, b]) => ({
      start,
      totals: {
        requests: {
          total: b.total,
          succeeded: b.succeeded,
          failed: b.failed,
        },
        latency: {
          count: b.latencyCount,
          averageMs: b.latencyCount ? b.latencySum / b.latencyCount : 0,
        },
        billing: {
          quotedAmountAtomic: b.finalAmountAtomic.toString(),
          finalAmountAtomic: b.finalAmountAtomic.toString(),
          composeBillAtomic: b.composeBillAtomic.toString(),
          creatorFeeAtomic: b.creatorFeeAtomic.toString(),
          currency: 'USDC',
        },
      },
    }));

  return {
    filters: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      interval,
      networks: input.networks ?? [],
    },
    totals: {
      requests: {
        total: succeeded + failed,
        succeeded,
        failed,
      },
      latency: {
        count: latencyCount,
        averageMs: latencyCount ? latencySum / latencyCount : 0,
      },
      billing: {
        quotedAmountAtomic: finalAmountAtomic.toString(),
        finalAmountAtomic: finalAmountAtomic.toString(),
        composeBillAtomic: composeBillAtomic.toString(),
        creatorFeeAtomic: creatorFeeAtomic.toString(),
        currency: 'USDC',
      },
    },
    timeline,
    requests: {
      data: requestRows,
      nextCursor: null,
    },
    settlements: {
      data: settlementRows,
      nextCursor: null,
    },
  };
}
