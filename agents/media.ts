import { config } from '../config.js';

export const GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';

export const MAN0_BRAND_STYLE =
  'Stealth-glass futuristic aesthetic on deep void obsidian (#020305) and smoked dark glass (#090c12) with bioluminescent electric sky (#38bdf8), signal crimson (#ff2e63), sea emerald (#10b981), and violet (#a855f7) accents. Glass panels, crisp specular hairline borders, and subtle glow effects.';

interface Part {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Part[];
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface MediaLogoHint {
  name: string;
  url?: string;
}

export interface MediaInput {
  title?: string;
  description?: string;
  logos?: MediaLogoHint[];
}

export interface MediaDeps {
  fetchImpl?: typeof fetch;
}

const RASTER_LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function fetchRasterLogoParts(
  logos: MediaLogoHint[] | undefined,
  fetchImpl: typeof fetch,
): Promise<Part[]> {
  if (!logos || logos.length === 0) return [];
  const candidates = logos
    .filter(item => typeof item.url === 'string' && /^https?:\/\//i.test(item.url) && !/\.svg(?:$|\?)/i.test(item.url))
    .slice(0, 4);
  if (candidates.length === 0) return [];

  const parts = await Promise.all(
    candidates.map(async (item): Promise<Part | null> => {
      try {
        const res = await fetchImpl(item.url!, {
          method: 'GET',
          signal: AbortSignal.timeout(3_500),
        });
        if (!res.ok) return null;
        const contentType = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
        if (!RASTER_LOGO_MIMES.has(contentType)) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 524_288) return null;
        return {
          inlineData: {
            mimeType: contentType,
            data: buf.toString('base64'),
          },
        };
      } catch {
        return null;
      }
    }),
  );

  return parts.filter((p): p is Part => p !== null);
}

async function generateImageBuffer(
  prompt: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  referenceParts: Part[] = [],
): Promise<{ bytes: Buffer; mimeType: string }> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(config.googleAiApiKey)}`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      contents: [
        {
          parts: [...referenceParts, { text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as GenerateContentResponse;
  if (!res.ok) {
    throw Object.assign(
      new Error(payload.error?.message || `Image generation failed (${res.status}).`),
      { statusCode: 502 },
    );
  }

  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(part => part.inlineData?.data);
  const rawBase64 = imagePart?.inlineData?.data;
  if (!rawBase64) {
    throw Object.assign(new Error('Model returned no image data.'), { statusCode: 502 });
  }

  const mimeType = imagePart?.inlineData?.mimeType || 'image/png';
  return {
    bytes: Buffer.from(rawBase64, 'base64'),
    mimeType,
  };
}

export async function pinBufferToIpfs(
  input: {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    name: string;
    keyvalues?: Record<string, string>;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ cid: string; imageUrl: string; uri: string }> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName);
  formData.append(
    'pinataMetadata',
    JSON.stringify({
      name: input.name,
      ...(input.keyvalues ? { keyvalues: input.keyvalues } : {}),
    }),
  );
  formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetchImpl('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.pinataJwt}`,
    },
    signal: AbortSignal.timeout(30_000),
    body: formData,
  });

  if (!res.ok) {
    throw Object.assign(new Error('Failed to pin generated image to IPFS.'), { statusCode: 502 });
  }

  const pinned = (await res.json()) as { IpfsHash: string };
  if (!pinned.IpfsHash) {
    throw Object.assign(new Error('Pinata returned no CID for generated image.'), {
      statusCode: 502,
    });
  }

  return {
    cid: pinned.IpfsHash,
    uri: `ipfs://${pinned.IpfsHash}`,
    imageUrl: `https://${config.pinataGateway}/ipfs/${pinned.IpfsHash}`,
  };
}

export function buildAvatarPrompt(title: string, description: string): string {
  return `Square portrait avatar icon for an autonomous AI coordinator persona named "${title}". Personality and role: ${description.slice(0, 240)}. ${MAN0_BRAND_STYLE} Centered geometric cybernetic emblem or abstract synthetic entity portrait, ultra-crisp vector-grade lighting, 1:1 square aspect ratio. Clean iconic design suitable for small avatar sizes, no text.`;
}

export function buildBannerPrompt(
  title: string,
  description: string,
  logos?: MediaLogoHint[],
): string {
  const uniqueBrands = [
    ...new Set(
      (logos ?? [])
        .map(item => item.name.trim())
        .filter(Boolean),
    ),
  ].slice(0, 6);

  const logosDirective =
    uniqueBrands.length > 0
      ? ` Feature sleek floating dark-glass node badges displaying the official brand logos/icons for ${uniqueBrands.join(', ')} (faithfully incorporating any provided reference logo icons) connected by luminous directed data streams.`
      : ' Feature sleek floating dark-glass orchestration nodes connected by luminous directed data streams.';

  return `Wide 16:6 cinematic hero banner for a workflow titled "${title}". Purpose: ${description.slice(0, 280)}. ${MAN0_BRAND_STYLE} Prominently render the exact title "${title}" in crisp, bold, modern geometric sans-serif display typography with clean high-contrast legibility.${logosDirective} Do not add any extra subtitles, gibberish words, or watermarks beyond the exact title "${title}" and the brand logos.`;
}

export async function generateAvatar(
  input: MediaInput,
  deps: MediaDeps = {},
): Promise<{ imageUrl: string; cid: string }> {
  const title = input.title?.trim() ?? '';
  const description = input.description?.trim() ?? '';
  if (!title || !description) {
    throw Object.assign(
      new Error('You should add Name + Description before generating an avatar'),
      { statusCode: 400 },
    );
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const prompt = buildAvatarPrompt(title, description);
  const { bytes, mimeType } = await generateImageBuffer(prompt, fetchImpl);
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const safeSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'avatar';
  const pinned = await pinBufferToIpfs(
    {
      bytes,
      mimeType,
      fileName: `man0-avatar-${safeSlug}.${ext}`,
      name: `man0-avatar-${safeSlug}`,
      keyvalues: { app: 'man0', kind: 'coordinator-avatar' },
    },
    fetchImpl,
  );

  return { imageUrl: pinned.imageUrl, cid: pinned.cid };
}

export async function generateBanner(
  input: MediaInput,
  deps: MediaDeps = {},
): Promise<{ imageUrl: string; cid: string }> {
  const title = input.title?.trim() ?? '';
  const description = input.description?.trim() ?? '';
  if (!title || !description) {
    throw Object.assign(
      new Error('You should add Title + Description before generating a banner'),
      { statusCode: 400 },
    );
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const referenceParts = await fetchRasterLogoParts(input.logos, fetchImpl);
  const prompt = buildBannerPrompt(title, description, input.logos);
  const { bytes, mimeType } = await generateImageBuffer(prompt, fetchImpl, referenceParts);
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const safeSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'banner';
  const pinned = await pinBufferToIpfs(
    {
      bytes,
      mimeType,
      fileName: `man0-banner-${safeSlug}.${ext}`,
      name: `man0-banner-${safeSlug}`,
      keyvalues: { app: 'man0', kind: 'workflow-banner' },
    },
    fetchImpl,
  );

  return { imageUrl: pinned.imageUrl, cid: pinned.cid };
}
