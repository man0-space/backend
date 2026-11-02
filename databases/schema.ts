import { pgTable, text, timestamp, jsonb, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Listing, SocialLink, Terms } from '../schema.js';

export const users = pgTable('users', {
  userAddress: text('userAddress').primaryKey(),
  name: text('name').notNull().default(''),
  bio: text('bio').notNull().default(''),
  image: text('image'),
  banner: text('banner'),
  socials: jsonb('socials').$type<SocialLink[]>().notNull().default([]),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  modified: timestamp('modified', { withTimezone: true }).notNull().defaultNow(),
});

export const tokens = pgTable(
  'tokens',
  {
    id: text('id').primaryKey(),
    userAddress: text('userAddress')
      .notNull()
      .references(() => users.userAddress),
    jwt: text('jwt').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  table => [index('tokens_expiry_idx').on(table.expires)],
);

export const accounts = pgTable('accounts', {
  userAddress: text('userAddress')
    .primaryKey()
    .references(() => users.userAddress),
  network: text('network').notNull(),
  state: text('state').notNull(),
  code: text('code').notNull(),
  status: text('status').notNull(),
  spendingAddress: text('spendingAddress'),
  spendingState: text('spendingState'),
  transaction: text('transaction'),
  signed: text('signed'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
});

export const links = pgTable(
  'links',
  {
    id: text('id').primaryKey(),
    userAddress: text('userAddress')
      .notNull()
      .references(() => users.userAddress),
    network: text('network').notNull(),
    address: text('address').notNull(),
    publicKey: text('publicKey').notNull(),
    status: text('status').notNull(),
    transaction: text('transaction'),
    authorization: jsonb('authorization').$type<Record<string, unknown>>(),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
    modified: timestamp('modified', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('links_wallet_key_idx').on(table.userAddress, table.publicKey),
    uniqueIndex('links_network_address_idx').on(table.network, table.address),
  ],
);

export const credentials = pgTable('credentials', {
  id: text('id').primaryKey(),
  userAddress: text('userAddress')
    .notNull()
    .references(() => users.userAddress),
  kind: text('kind').notNull(),
  proof: jsonb('proof').$type<Record<string, unknown>>().notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
});

export const identities = pgTable('identities', {
  id: text('id').primaryKey(),
  userAddress: text('userAddress')
    .notNull()
    .references(() => users.userAddress),
  provider: text('provider').notNull(),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
});

export const consents = pgTable(
  'consents',
  {
    id: text('id').primaryKey(),
    userAddress: text('userAddress')
      .notNull()
      .references(() => users.userAddress),
    policy: text('policy').notNull(),
    text: text('text').notNull(),
    checks: jsonb('checks').$type<{ terms: true; privacy: true }>().notNull(),
    token: text('token').notNull(),
    agent: text('agent'),
    accepted: timestamp('accepted', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [uniqueIndex('consents_identity_idx').on(table.userAddress, table.policy)],
);

export const workflows = pgTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    userAddress: text('userAddress').notNull(),
    name: text('name').notNull(),
    graph: jsonb('graph')
      .$type<Pick<Listing, 'nodes' | 'edges' | 'brief' | 'banner' | 'tasks' | 'coordinator'>>()
      .notNull(),
    terms: jsonb('terms').$type<Terms>(),
    published: timestamp('published', { withTimezone: true }),
    modified: timestamp('modified', { withTimezone: true }).notNull().defaultNow(),
    deleted: timestamp('deleted', { withTimezone: true }),
  },
  table => [
    index('workflows_owner_idx').on(table.userAddress, table.modified),
    index('workflows_published_idx').on(table.published),
  ],
);

export const coordinators = pgTable(
  'coordinators',
  {
    id: text('id').primaryKey(),
    userAddress: text('userAddress').notNull(),
    agentId: bigint('agentId', { mode: 'number' }).notNull(),
    walletAddress: text('walletAddress').notNull(),
    name: text('name').notNull(),
    image: text('image').notNull(),
    personality: text('personality').notNull(),
    model: text('model').notNull(),
    cid: text('cid').notNull(),
    txHash: text('txHash').notNull(),
    contractId: text('contractId').notNull(),
    network: text('network').notNull(),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('coordinators_owner_idx').on(table.userAddress, table.created),
    uniqueIndex('coordinators_wallet_idx').on(table.walletAddress),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflowId').notNull(),
    workflowName: text('workflowName').notNull(),
    userAddress: text('userAddress').notNull(),
    creatorAddress: text('creatorAddress').notNull(),
    network: text('network').notNull(),
    status: text('status').notNull(),
    durationMs: bigint('durationMs', { mode: 'number' }).notNull().default(0),
    composeBillWei: text('composeBillWei').notNull().default('0'),
    creatorFeeWei: text('creatorFeeWei').notNull().default('0'),
    platformFeeWei: text('platformFeeWei').notNull().default('0'),
    totalChargedWei: text('totalChargedWei').notNull().default('0'),
    txHash: text('txHash'),
    proofCid: text('proofCid'),
    steps: jsonb('steps').$type<Array<Record<string, unknown>>>().notNull(),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('runs_user_idx').on(table.userAddress, table.created),
    index('runs_creator_idx').on(table.creatorAddress, table.created),
  ],
);
