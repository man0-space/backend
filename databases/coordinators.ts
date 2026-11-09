import { randomUUID } from 'node:crypto';
import type { Coordinator } from '../schema.js';
import { workflow } from './client.js';
import { cached, cacheDel } from './cache.js';

let initialized = false;

export async function ensureCoordinatorsTable(): Promise<void> {
  if (initialized) return;
  await workflow.query(
    `CREATE TABLE IF NOT EXISTS coordinators (id text PRIMARY KEY, "userAddress" text NOT NULL, "agentId" bigint NOT NULL, "walletAddress" text NOT NULL UNIQUE, name text NOT NULL, image text NOT NULL, personality text NOT NULL, model text NOT NULL, cid text NOT NULL, "txHash" text NOT NULL, "contractId" text NOT NULL, network text NOT NULL CHECK(network IN ('near:mainnet','near:testnet')), created timestamptz NOT NULL DEFAULT now())`,
  );
  await workflow.query(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coordinators' AND column_name = 'agentWallet') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coordinators' AND column_name = 'walletAddress') THEN ALTER TABLE coordinators RENAME COLUMN "agentWallet" TO "walletAddress"; END IF; END $$`,
  );
  await workflow.query(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coordinators' AND column_name = 'cardCid') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coordinators' AND column_name = 'cid') THEN ALTER TABLE coordinators RENAME COLUMN "cardCid" TO cid; END IF; END $$`,
  );
  await workflow.query(`ALTER TABLE coordinators DROP COLUMN IF EXISTS "dnaHash"`);
  await workflow.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS coordinators_wallet_idx ON coordinators("walletAddress")`,
  );
  await workflow.query(
    `CREATE INDEX IF NOT EXISTS coordinators_owner_idx ON coordinators("userAddress", created DESC)`,
  );
  initialized = true;
}

export function userCoordinatorsCacheKey(userAddress: string): string {
  return `coordinators:user:${userAddress.trim().toLowerCase()}`;
}

function hydrate(row: Record<string, unknown>): Coordinator {
  return {
    id: String(row.id),
    userAddress: String(row.userAddress ?? ''),
    agentId: Number(row.agentId ?? 0),
    walletAddress: String(row.walletAddress),
    name: String(row.name),
    image: String(row.image ?? ''),
    personality: String(row.personality ?? ''),
    model: String(row.model),
    cid: String(row.cid ?? ''),
    txHash: String(row.txHash ?? ''),
    contractId: String(row.contractId ?? ''),
    network: String(row.network || 'near:testnet'),
    created: row.created ? new Date(String(row.created)).toISOString() : new Date().toISOString(),
  };
}

export const ALL_COORDINATORS_CACHE_KEY = 'coordinators:all';

export async function listAll(): Promise<Coordinator[]> {
  await ensureCoordinatorsTable();
  return cached(ALL_COORDINATORS_CACHE_KEY, 30, 5_000, async () => {
    const rows = await workflow.query(
      `SELECT id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network, created FROM coordinators ORDER BY created DESC LIMIT 100`,
    );
    return rows.map(row => hydrate(row));
  });
}

export async function list(userAddress: string): Promise<Coordinator[]> {
  await ensureCoordinatorsTable();
  return cached(userCoordinatorsCacheKey(userAddress), 30, 5_000, async () => {
    const rows = await workflow.query(
      `SELECT id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network, created FROM coordinators WHERE "userAddress"=$1 ORDER BY created DESC`,
      [userAddress],
    );
    return rows.map(row => hydrate(row));
  });
}

export async function get(id: string, userAddress?: string): Promise<Coordinator | null> {
  await ensureCoordinatorsTable();
  const rows = userAddress
    ? await workflow.query(
      `SELECT id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network, created FROM coordinators WHERE id=$1 AND "userAddress"=$2 LIMIT 1`,
      [id, userAddress],
    )
    : await workflow.query(
      `SELECT id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network, created FROM coordinators WHERE id=$1 LIMIT 1`,
      [id],
    );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function create(
  input: Omit<Coordinator, 'id' | 'created'> & { id?: string },
): Promise<Coordinator> {
  await ensureCoordinatorsTable();
  const id = input.id?.trim() || randomUUID();
  const rows = await workflow.query(
    `INSERT INTO coordinators (id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT ("walletAddress") DO UPDATE SET
       name = EXCLUDED.name,
       image = EXCLUDED.image,
       personality = EXCLUDED.personality,
       model = EXCLUDED.model,
       cid = EXCLUDED.cid,
       "txHash" = EXCLUDED."txHash"
     RETURNING id, "userAddress", "agentId", "walletAddress", name, image, personality, model, cid, "txHash", "contractId", network, created`,
    [
      id,
      input.userAddress,
      input.agentId,
      input.walletAddress,
      input.name,
      input.image,
      input.personality,
      input.model,
      input.cid,
      input.txHash,
      input.contractId,
      input.network,
    ],
  );
  await cacheDel(userCoordinatorsCacheKey(input.userAddress));
  await cacheDel(ALL_COORDINATORS_CACHE_KEY);
  return hydrate(rows[0]!);
}
