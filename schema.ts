import { z } from 'zod';
import { MAX_TASK_TAGS, resolveCanonicalTasks } from './options.js';

export const kind = z.enum(['model', 'connector', 'agent']);
export const modelOperationCapability = z
  .object({
    modality: z.string().min(1).max(80),
    operation: z.string().min(1).max(120),
    sourceTypes: z.array(z.string().max(120)).max(32),
    input: z.array(z.string().max(80)).max(32),
    output: z.array(z.string().max(80)).max(32),
    pricingUnits: z.array(z.string().max(80)).max(32),
    streamable: z.boolean(),
  })
  .passthrough();
export const entry = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(200),
  description: z.string().max(10000),
  kind,
  groups: z.array(z.string().min(1).max(80)).max(16).optional(),
  subgroups: z.array(z.string().min(1).max(120)).max(24).optional(),
  modality: z.string().min(1).max(80).optional(),
  family: z.string().min(1).max(80).optional(),
  isFrontier: z.boolean().optional(),
  isLatest: z.boolean().optional(),
  logo: z.string().url().max(1024).optional(),
  input: z.array(z.string().min(1).max(80)).max(32).optional(),
  output: z.array(z.string().min(1).max(80)).max(32).optional(),
  type: z.union([z.string().min(1).max(120), z.array(z.string().min(1).max(120)).max(32)]).optional(),
  operations: z.array(modelOperationCapability).max(64).optional(),
});
export const step = z
  .object({
    label: z.string().min(1).max(200),
    kind,
    entry: entry.optional(),
    note: z.string().max(16000),
  })
  .superRefine((data, ctx) => {
    if (data.entry && data.entry.kind !== data.kind)
      ctx.addIssue({ code: 'custom', message: 'The catalog entry must match the step role.' });
  });
export const block = z.object({
  id: z.string().min(1).max(100),
  type: z.literal('step'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: step,
});
export const link = z.object({
  id: z.string().min(1).max(200),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
  type: z.literal('wire').optional(),
});
export const coordinator = z.object({
  id: z.string().trim().min(1).max(160),
  userAddress: z.string().trim().max(160).optional().default(''),
  agentId: z.number().int().min(0).optional().default(0),
  walletAddress: z.string().trim().min(2).max(160),
  name: z.string().trim().min(1).max(120),
  image: z.string().trim().max(2048).optional().default(''),
  personality: z.string().trim().max(8000).optional().default(''),
  model: z.string().trim().min(1).max(256),
  cid: z.string().trim().max(256).optional().default(''),
  txHash: z.string().trim().max(256).optional().default(''),
  contractId: z.string().trim().max(160).optional().default(''),
  network: z.string().trim().min(2).max(80),
  created: z.string().datetime().optional(),
});
export const graph = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    brief: z.string().max(32000).optional(),
    banner: z.string().max(524288).nullable().optional(),
    tasks: z.array(z.string().trim().min(1).max(64)).max(MAX_TASK_TAGS).optional(),
    coordinator: coordinator.nullable().optional(),
    nodes: z.array(block).max(500),
    edges: z.array(link).max(2000),
    modified: z.string().datetime(),
  })
  .superRefine((data, ctx) => {
    const ids = new Set(data.nodes.map(node => node.id));
    const edgeIds = new Set(data.edges.map(edge => edge.id));
    const routes = new Set(data.edges.map(edge => edge.source + '\0' + edge.target));
    if (
      ids.size !== data.nodes.length ||
      edgeIds.size !== data.edges.length ||
      routes.size !== data.edges.length
    )
      ctx.addIssue({ code: 'custom', message: 'Steps and connections must be unique.' });
    const adjacency = new Map<string, string[]>(data.nodes.map(node => [node.id, []]));
    for (const edge of data.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target))
        ctx.addIssue({ code: 'custom', message: 'A connection refers to a missing step.' });
      else adjacency.get(edge.source)!.push(edge.target);
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const walk = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const next of adjacency.get(id) ?? []) if (!walk(next)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (data.nodes.some(node => !walk(node.id)))
      ctx.addIssue({ code: 'custom', message: 'A workflow cannot contain circular connections.' });
  });
export const terms = z.object({
  creatorFee: z.number().int().min(1).max(3),
  tasks: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(12)
    .transform(val => resolveCanonicalTasks(val))
    .refine(val => val.length >= 1 && val.length <= MAX_TASK_TAGS, {
      message: 'Choose between 1 and 3 task categories.',
    }),
  description: z.string().trim().min(1).max(4000),
  cid: z.string().trim().min(1).max(256).optional(),
  chainWorkflowId: z.number().int().min(1).optional(),
  txHash: z.string().trim().min(1).max(256).optional(),
  contractId: z.string().trim().min(1).max(256).optional(),
});
export const socialPlatform = z.enum(['x', 'discord', 'github', 'google', 'telegram']);
export const socialLink = z.object({
  platform: socialPlatform,
  handle: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(512),
  verified: z.boolean().optional(),
  providerId: z.string().trim().max(160).optional(),
});
export const profile = z.object({
  name: z.string().trim().max(100),
  bio: z.string().max(1000),
  image: z.string().max(524288).nullable().optional(),
  banner: z.string().max(524288).nullable().optional(),
  socials: z.array(socialLink).max(10).optional(),
});

export type SocialPlatform = z.infer<typeof socialPlatform>;
export type SocialLink = z.infer<typeof socialLink>;
export type Coordinator = z.infer<typeof coordinator>;
export type Flow = z.infer<typeof graph>;
export type Terms = z.infer<typeof terms>;
export type Profile = z.infer<typeof profile>;
export type CreatorWallets = {
  near: string;
  evm: string | null;
  svm: string | null;
};
export type CreatorProfile = {
  userAddress: string;
  name: string;
  bio: string;
  image: string | null;
  banner: string | null;
  socials: SocialLink[];
  wallets?: CreatorWallets;
};
export type User = CreatorProfile & { consented: boolean };
export type Listing = Flow & {
  userAddress: string;
  creatorName?: string;
  creatorAvatar?: string | null;
  terms: Terms | null;
  published: string | null;
};
