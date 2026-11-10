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
