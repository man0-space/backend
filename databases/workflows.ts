import type { z } from 'zod';
import { graph, type Terms, type Listing, type Thread } from '../schema.js';
import { resolveCanonicalTasks } from '../options.js';
import { workflow } from './client.js';
import { cached, cacheDel, composer } from './cache.js';
import { digest } from '../auth/digest.js';

type Flow = z.infer<typeof graph>;

export const WIP_TTL_SECONDS = 86_400;
export const MAX_WIP_DRAFTS = 8;
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

function draftIndexKey(userAddress: string): string {
  return `draft:${digest(userAddress)}:index`;
}

function flowDraftKey(userAddress: string, flowId: string): string {
  return `draft:${digest(userAddress)}:${flowId}`;
}

async function deleteFlowDraftFromComposer(userAddress: string, flowId: string): Promise<void> {
  const activeKey = activeDraftKey(userAddress);
  const indexKey = draftIndexKey(userAddress);
  const targetKey = flowDraftKey(userAddress, flowId);
  const currentActive = await composer.get(activeKey);
  await Promise.all([
    composer.zrem(indexKey, flowId),
    currentActive === targetKey ? composer.del(activeKey, targetKey) : composer.del(targetKey),
  ]);
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
  const prefix = `draft:${digest(userAddress)}:`;
  const key = `${prefix}${flow.id}`;
  const activeKey = activeDraftKey(userAddress);
  const indexKey = draftIndexKey(userAddress);
  const canonicalTasks = resolveCanonicalTasks(flow.tasks);
  const nowMs = Date.now();
  const stored = JSON.stringify({
    ...flow,
    ...(canonicalTasks.length > 0 ? { tasks: canonicalTasks } : { tasks: undefined }),
    modified: new Date(nowMs).toISOString(),
  });
  const result = await composer.eval(
    `if ARGV[1]~='' then local previous=redis.call('GET',KEYS[1]); if not previous or cjson.decode(previous).modified~=ARGV[1] then return 0 end end; redis.call('SET',KEYS[1],ARGV[2],'EX',tonumber(ARGV[3])); redis.call('SET',KEYS[2],KEYS[1],'EX',tonumber(ARGV[3])); redis.call('ZADD',KEYS[3],tonumber(ARGV[4]),ARGV[5]); redis.call('EXPIRE',KEYS[3],tonumber(ARGV[3])); local count=redis.call('ZCARD',KEYS[3]); local maxKeep=tonumber(ARGV[6]); if count>maxKeep then local stale=redis.call('ZRANGE',KEYS[3],0,count-maxKeep-1); for _,id in ipairs(stale) do redis.call('ZREM',KEYS[3],id); redis.call('DEL',ARGV[7]..id); end end; return 1`,
    3,
    key,
    activeKey,
    indexKey,
    match ?? '',
    stored,
    String(WIP_TTL_SECONDS),
    String(nowMs),
    flow.id,
    String(MAX_WIP_DRAFTS),
    prefix,
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

export interface CreatorWorkflowEarningSummary {
  workflowId: string;
  name: string;
  banner: string | null;
  tasks: string[];
  published: string | null;
  modified: string;
  creatorFee: number;
  stepsCount: number;
  runs: number;
  paidRuns: number;
  succeededRuns: number;
  failedRuns: number;
  earnedAtomic: string;
  totalChargedAtomic: string;
  avgDurationMs: number;
  totalDurationMs: number;
  lastRunAt: string | null;
}

export interface CreatorEarningEvent {
  id: string;
  workflowId: string;
  workflowName: string;
  tasks: string[];
  runnerAddress: string;
  status: string;
  network: string;
  earnedAtomic: string;
  composeBillAtomic: string;
  totalChargedAtomic: string;
  durationMs: number;
  stepsCount: number;
  txHash: string | null;
  proofCid: string | null;
  timestamp: string;
}

export async function creatorEarnings(input: {
  creatorAddress: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<{
  filters: { from: string; to: string };
  workflows: CreatorWorkflowEarningSummary[];
  events: CreatorEarningEvent[];
}> {
  await ensureRunsTable();
  const [clockRow] = await workflow.query(`SELECT now() AS now`);
  const dbNow = clockRow?.now ? new Date(String(clockRow.now)) : new Date();
  const toDate = input.to ? new Date(input.to) : dbNow;
  const fromDate = input.from
    ? new Date(input.from)
    : new Date(toDate.getTime() - 7 * 24 * 3600 * 1000);
  const limit = input.limit ?? 500;

  const [wfRows, runRows] = await Promise.all([
    workflow.query(
      `SELECT id, name, graph, terms, published, modified
       FROM workflows
       WHERE LOWER("userAddress") = LOWER($1) AND deleted IS NULL
       ORDER BY COALESCE(published, modified) DESC`,
      [input.creatorAddress],
    ),
    workflow.query(
      `SELECT id, "workflowId", "workflowName", "userAddress", "creatorAddress", network, status,
              "durationMs", "composeBillWei", "creatorFeeWei", "platformFeeWei", "totalChargedWei",
              "txHash", "proofCid", steps, created
       FROM runs
       WHERE LOWER("creatorAddress") = LOWER($1)
         AND created >= $2::timestamptz
         AND created <= $3::timestamptz
       ORDER BY created DESC
       LIMIT $4`,
      [input.creatorAddress, fromDate.toISOString(), toDate.toISOString(), limit],
    ),
  ]);

  type Accum = {
    workflowId: string;
    name: string;
    banner: string | null;
    tasks: string[];
    published: string | null;
    modified: string;
    creatorFee: number;
    stepsCount: number;
    runs: number;
    paidRuns: number;
    succeededRuns: number;
    failedRuns: number;
    earnedAtomic: bigint;
    totalChargedAtomic: bigint;
    durationSumMs: number;
    durationCount: number;
    lastRunAt: string | null;
  };

  const byWorkflowId = new Map<string, Accum>();

  for (const r of wfRows) {
    const id = String(r.id);
    const graphObj = (r.graph ?? {}) as {
      banner?: string | null;
      tasks?: string[];
      nodes?: unknown[];
    };
    const termsObj = (r.terms ?? null) as {
      creatorFee?: number;
      tasks?: string[];
    } | null;
    const tasks = Array.isArray(termsObj?.tasks) && termsObj.tasks.length > 0
      ? termsObj.tasks.map(String)
      : Array.isArray(graphObj.tasks)
        ? graphObj.tasks.map(String)
        : [];
    byWorkflowId.set(id, {
      workflowId: id,
      name: String(r.name || 'Untitled Workflow'),
      banner: graphObj.banner ? String(graphObj.banner) : null,
      tasks,
      published: r.published ? new Date(String(r.published)).toISOString() : null,
      modified: new Date(String(r.modified)).toISOString(),
      creatorFee: typeof termsObj?.creatorFee === 'number' ? termsObj.creatorFee : 0,
      stepsCount: Array.isArray(graphObj.nodes) ? graphObj.nodes.length : 0,
      runs: 0,
      paidRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      earnedAtomic: 0n,
      totalChargedAtomic: 0n,
      durationSumMs: 0,
      durationCount: 0,
      lastRunAt: null,
    });
  }

  const events: CreatorEarningEvent[] = [];

  for (const r of runRows) {
    const wfId = String(r.workflowId);
    const wfName = String(r.workflowName || 'Workflow');
    const createdIso = new Date(String(r.created)).toISOString();
    const status = String(r.status || 'succeeded');
    const durationMs = Math.max(0, Number(r.durationMs ?? 0));
    const earned = BigInt(String(r.creatorFeeWei ?? '0'));
    const composeBill = BigInt(String(r.composeBillWei ?? '0'));
    const charged = BigInt(String(r.totalChargedWei ?? '0'));
    const stepsArr = Array.isArray(r.steps) ? r.steps : [];

    let acc = byWorkflowId.get(wfId);
    if (!acc) {
      acc = {
        workflowId: wfId,
        name: wfName,
        banner: null,
        tasks: [],
        published: null,
        modified: createdIso,
        creatorFee: 0,
        stepsCount: stepsArr.length,
        runs: 0,
        paidRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        earnedAtomic: 0n,
        totalChargedAtomic: 0n,
        durationSumMs: 0,
        durationCount: 0,
        lastRunAt: null,
      };
      byWorkflowId.set(wfId, acc);
    }

    acc.runs += 1;
    if (earned > 0n) acc.paidRuns += 1;
    if (status === 'succeeded') acc.succeededRuns += 1;
    else acc.failedRuns += 1;
    acc.earnedAtomic += earned;
    acc.totalChargedAtomic += charged;
    if (durationMs > 0) {
      acc.durationSumMs += durationMs;
      acc.durationCount += 1;
    }
    if (!acc.lastRunAt || createdIso > acc.lastRunAt) {
      acc.lastRunAt = createdIso;
    }

    events.push({
      id: String(r.id),
      workflowId: wfId,
      workflowName: acc.name || wfName,
      tasks: acc.tasks,
      runnerAddress: String(r.userAddress || ''),
      status,
      network: String(r.network || ''),
      earnedAtomic: earned.toString(),
      composeBillAtomic: composeBill.toString(),
      totalChargedAtomic: charged.toString(),
      durationMs,
      stepsCount: stepsArr.length || acc.stepsCount,
      txHash: r.txHash ? String(r.txHash) : null,
      proofCid: r.proofCid ? String(r.proofCid) : null,
      timestamp: createdIso,
    });
  }

  const summaries: CreatorWorkflowEarningSummary[] = [...byWorkflowId.values()].map(acc => ({
    workflowId: acc.workflowId,
    name: acc.name,
    banner: acc.banner,
    tasks: acc.tasks,
    published: acc.published,
    modified: acc.modified,
    creatorFee: acc.creatorFee,
    stepsCount: acc.stepsCount,
    runs: acc.runs,
    paidRuns: acc.paidRuns,
    succeededRuns: acc.succeededRuns,
    failedRuns: acc.failedRuns,
    earnedAtomic: acc.earnedAtomic.toString(),
    totalChargedAtomic: acc.totalChargedAtomic.toString(),
    avgDurationMs: acc.durationCount > 0 ? Math.round(acc.durationSumMs / acc.durationCount) : 0,
    totalDurationMs: acc.durationSumMs,
    lastRunAt: acc.lastRunAt,
  }));

  return {
    filters: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    },
    workflows: summaries,
    events,
  };
}

export const THREAD_TTL_SECONDS = 7 * 86_400;

export function workflowThreadScopeKey(userAddress: string, workflowId: string): string {
  return `${userAddress.trim().toLowerCase()}:${workflowId.trim()}`;
}

function threadValkeyKey(userAddress: string, workflowId: string, threadId: string): string {
  return `wfthread:${workflowThreadScopeKey(userAddress, workflowId)}:${threadId.trim()}`;
}

function threadIndexValkeyKey(userAddress: string, workflowId: string): string {
  return `wfthreads:${workflowThreadScopeKey(userAddress, workflowId)}`;
}

let threadsInitialized = false;
async function ensureThreadsTable() {
  if (threadsInitialized) return;
  await workflow.query(
    `CREATE TABLE IF NOT EXISTS threads (
      "threadId" text NOT NULL,
      "workflowId" text NOT NULL,
      "userAddress" text NOT NULL,
      scope text NOT NULL,
      title text NOT NULL DEFAULT '',
      status text NOT NULL,
      "runId" text NOT NULL,
      dry boolean NOT NULL DEFAULT false,
      prompt text NOT NULL DEFAULT '',
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      coordinator jsonb,
      "runningStepId" text,
      "stepOutputs" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "missingInputs" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "missingConnectors" jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      billing jsonb,
      execution jsonb,
      created timestamptz NOT NULL DEFAULT now(),
      updated timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, "threadId")
    )`,
  );
  await workflow.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS billing jsonb`);
  await workflow.query(
    `CREATE INDEX IF NOT EXISTS threads_scope_updated_idx ON threads (scope, updated DESC)`,
  );
  threadsInitialized = true;
}

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    threadId: String(row.threadId),
    workflowId: String(row.workflowId),
    userAddress: String(row.userAddress),
    title: String(row.title ?? ''),
    status: (row.status as Thread['status']) ?? 'running',
    runId: String(row.runId ?? ''),
    dry: Boolean(row.dry),
    prompt: String(row.prompt ?? ''),
    attachments: Array.isArray(row.attachments)
      ? (row.attachments as Array<Record<string, unknown>>)
      : [],
    coordinator: (row.coordinator as Thread['coordinator']) ?? null,
    runningStepId:
      typeof row.runningStepId === 'string' && row.runningStepId ? row.runningStepId : null,
    stepOutputs:
      row.stepOutputs && typeof row.stepOutputs === 'object'
        ? (row.stepOutputs as Record<string, string>)
        : {},
    missingInputs: Array.isArray(row.missingInputs)
      ? (row.missingInputs as Array<Record<string, unknown>>)
      : [],
    missingConnectors: Array.isArray(row.missingConnectors)
      ? (row.missingConnectors as Array<Record<string, unknown>>)
      : [],
    error: typeof row.error === 'string' && row.error ? row.error : null,
    billing:
      row.billing && typeof row.billing === 'object'
        ? (row.billing as Record<string, unknown>)
        : null,
    execution:
      row.execution && typeof row.execution === 'object'
        ? (row.execution as Record<string, unknown>)
        : null,
    created: row.created ? new Date(String(row.created)).toISOString() : new Date().toISOString(),
    updated: row.updated ? new Date(String(row.updated)).toISOString() : new Date().toISOString(),
  };
}

export async function upsertThread(input: {
  threadId: string;
  workflowId: string;
  userAddress: string;
  title?: string;
  status: Thread['status'];
  runId: string;
  dry: boolean;
  prompt?: string;
  attachments?: Array<Record<string, unknown>>;
  coordinator?: Thread['coordinator'];
  runningStepId?: string | null;
  stepOutputs?: Record<string, string>;
  missingInputs?: Array<Record<string, unknown>>;
  missingConnectors?: Array<Record<string, unknown>>;
  error?: string | null;
  billing?: Record<string, unknown> | null;
  execution?: Record<string, unknown> | null;
  persistDb?: boolean;
}): Promise<Thread> {
  const existing = await getThread(input.userAddress, input.workflowId, input.threadId);
  const nowIso = new Date().toISOString();
  const prompt = input.prompt !== undefined ? input.prompt : (existing?.prompt ?? '');
  const derivedTitle =
    input.title?.trim() ||
    existing?.title?.trim() ||
    prompt.trim().slice(0, 72) ||
    `Run ${new Date(nowIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const merged: Thread = {
    threadId: input.threadId.trim(),
    workflowId: input.workflowId,
    userAddress: existing?.userAddress || input.userAddress,
    title: derivedTitle,
    status: input.status,
    runId: input.runId,
    dry: input.dry,
    prompt,
    attachments: input.attachments ?? existing?.attachments ?? [],
    coordinator:
      input.coordinator !== undefined ? input.coordinator : (existing?.coordinator ?? null),
    runningStepId:
      input.runningStepId !== undefined ? input.runningStepId : (existing?.runningStepId ?? null),
    stepOutputs: {
      ...(existing?.stepOutputs ?? {}),
      ...(input.stepOutputs ?? {}),
    },
    missingInputs:
      input.missingInputs !== undefined ? input.missingInputs : (existing?.missingInputs ?? []),
    missingConnectors:
      input.missingConnectors !== undefined
        ? input.missingConnectors
        : (existing?.missingConnectors ?? []),
    error: input.error !== undefined ? input.error : (existing?.error ?? null),
    billing: input.billing !== undefined ? input.billing : (existing?.billing ?? null),
    execution: input.execution !== undefined ? input.execution : (existing?.execution ?? null),
    created: existing?.created ?? nowIso,
    updated: nowIso,
  };

  const vKey = threadValkeyKey(input.userAddress, input.workflowId, merged.threadId);
  const idxKey = threadIndexValkeyKey(input.userAddress, input.workflowId);
  const rawList = await composer.get(idxKey).catch(() => null);
  const parsedIds = rawList ? (JSON.parse(rawList) as string[]) : [];
  const nextIds = [merged.threadId, ...parsedIds.filter(id => id !== merged.threadId)].slice(0, 50);

  await Promise.all([
    composer.set(vKey, JSON.stringify(merged), 'EX', THREAD_TTL_SECONDS).catch(() => undefined),
    composer.set(idxKey, JSON.stringify(nextIds), 'EX', THREAD_TTL_SECONDS).catch(() => undefined),
  ]);

  if (input.persistDb !== false) {
    await ensureThreadsTable();
    const scope = workflowThreadScopeKey(input.userAddress, input.workflowId);
    await workflow.query(
      `INSERT INTO threads (
        "threadId", "workflowId", "userAddress", scope, title, status, "runId", dry, prompt,
        attachments, coordinator, "runningStepId", "stepOutputs", "missingInputs", "missingConnectors",
        error, billing, execution, created, updated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb,
        $16, $17::jsonb, $18::jsonb, $19::timestamptz, $20::timestamptz
      )
      ON CONFLICT (scope, "threadId") DO UPDATE SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        "runId" = EXCLUDED."runId",
        dry = EXCLUDED.dry,
        prompt = EXCLUDED.prompt,
        attachments = EXCLUDED.attachments,
        coordinator = EXCLUDED.coordinator,
        "runningStepId" = EXCLUDED."runningStepId",
        "stepOutputs" = EXCLUDED."stepOutputs",
        "missingInputs" = EXCLUDED."missingInputs",
        "missingConnectors" = EXCLUDED."missingConnectors",
        error = EXCLUDED.error,
        billing = EXCLUDED.billing,
        execution = EXCLUDED.execution,
        updated = EXCLUDED.updated`,
      [
        merged.threadId,
        merged.workflowId,
        merged.userAddress,
        scope,
        merged.title,
        merged.status,
        merged.runId,
        merged.dry,
        merged.prompt,
        JSON.stringify(merged.attachments),
        merged.coordinator ? JSON.stringify(merged.coordinator) : null,
        merged.runningStepId ?? null,
        JSON.stringify(merged.stepOutputs),
        JSON.stringify(merged.missingInputs),
        JSON.stringify(merged.missingConnectors),
        merged.error ?? null,
        merged.billing ? JSON.stringify(merged.billing) : null,
        merged.execution ? JSON.stringify(merged.execution) : null,
        merged.created,
        merged.updated,
      ],
    );
  }

  return merged;
}

export async function getThread(
  userAddress: string,
  workflowId: string,
  threadId: string,
): Promise<Thread | null> {
  const vKey = threadValkeyKey(userAddress, workflowId, threadId);
  const cachedVal = await composer.get(vKey).catch(() => null);
  if (cachedVal) {
    try {
      return JSON.parse(cachedVal) as Thread;
    } catch {
      // Fall through to Postgres
    }
  }
  await ensureThreadsTable();
  const scope = workflowThreadScopeKey(userAddress, workflowId);
  const rows = await workflow.query(
    `SELECT * FROM threads WHERE scope = $1 AND "threadId" = $2 LIMIT 1`,
    [scope, threadId.trim()],
  );
  if (!rows[0]) return null;
  const loaded = rowToThread(rows[0]);
  await composer
    .set(vKey, JSON.stringify(loaded), 'EX', THREAD_TTL_SECONDS)
    .catch(() => undefined);
  return loaded;
}

export async function listThreads(
  userAddress: string,
  workflowId: string,
  limit = 25,
): Promise<Thread[]> {
  await ensureThreadsTable();
  const scope = workflowThreadScopeKey(userAddress, workflowId);
  const rows = await workflow.query(
    `SELECT * FROM threads WHERE scope = $1 ORDER BY updated DESC LIMIT $2`,
    [scope, limit],
  );
  const dbThreads = rows.map(rowToThread);
  const byId = new Map<string, Thread>();
  for (const item of dbThreads) {
    byId.set(item.threadId, item);
  }

  const idxKey = threadIndexValkeyKey(userAddress, workflowId);
  const rawIdx = await composer.get(idxKey).catch(() => null);
  const cachedIds = rawIdx ? (JSON.parse(rawIdx) as string[]) : [];
  for (const id of cachedIds) {
    const vKey = threadValkeyKey(userAddress, workflowId, id);
    const raw = await composer.get(vKey).catch(() => null);
    if (!raw) continue;
    try {
      const live = JSON.parse(raw) as Thread;
      const existing = byId.get(live.threadId);
      if (!existing || Date.parse(live.updated) >= Date.parse(existing.updated)) {
        byId.set(live.threadId, live);
      }
    } catch {
      // Ignore malformed cache entry
    }
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
    .slice(0, limit);
}
