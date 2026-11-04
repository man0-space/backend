import { randomInt } from 'node:crypto';
import { digest } from './digest.js';

export function emailAvailable(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

const unavailable = () => Object.assign(
  new Error('Email sign-in is unavailable. Please try again later.'),
  { statusCode: 503 },
);

export async function startEmailVerification(
  email: string,
  createChallenge: (value: unknown) => Promise<string>,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw unavailable();

  const code = String(randomInt(100000, 1000000));
  const id = await createChallenge({ kind: 'email', email, codeHash: digest(code) });
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM?.trim() || 'auth@man0.space',
        to: [email],
        subject: `${code} is your verification code`,
        text: `Your verification code is ${code}. It expires in 5 minutes.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw unavailable();
  } catch {
    throw unavailable();
  }
  return { id, email, expiresIn: 300 };
}
