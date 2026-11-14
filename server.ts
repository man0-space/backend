import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import limit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ComposeSDK, createMemoryStorage } from '@compose-market/sdk';
import { config } from './config.js';
import {
  coordinator,
  graph,
  terms,
  profile,
  type Coordinator,
  type CreatorProfile,
  type Listing,
  type SocialLink,
} from './schema.js';
import { user, workflow } from './databases/client.js';
import { cache, cached, cacheDel, cacheMGet, cacheSet, composer, ready, close } from './databases/cache.js';
import * as workflows from './databases/workflows.js';
import * as coordinators from './databases/coordinators.js';
import * as token from './auth/token.js';
import { digest } from './auth/digest.js';
import { catalog, sdk } from './catalog.js';
import { optionsRoutes } from './options.js';
import * as consent from './consent.js';
import { routes, oauthRoutes, nearRoutes } from './auth/router.js';
import { emailAvailable } from './auth/email.js';
import {
  deriveAgentWallet,
  executeContractCall,
  resolveMainUserAddress,
  resolveUserAddressOnNetwork,
  viewNearContract,
} from './auth/account.js';
import { authProviders, providers, available } from './auth/config.js';
import { generateAvatar, generateBanner, pinBufferToIpfs, type MediaDeps } from './agents/media.js';
import { createVibeStream, type VibeDeps } from './agents/vibe.js';
import {
  decomposeWorkflowWaves,
  runWorkflow,
  type WorkflowAttachment,
  type WorkflowBillItem,
} from './agents/coordinator.js';
import { ProofAccumulator, pinProofBundleToIPFS } from './proof.js';
import {
  MAX_CREATOR_FEE_PERCENT,
  MIN_CREATOR_FEE_PERCENT,
  PLATFORM_FEE_PERCENT,
  abortWorkflowPayment,
  extractPaymentSignature,
  extractSessionToken,
  getPaymentContext,
  parseComposeToken,
  requireSessionPayment,
  settleWorkflowPayment,
  type Charge,
} from './payment.js';

const bearer = (authorization?: string) =>
  authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

const ipfsPinJsonBody = z.object({
  content: z.record(z.string(), z.unknown()),
  name: z.string().trim().min(1).max(200),
  keyvalues: z.record(z.string(), z.string()).optional(),
});

const ipfsPinFileBody = z.object({
  fileBase64: z.string().min(1).max(6_000_000),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200).optional(),
  keyvalues: z.record(z.string(), z.string()).optional(),
});

const uploadAttachmentBody = z.object({
  fileBase64: z.string().min(1).max(30_000_000),
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().max(160).optional(),
});

const workflowAttachmentSchema = z.object({
  type: z.enum(['image', 'audio', 'video', 'pdf', 'file', 'text', 'json']),
  url: z.string().trim().url().max(2048),
  mimeType: z.string().trim().max(160).optional(),
  name: z.string().trim().max(240).optional(),
  size: z.number().int().nonnegative().optional(),
  cid: z.string().trim().max(160).optional(),
  text: z.string().max(64_000).optional(),
});

function classifyAttachmentType(
  mimeType: string,
  fileName: string,
): WorkflowAttachment['type'] {
  const mime = mimeType.toLowerCase();
  const lowerName = fileName.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/.test(lowerName)) {
    return 'image';
  }
  if (mime.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|opus|flac|aac|webm)$/.test(lowerName)) {
    if (mime.startsWith('video/')) return 'video';
    return 'audio';
  }
  if (mime.startsWith('video/') || /\.(mp4|mov|mkv|avi)$/.test(lowerName)) {
    return 'video';
  }
  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'pdf';
  }
  if (mime === 'application/json' || lowerName.endsWith('.json')) {
    return 'json';
  }
  if (
    mime.startsWith('text/') ||
    /\.(txt|md|markdown|csv|tsv|xml|html?|ya?ml|ts|tsx|js|jsx|py|rs|sol|sql|log)$/.test(lowerName)
  ) {
    return 'text';
  }
  return 'file';
}

function extractInlineTextIfReadable(
  bytes: Buffer,
  type: WorkflowAttachment['type'],
): string | undefined {
  if (type !== 'text' && type !== 'json') return undefined;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return undefined;
  const decoded = bytes.subarray(0, Math.min(bytes.length, 64_000)).toString('utf8').trim();
  return decoded ? decoded.slice(0, 64_000) : undefined;
}

const optionalHttpUrl = z.preprocess((val) => {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}, z.string().url().max(1024).optional());

const mediaGenerateBody = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(8000).optional(),
  logos: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        url: optionalHttpUrl,
      }),
    )
    .max(12)
    .optional(),
});

const CATALOG_COORDINATORS_URL = 'https://agents.compose.market/agents?role=coordinator&limit=50';
const CATALOG_COORDINATORS_CACHE_KEY = 'man0:coordinators:catalog';

function resolveCatalogCoordinatorImage(row: Record<string, unknown>): string {
  for (const field of ['image', 'avatarUrl', 'avatar'] as const) {
    const raw = typeof row[field] === 'string' ? row[field].trim() : '';
    if (/^https?:\/\//i.test(raw)) return raw;
  }
  const rawImage = typeof row.image === 'string' ? row.image.trim() : '';
  if (rawImage.startsWith('ipfs://')) {
    const cidPath = rawImage.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return `${config.pinataGateway.replace(/\/+$/, '')}/ipfs/${cidPath}`;
  }
  return '';
}

function resolveCatalogCoordinatorCreated(row: Record<string, unknown>): string {
  if (typeof row.createdAt === 'string' && row.createdAt.trim()) {
    const parsed = Date.parse(row.createdAt.trim());
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof row.walletTimestamp === 'number' && Number.isFinite(row.walletTimestamp) && row.walletTimestamp > 0) {
    return new Date(row.walletTimestamp).toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

function mapCatalogRowToCoordinator(row: Record<string, unknown>): Coordinator | null {
  const walletAddress = typeof row.walletAddress === 'string' ? row.walletAddress.trim() : '';
  const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
  if (!walletAddress || role !== 'coordinator') return null;

  const name =
    typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Coordinator';
  const model =
    typeof row.model === 'string' && row.model.trim()
      ? row.model.trim()
      : typeof row.target === 'string' && row.target.trim()
        ? row.target.trim()
        : 'Coordinator';
  const personality =
    typeof row.description === 'string' && row.description.trim()
      ? row.description.trim()
      : '';
  const cid = typeof row.cid === 'string' ? row.cid.trim() : '';
  const network =
    typeof row.network === 'string' && row.network.trim()
      ? row.network.trim()
      : `near:${config.network}`;
  const userAddress = typeof row.creator === 'string' ? row.creator.trim() : '';
  const agentId =
    typeof row.agentId === 'number' && Number.isInteger(row.agentId) && row.agentId >= 0
      ? row.agentId
      : 0;

  return {
    id: walletAddress,
    userAddress,
    agentId,
    walletAddress,
    name,
    image: resolveCatalogCoordinatorImage(row),
    personality,
    model,
    cid,
    txHash: '',
    contractId: '',
    network,
    created: resolveCatalogCoordinatorCreated(row),
  };
}

const coordinatorMintBody = z.object({
  name: z.string().trim().min(1).max(120),
  image: z.string().trim().url().max(2048),
  personality: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(256),
  contractId: z.string().trim().min(2).max(128).optional(),
  network: z.enum(['near:mainnet', 'near:testnet']).optional(),
});

function parseMintedAgentIdFromOutcome(outcome: { result: unknown; logs: string[] }): number {
  if (
    typeof outcome.result === 'number' &&
    Number.isInteger(outcome.result) &&
    outcome.result > 0
  ) {
    return outcome.result;
  }
  if (typeof outcome.result === 'string') {
    const parsed = Number.parseInt(outcome.result, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  for (const log of outcome.logs) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(log.slice('EVENT_JSON:'.length)) as {
        event?: string;
        data?:
        | { agent_id?: number; token_ids?: string[] }
        | Array<{ agent_id?: number; token_ids?: string[] }>;
      };
      const payload = Array.isArray(event.data) ? event.data[0] : event.data;
      if (
        (event.event === 'agent_registered' || event.event === 'agent_minted') &&
        payload?.agent_id
      ) {
        return payload.agent_id;
      }
      if (event.event === 'nft_mint' && payload?.token_ids?.[0]) {
        const parsed = Number.parseInt(payload.token_ids[0], 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore non-JSON log lines
    }
  }
  throw Object.assign(
    new Error('Coordinator registration succeeded, but agent_id was not returned in outcome.'),
    { statusCode: 502 },
  );
}

const vibeRequestBody = z.object({
  prompt: z.string().trim().min(1).max(8000),
  flow: graph,
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(16000),
      }),
    )
    .max(20)
    .optional(),
});

export interface MissingConnectorRequirement {
  entryId: string;
  slug: string;
  name: string;
  type: 'account' | 'gated';
  userAddress?: string;
  missingVars?: Array<{ varName: string; description?: string; obtainUrl?: string }>;
  reason: string;
  agentWallet?: string;
  runId?: string;
  threadId?: string;
  requestId?: string;
}

export interface MissingInputRequirement {
  stepId: string;
  stepLabel: string;
  modelId?: string;
  modelName?: string;
  acceptedInputs: string[];
  questions?: string[];
  reason: string;
  agentWallet?: string;
  runId?: string;
  threadId?: string;
  proposalId?: string;
}

export interface ServerDeps {
  fetchImpl?: typeof fetch;
  mediaDeps?: MediaDeps;
  vibeDeps?: VibeDeps;
  viewContractImpl?: typeof viewNearContract;
  executeContractImpl?: typeof executeContractCall;
}

export async function build(deps: ServerDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const viewContract = deps.viewContractImpl ?? viewNearContract;
  const executeContract = deps.executeContractImpl ?? executeContractCall;
  const app = Fastify({
    bodyLimit: 8_388_608,
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
  });
  await app.register(cors, {
    origin: config.origins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-Transaction-Hash', 'X-Receipt'],
  });
  await app.register(limit, { max: 120, timeWindow: '1 minute' });

  app.setErrorHandler((error, _request, reply) => {
    const failure = error as {
      statusCode?: number;
      status?: number;
      expose?: boolean;
      code?: string;
      name?: string;
      message?: string;
      threadId?: string;
      missing?: MissingConnectorRequirement[];
      missingInputs?: MissingInputRequirement[];
    };
    const status = error instanceof ZodError ? 400 : failure.statusCode ?? failure.status ?? 503;
    if (status >= 500) app.log.error({ err: error, code: failure.code, name: failure.name }, 'Service request failed');
    reply.code(status).send({
      ...(status < 500 && failure.code ? { code: failure.code } : {}),
      ...(status < 500 && failure.threadId ? { threadId: failure.threadId } : {}),
      ...(status < 500 && Array.isArray(failure.missing) ? { missing: failure.missing } : {}),
      ...(status < 500 && Array.isArray(failure.missingInputs)
        ? { missingInputs: failure.missingInputs }
        : {}),
      error:
        status === 400 && error instanceof ZodError
          ? Array.from(new Set(error.issues.map(issue => issue.message))).join(' ')
          : status < 500 || failure.expose === true
            ? failure.message
            : 'A required service is unavailable. Please try again.',
    });
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await Promise.all([
        user`SELECT 1`,
        workflow`SELECT 1`,
        cache.ping(),
        composer.ping(),
      ]);
      return { status: 'ready', users: true, workflows: true, cache: true, composer: true };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });

  const profileCacheKey = (identifier: string) => `profile:${identifier.trim().toLowerCase()}`;

  function toProfileSlug(raw: string): string {
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return decoded
      .trim()
      .replace(/^@+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function looksLikeWalletAddress(raw: string): boolean {
    const s = raw.trim();
    return (
      /^0u[a-z0-9]{18,}$/i.test(s) ||
      /^0x[a-f0-9]{40}$/i.test(s) ||
      /^[a-f0-9]{64}$/i.test(s) ||
      /\.(?:near|testnet)$/i.test(s) ||
      /^(?=.*[0-9A-Z])[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s)
    );
  }

  async function loadCreatorWallets(
    canonicalAddresses: string[],
  ): Promise<Map<string, { near: string; evm: string | null; svm: string | null }>> {
    const map = new Map<string, { near: string; evm: string | null; svm: string | null }>();
    if (canonicalAddresses.length === 0) return map;
    for (const addr of canonicalAddresses) {
      map.set(addr.toLowerCase(), { near: addr, evm: null, svm: null });
    }
    const linkRows = await user`
      SELECT "userAddress", network, address, status
      FROM links
      WHERE LOWER("userAddress") = ANY(${canonicalAddresses.map(a => a.toLowerCase())})
        AND status <> 'failed'
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created ASC
    `;
    for (const row of linkRows) {
      const uaLower = String(row.userAddress ?? '').trim().toLowerCase();
      const entry = map.get(uaLower);
      if (!entry) continue;
      const net = String(row.network ?? '').toLowerCase();
      const addr = String(row.address ?? '').trim();
      if (!addr) continue;
      if (net === 'evm' && !entry.evm) entry.evm = addr;
      if (net === 'svm' && !entry.svm) entry.svm = addr;
    }
    return map;
  }

  async function loadCreatorProfiles(rawAddresses: string[]): Promise<Map<string, CreatorProfile>> {
    await token.ensureUserColumns();
    const result = new Map<string, CreatorProfile>();
    const uniqueByLower = new Map<string, string>();
    for (const raw of rawAddresses) {
      const trimmed = String(raw ?? '').trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!uniqueByLower.has(lower)) {
        uniqueByLower.set(lower, trimmed);
      }
    }
    if (uniqueByLower.size === 0) return result;

    const lowerAddresses = [...uniqueByLower.keys()];
    const cacheKeys = lowerAddresses.map(lower => `profile:${lower}`);
    const cachedMap = await cacheMGet<CreatorProfile>(cacheKeys, 30_000);
    const missingLower: string[] = [];

    for (const lower of lowerAddresses) {
      const hit = cachedMap.get(`profile:${lower}`);
      if (hit && hit.userAddress && hit.wallets) {
        result.set(lower, hit);
      } else {
        missingLower.push(lower);
      }
    }

    if (missingLower.length > 0) {
      const missingSlugs = [
        ...new Set(missingLower.map(item => toProfileSlug(item)).filter(Boolean)),
      ];

      const [directRows, linkedRows] = await Promise.all([
        user`
          SELECT "userAddress", name, bio, image, banner, socials
          FROM users
          WHERE LOWER("userAddress") = ANY(${missingLower})
             OR (
               TRIM(name) <> ''
               AND (
                 LOWER(TRIM(name)) = ANY(${missingLower})
                 OR TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(TRIM(name)), '[^a-z0-9]+', '-', 'g')) = ANY(${missingSlugs})
               )
             )
        `,
        user`
          SELECT "userAddress", LOWER(address) AS "linkedLower"
          FROM links
          WHERE LOWER(address) = ANY(${missingLower})
            AND status <> 'failed'
        `,
      ]);

      const dbByCanonicalLower = new Map<string, Record<string, unknown>>();
      for (const row of directRows) {
        const ua = String(row.userAddress ?? '').trim();
        if (ua) dbByCanonicalLower.set(ua.toLowerCase(), row);
      }

      const linkedOwnerByAddrLower = new Map<string, string>();
      const extraCanonicalLower: string[] = [];
      for (const linkRow of linkedRows) {
        const ua = String(linkRow.userAddress ?? '').trim();
        const linkedLower = String(linkRow.linkedLower ?? '').trim();
        if (!ua || !linkedLower) continue;
        linkedOwnerByAddrLower.set(linkedLower, ua.toLowerCase());
        if (!dbByCanonicalLower.has(ua.toLowerCase())) {
          extraCanonicalLower.push(ua.toLowerCase());
        }
      }

      if (extraCanonicalLower.length > 0) {
        const extraRows = await user`
          SELECT "userAddress", name, bio, image, banner, socials
          FROM users
          WHERE LOWER("userAddress") = ANY(${extraCanonicalLower})
        `;
        for (const row of extraRows) {
          const ua = String(row.userAddress ?? '').trim();
          if (ua) dbByCanonicalLower.set(ua.toLowerCase(), row);
        }
      }

      const byNameLower = new Map<string, Record<string, unknown>>();
      const bySlug = new Map<string, Record<string, unknown>>();
      const canonicalList: string[] = [];
      for (const row of dbByCanonicalLower.values()) {
        const ua = String(row.userAddress ?? '').trim();
        if (ua) canonicalList.push(ua);
        const cleanName = String(row.name ?? '').trim();
        if (cleanName) {
          byNameLower.set(cleanName.toLowerCase(), row);
          const slug = toProfileSlug(cleanName);
          if (slug) bySlug.set(slug, row);
        }
      }

      const walletsMap = await loadCreatorWallets(canonicalList);

      await Promise.all(
        missingLower.map(async lower => {
          const rawOriginal = uniqueByLower.get(lower) ?? lower;
          const slug = toProfileSlug(rawOriginal);
          const linkedOwnerLower = linkedOwnerByAddrLower.get(lower);
          const row =
            dbByCanonicalLower.get(lower) ??
            (linkedOwnerLower ? dbByCanonicalLower.get(linkedOwnerLower) : undefined) ??
            byNameLower.get(lower) ??
            (slug ? bySlug.get(slug) : undefined);

          if (row) {
            const canonicalAddress = String(row.userAddress);
            const wallets = walletsMap.get(canonicalAddress.toLowerCase()) ?? {
              near: canonicalAddress,
              evm: null,
              svm: null,
            };
            const hydrated: CreatorProfile = {
              userAddress: canonicalAddress,
              name: String(row.name ?? '').trim(),
              bio: String(row.bio ?? ''),
              image: row.image ? String(row.image) : null,
              banner: row.banner ? String(row.banner) : null,
              socials: Array.isArray(row.socials) ? (row.socials as SocialLink[]) : [],
              wallets,
            };
            result.set(lower, hydrated);
            result.set(canonicalAddress.toLowerCase(), hydrated);
            await Promise.all([
              cacheSet(`profile:${lower}`, hydrated, 300, 30_000),
              lower !== canonicalAddress.toLowerCase()
                ? cacheSet(`profile:${canonicalAddress.toLowerCase()}`, hydrated, 300, 30_000)
                : Promise.resolve(),
            ]);
          } else {
            const fallbackAddr = looksLikeWalletAddress(rawOriginal) ? rawOriginal : '';
            const emptyProfile: CreatorProfile = {
              userAddress: fallbackAddr,
              name: '',
              bio: '',
              image: null,
              banner: null,
              socials: [],
              wallets: { near: fallbackAddr, evm: null, svm: null },
            };
            result.set(lower, emptyProfile);
          }
        }),
      );
    }

    return result;
  }

  async function attachCreatorProfiles(items: Listing[]): Promise<Listing[]> {
    if (items.length === 0) return items;
    const byLower = await loadCreatorProfiles(items.map(item => item.userAddress));
    return items.map(item => {
      const meta = byLower.get(item.userAddress.trim().toLowerCase());
      if (!meta) return item;
      const trimmedName = meta.name.trim();
      return {
        ...item,
        ...(trimmedName ? { creatorName: trimmedName } : {}),
        ...(meta.image ? { creatorAvatar: meta.image } : {}),
      };
    });
  }

  app.get('/api/config', async () => {
    const creatorOptions: number[] = [];
    for (let fee = MIN_CREATOR_FEE_PERCENT; fee <= MAX_CREATOR_FEE_PERCENT; fee += 1) {
      creatorOptions.push(fee);
    }
    return {
      providers: authProviders.map(spec => ({ id: spec.id, available: available(spec) })),
      linkProviders: providers.map(spec => ({ id: spec.id, available: available(spec) })),
      passkey: { create: true, login: true },
      email: { enabled: emailAvailable() },
      fees: {
        creatorOptions,
        platformPercent: PLATFORM_FEE_PERCENT,
      },
    };
  });

  await app.register(optionsRoutes);
  await app.register(routes, { prefix: '/api/auth' });
  await app.register(nearRoutes, { prefix: '/api/near' });
  await app.register(oauthRoutes, { prefix: '/api/oauth' });
  await app.register(oauthRoutes, { prefix: '/oauth' });

  app.post('/api/ipfs/pin/json', async request => {
    await token.authorize(bearer(request.headers.authorization));
    const body = ipfsPinJsonBody.parse(request.body);
    const res = await fetchImpl('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.pinataJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pinataOptions: { cidVersion: 1 },
        pinataContent: body.content,
        pinataMetadata: {
          name: body.name,
          ...(body.keyvalues ? { keyvalues: body.keyvalues } : {}),
        },
      }),
    });
    if (!res.ok) {
      throw Object.assign(new Error('Failed to pin metadata to IPFS.'), { statusCode: 502 });
    }
    const pinned = (await res.json()) as { IpfsHash: string; PinSize: number };
    return {
      cid: pinned.IpfsHash,
      uri: `ipfs://${pinned.IpfsHash}`,
      url: `https://${config.pinataGateway}/ipfs/${pinned.IpfsHash}`,
      size: pinned.PinSize,
    };
  });

  app.post('/api/ipfs/pin/file', async request => {
    await token.authorize(bearer(request.headers.authorization));
    const body = ipfsPinFileBody.parse(request.body);
    const bytes = Buffer.from(body.fileBase64, 'base64');
    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: body.mimeType }), body.fileName);
    formData.append(
      'pinataMetadata',
      JSON.stringify({
        name: body.name ?? body.fileName,
        ...(body.keyvalues ? { keyvalues: body.keyvalues } : {}),
      }),
    );
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const res = await fetchImpl('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.pinataJwt}`,
      },
      body: formData,
    });
    if (!res.ok) {
      throw Object.assign(new Error('Failed to pin file to IPFS.'), { statusCode: 502 });
    }
    const pinned = (await res.json()) as { IpfsHash: string; PinSize: number };
    return {
      cid: pinned.IpfsHash,
      uri: `ipfs://${pinned.IpfsHash}`,
      url: `https://${config.pinataGateway}/ipfs/${pinned.IpfsHash}`,
      size: pinned.PinSize,
    };
  });

  app.post(
    '/api/uploads',
    { bodyLimit: 32 * 1024 * 1024 },
    async request => {
      await token.authorize(bearer(request.headers.authorization));
      const body = uploadAttachmentBody.parse(request.body);
      const stripped = body.fileBase64.replace(/^data:[^,]*;base64,/i, '').trim();
      const bytes = Buffer.from(stripped, 'base64');
      if (bytes.length === 0) {
        throw Object.assign(new Error('Uploaded file is empty.'), { statusCode: 400 });
      }
      if (bytes.length > 20 * 1024 * 1024) {
        throw Object.assign(new Error('Attachment exceeds the 20 MB limit.'), { statusCode: 413 });
      }
      const safeName = body.fileName.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 200) || 'attachment';
      const mimeType = (body.mimeType || 'application/octet-stream').trim();
      const type = classifyAttachmentType(mimeType, safeName);
      const pinned = await pinBufferToIpfs(
        {
          bytes,
          mimeType,
          fileName: safeName,
          name: `man0-run-${safeName}`,
          keyvalues: { app: 'man0', kind: 'workflow-attachment', modality: type },
        },
        fetchImpl,
      );
      const text = extractInlineTextIfReadable(bytes, type);
      return {
        cid: pinned.cid,
        uri: pinned.uri,
        url: pinned.imageUrl,
        name: safeName,
        mimeType,
        size: bytes.length,
        type,
        ...(text ? { text } : {}),
      } satisfies WorkflowAttachment & { uri: string };
    },
  );

  app.post('/api/generate-avatar', async request => {
    await token.authorize(bearer(request.headers.authorization));
    const body = mediaGenerateBody.parse(request.body ?? {});
    const result = await generateAvatar(body, deps.mediaDeps ?? { fetchImpl });
    return { imageUrl: result.imageUrl, cid: result.cid };
  });

  app.post('/api/generate-banner', async request => {
    await token.authorize(bearer(request.headers.authorization));
    const body = mediaGenerateBody.parse(request.body ?? {});
    const result = await generateBanner(body, deps.mediaDeps ?? { fetchImpl });
    return { imageUrl: result.imageUrl, cid: result.cid };
  });

  async function fetchCatalogCoordinators(): Promise<Coordinator[]> {
    const load = async (): Promise<Coordinator[]> => {
      const res = await fetchImpl(CATALOG_COORDINATORS_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        throw new Error(`Unable to fetch Coordinator catalog (${res.status}).`);
      }
      const payload = (await res.json()) as unknown;
      const rows: Array<Record<string, unknown>> = Array.isArray(payload)
        ? (payload as Array<Record<string, unknown>>)
        : payload && typeof payload === 'object'
          ? (((payload as { agents?: unknown; data?: unknown }).agents ??
            (payload as { data?: unknown }).data ??
            []) as Array<Record<string, unknown>>)
          : [];
      return rows
        .map(row => mapCatalogRowToCoordinator(row))
        .filter((item): item is Coordinator => Boolean(item));
    };
    if (fetchImpl !== globalThis.fetch) {
      return load().catch(() => []);
    }
    return cached(CATALOG_COORDINATORS_CACHE_KEY, 15, 5_000, load).catch(() => []);
  }

  async function listAvailableCoordinators(): Promise<Coordinator[]> {
    const [catalogRows, dbRows] = await Promise.all([
      fetchCatalogCoordinators(),
      coordinators.listAll().catch(() => [] as Coordinator[]),
    ]);

    const byWallet = new Map<string, Coordinator>();
    for (const item of catalogRows) {
      byWallet.set(item.walletAddress.toLowerCase(), item);
    }
    for (const dbItem of dbRows) {
      const key = dbItem.walletAddress.toLowerCase();
      const existing = byWallet.get(key);
      if (existing) {
        const hasCatalogTimestamp =
          existing.created && existing.created !== '1970-01-01T00:00:00.000Z';
        byWallet.set(key, {
          ...existing,
          id: dbItem.id || existing.id,
          userAddress: dbItem.userAddress || existing.userAddress,
          agentId: dbItem.agentId || existing.agentId,
          image: dbItem.image || existing.image,
          personality: dbItem.personality || existing.personality,
          cid: dbItem.cid || existing.cid,
          txHash: dbItem.txHash || existing.txHash,
          contractId: dbItem.contractId || existing.contractId,
          created: hasCatalogTimestamp ? existing.created : dbItem.created,
        });
      } else {
        byWallet.set(key, dbItem);
      }
    }

    return Array.from(byWallet.values()).sort((a, b) => {
      const ta = Date.parse(a.created ?? '1970-01-01T00:00:00.000Z');
      const tb = Date.parse(b.created ?? '1970-01-01T00:00:00.000Z');
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }

  app.get('/api/coordinators', async () => {
    return listAvailableCoordinators();
  });

  app.post('/api/coordinators/mint', async request => {
    const authUser = await token.authorize(bearer(request.headers.authorization));
    const body = coordinatorMintBody.parse(request.body);
    const targetContract = body.contractId ?? config.contracts.factory;
    const targetNetwork: 'near:testnet' | 'near:mainnet' =
      body.network ?? (targetContract.endsWith('.testnet') ? 'near:testnet' : 'near:mainnet');
    const shortNet = targetNetwork === 'near:testnet' ? 'testnet' : 'mainnet';

    const resolvedCreator = await resolveUserAddressOnNetwork(authUser.userAddress, shortNet).catch(
      () => null,
    );
    const creatorAddress = resolvedCreator?.signerId ?? authUser.userAddress;
    const timestamp = Date.now();
    const walletAddress = deriveAgentWallet(
      `${creatorAddress}:${targetContract}:${body.model.trim()}:${body.name.trim()}`,
      timestamp,
      shortNet,
    );

    const pinName = `man0-coordinator-${body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 48) || 'persona'}`;

    const pinRes = await fetchImpl('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.pinataJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pinataOptions: { cidVersion: 1 },
        pinataMetadata: {
          name: pinName,
          keyvalues: {
            app: 'man0',
            role: 'coordinator',
            type: 'agent-card',
            network: targetNetwork,
          },
        },
        pinataContent: {
          schemaVersion: '1.0.0',
          name: body.name.trim(),
          description: body.personality.trim(),
          role: 'coordinator',
          framework: 'man0',
          model: body.model.trim(),
          image: body.image,
          avatar: body.image,
          walletAddress,
          network: targetNetwork,
          x402: true,
          x402Support: true,
          licensePrice: '0',
          creatorFee: 0,
          licenses: 0,
          cloneable: false,
          skills: [],
          connectors: [],
          protocols: [{ name: 'Man0', version: '1.0' }],
          createdAt: new Date().toISOString(),
          creator: creatorAddress,
        },
      }),
    });

    if (!pinRes.ok) {
      throw Object.assign(new Error('Failed to pin Coordinator card metadata to IPFS.'), {
        statusCode: 502,
      });
    }
    const pinned = (await pinRes.json()) as { IpfsHash: string };
    const cardUri = `ipfs://${pinned.IpfsHash}`;

    const registered = await executeContract(authUser.userAddress, {
      contractId: targetContract,
      methodName: 'register_agent',
      args: {
        uri: cardUri,
        metadata: [
          {
            key: 'cardUri',
            value: Buffer.from(cardUri, 'utf8').toString('base64'),
          },
        ],
      },
      deposit: '0',
      gas: 80_000_000_000_000,
    });
    const agentId = parseMintedAgentIdFromOutcome(registered);

    await executeContract(authUser.userAddress, {
      contractId: targetContract,
      methodName: 'set_agent_wallet',
      args: {
        agent_id: agentId,
        new_wallet: walletAddress,
      },
      deposit: '0',
      gas: 60_000_000_000_000,
    });

    const upsertRes = await fetchImpl('https://agents.compose.market/agents/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        cid: pinned.IpfsHash,
        walletAddress,
      }),
    }).catch(() => null);

    if (upsertRes && !upsertRes.ok) {
      app.log.warn(
        { status: upsertRes.status, walletAddress },
        'agents.compose.market upsert returned non-OK status',
      );
    }

    const created = await coordinators.create({
      userAddress: authUser.userAddress,
      agentId,
      walletAddress,
      name: body.name.trim(),
      image: body.image,
      personality: body.personality.trim(),
      model: body.model.trim(),
      cid: pinned.IpfsHash,
      txHash: registered.txHash,
      contractId: targetContract,
      network: targetNetwork,
    });
    await cacheDel(CATALOG_COORDINATORS_CACHE_KEY);
    return created;
  });

  app.post('/api/vibe', async (request, reply) => {
    const authUser = await token.authorize(bearer(request.headers.authorization));
    const body = vibeRequestBody.parse(request.body);
    const abortController = new AbortController();
    request.raw.on('close', () => {
      if (!request.raw.complete) abortController.abort();
    });

    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('cache-control', 'no-cache, no-transform');
    reply.header('x-accel-buffering', 'no');

    return reply.send(
      createVibeStream(
        {
          prompt: body.prompt,
          flow: body.flow,
          userAddress: authUser.userAddress,
          history: body.history,
          signal: abortController.signal,
        },
        deps.vibeDeps ?? { fetchImpl, logger: app.log },
      ),
    );
  });

  app.get('/api/policy', async () => ({ hash: consent.hash, ...consent.policy }));
  app.get('/api/consent', async request =>
    consent.read((await token.read(bearer(request.headers.authorization))).userAddress),
  );
  app.post('/api/consent', async request => {
    const raw = bearer(request.headers.authorization);
    const user = await token.read(raw);
    const accepted = await consent.accept(
      request.body,
      user.userAddress,
      digest(raw!),
      request.headers['user-agent'],
    );
    await token.invalidateUserSessions(user.userAddress, raw);
    return accepted;
  });
  app.get('/api/user', async request =>
    token.read(bearer(request.headers.authorization), { reconcileIfNeeded: true }),
  );
  app.delete('/api/auth', async (request, reply) => {
    const raw = bearer(request.headers.authorization);
    const current = await token.read(raw);
    await Promise.all([
      token.destroy(raw!),
      token.invalidateUserSessions(current.userAddress, raw),
    ]);
    reply.code(204).send();
  });
  app.get('/api/profile/:address', async request => {
    const address = z
      .string()
      .trim()
      .min(2)
      .max(160)
      .parse((request.params as { address: string }).address);
    const loaded = await loadCreatorProfiles([address]);
    return (
      loaded.get(address.toLowerCase()) ?? {
        userAddress: address,
        name: '',
        bio: '',
        image: null,
        banner: null,
        socials: [],
      }
    ) satisfies CreatorProfile;
  });

  app.get('/api/profiles', async request => {
    const query = z
      .object({
        addresses: z.string().max(16_000).optional(),
      })
      .parse(request.query);
    const list = (query.addresses ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(s => s.length >= 2 && s.length <= 160)
      .slice(0, 100);
    const loaded = await loadCreatorProfiles(list);
    const profiles: Record<string, CreatorProfile> = {};
    for (const [lower, item] of loaded.entries()) {
      profiles[lower] = item;
    }
    return { profiles };
  });

  app.put('/api/profile', async request => {
    await token.ensureUserColumns();
    const raw = bearer(request.headers.authorization);
    const account = await token.authorize(raw);
    const data = profile.parse(request.body);
    const nextImage = data.image === undefined ? account.image : data.image || null;
    const nextBanner = data.banner === undefined ? account.banner : data.banner || null;

    let nextSocials = account.socials;
    if (data.socials !== undefined) {
      const deduped = new Map<string, SocialLink>();
      for (const item of data.socials) {
        deduped.set(item.platform, item);
      }
      nextSocials = [...deduped.values()];

      if (nextSocials.length > 0) {
        const others = await user`
          SELECT "userAddress", socials
          FROM users
          WHERE "userAddress" <> ${account.userAddress}
            AND jsonb_typeof(socials) = 'array'
            AND jsonb_array_length(socials) > 0
        `;
        const normHandle = (h: string) => h.trim().replace(/^@+/, '').toLowerCase();
        for (const incoming of nextSocials) {
          const incomingPid = incoming.providerId?.trim().toLowerCase();
          const incomingH = normHandle(incoming.handle);
          for (const other of others) {
            const existingList = Array.isArray(other.socials)
              ? (other.socials as SocialLink[])
              : [];
            for (const existing of existingList) {
              const existingPid = existing.providerId?.trim().toLowerCase();
              if (incomingPid && existingPid && incomingPid === existingPid) {
                throw Object.assign(
                  new Error('Account already linked to a different creator.'),
                  { statusCode: 409 },
                );
              }
              if (
                existing.platform === incoming.platform &&
                incomingH &&
                normHandle(existing.handle) === incomingH
              ) {
                throw Object.assign(
                  new Error('Account already linked to a different creator.'),
                  { statusCode: 409 },
                );
              }
            }
          }
        }
      }
    }

    const [updated] = await user`
      UPDATE users
      SET name = ${data.name},
          bio = ${data.bio},
          image = ${nextImage},
          banner = ${nextBanner},
          socials = ${JSON.stringify(nextSocials)}::jsonb,
          modified = now()
      WHERE "userAddress" = ${account.userAddress}
      RETURNING "userAddress", name, bio, image, banner, socials
    `;
    const normalized = token.normalizeUserRow(updated, account.consented);
    const walletsMap = await loadCreatorWallets([normalized.userAddress]);
    const wallets = walletsMap.get(normalized.userAddress.toLowerCase()) ?? {
      near: normalized.userAddress,
      evm: null,
      svm: null,
    };
    const updatedCreatorProfile: CreatorProfile = {
      userAddress: normalized.userAddress,
      name: normalized.name,
      bio: normalized.bio,
      image: normalized.image,
      banner: normalized.banner,
      socials: normalized.socials,
      wallets,
    };
    const staleProfileKeys = new Set<string>([
      workflows.MARKET_LIST_CACHE_KEY,
      workflows.userWorkflowsCacheKey(account.userAddress),
    ]);
    for (const rawName of [account.name, normalized.name]) {
      const trimmed = (rawName ?? '').trim();
      if (!trimmed) continue;
      staleProfileKeys.add(profileCacheKey(trimmed));
      const slug = toProfileSlug(trimmed);
      if (slug) staleProfileKeys.add(profileCacheKey(slug));
    }
    await Promise.all([
      cacheSet(profileCacheKey(account.userAddress), updatedCreatorProfile, 300, 30_000),
      cacheDel(...staleProfileKeys),
      token.invalidateUserSessions(account.userAddress, raw),
    ]);
    return normalized;
  });

  return app;
}
