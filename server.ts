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
