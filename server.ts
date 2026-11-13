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
