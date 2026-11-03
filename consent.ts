import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { policy, text, type Consent } from './policy.js';
import { user } from './databases/client.js';
export { policy };
export const hash = createHash('sha256').update(text).digest('hex');
const input = z.object({ policy: z.string().regex(/^[a-f0-9]{64}$/), terms: z.literal(true), privacy: z.literal(true) });
export async function read(userAddress: string): Promise<Consent | null> {
    const [row] = await user`SELECT id,policy,accepted FROM consents WHERE "userAddress"=${userAddress} AND policy=${hash}`;
    return row ? { id: row.id, policy: row.policy, accepted: new Date(row.accepted).toISOString() } : null;
}
export async function accept(body: unknown, userAddress: string, token: string, agent?: string): Promise<Consent> {
    const data = input.parse(body);
    if (data.policy !== hash) throw Object.assign(new Error('The terms changed. Reload and review the current agreement.'), { statusCode: 409 });
    await user`INSERT INTO consents (id,"userAddress",policy,text,checks,token,agent) VALUES (${randomUUID()},${userAddress},${hash},${text},${JSON.stringify({ terms: data.terms, privacy: data.privacy })}::jsonb,${token},${agent?.slice(0, 1024) ?? null}) ON CONFLICT ("userAddress",policy) DO NOTHING`;
    return (await read(userAddress))!;
}
