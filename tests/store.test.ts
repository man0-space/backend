import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, randomBytes } from 'node:crypto';
import { ready, cache, composer } from '../databases/cache.js';
import { workflow, user } from '../databases/client.js';
import * as workflows from '../databases/workflows.js';
import { terms } from '../schema.js';
import { verifyTelegramAuthData } from '../auth/oauth.js';
import { digest } from '../auth/digest.js';
import { build } from '../server.js';
const userAddress = `test:${randomUUID()}`, other = `test:${randomUUID()}`;
import { privateKey, issuer } from '../auth/config.js';
import { sign } from '../auth/token.js';
const token = await sign(privateKey, issuer!, userAddress, randomBytes(32).toString('base64url'), 3600);
const otherToken = await sign(privateKey, issuer!, other, randomBytes(32).toString('base64url'), 3600);
const flow = { id: randomUUID(), name: 'Persistence verification', brief: 'Check persistence', banner: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', nodes: [{ id: randomUUID(), type: 'step' as const, position: { x: 0, y: 0 }, data: { label: 'Research', kind: 'model' as const, note: '' } }], edges: [], modified: new Date().toISOString() };
let app: Awaited<ReturnType<typeof build>>;
before(async () => { await ready(); app = await build(); await user`INSERT INTO users ("userAddress",name) VALUES (${userAddress},'Consent verification'),(${other},'Other creator')`; await user`INSERT INTO tokens(id,"userAddress",jwt,expires) VALUES (${digest(token)},${userAddress},'test fixture',now()+interval '1 hour'),(${digest(otherToken)},${other},'test fixture 2',now()+interval '1 hour')`; });
after(async () => { await workflow`DELETE FROM runs WHERE "userAddress" IN (${userAddress},${other})`; await workflow`DELETE FROM workflows WHERE "userAddress" IN (${userAddress},${other})`; await user`DELETE FROM consents WHERE "userAddress" IN (${userAddress},${other})`; await user`DELETE FROM tokens WHERE "userAddress" IN (${userAddress},${other})`; await user`DELETE FROM users WHERE "userAddress" IN (${userAddress},${other})`; await composer.del(`draft:${digest(userAddress)}:${flow.id}`, `draft:${digest(userAddress)}:active`); await app.close(); });
test('saved graph survives a database read and financial terms exist only after publication', async () => { const saved = await workflows.save(flow, userAddress); assert.equal(saved.terms, null); assert.equal(saved.published, null); assert.equal((await workflows.get(flow.id, userAddress)).brief, flow.brief); await assert.rejects(workflows.get(flow.id, other)); await assert.rejects(workflows.save({ ...flow, name: 'Foreign edit' }, other, saved.modified)); const published = await workflows.publish(flow.id, userAddress, { creatorFee: 2, tasks: ['Research'], description: 'Check public listing' }, saved.modified); assert.equal(published.terms?.creatorFee, 2); assert.ok(published.published); assert.equal((await workflows.get(flow.id)).name, flow.name); assert.ok((await workflows.list()).some(row => row.id === flow.id)); await assert.rejects(workflows.save(flow, userAddress, published.modified)); });
test('COMPOSER persists drafts with 24h TTL, rejects stale edits, and clears on save or DELETE /api/draft', async () => {
  const wipFlow = { ...flow, id: randomUUID() };
  const first = await workflows.draft(wipFlow, userAddress);
  const draftKey = `draft:${digest(userAddress)}:${wipFlow.id}`;
  const activeKey = `draft:${digest(userAddress)}:active`;
  const ttlDraft = await composer.ttl(draftKey);
  const ttlActive = await composer.ttl(activeKey);
  assert.equal(workflows.WIP_TTL_SECONDS, 86_400);
  assert.ok(ttlDraft > 86_000 && ttlDraft <= 86_400);
  assert.ok(ttlActive > 86_000 && ttlActive <= 86_400);

  const results = await Promise.allSettled([
    workflows.draft({ ...wipFlow, name: 'A' }, userAddress, first.modified),
    workflows.draft({ ...wipFlow, name: 'B' }, userAddress, first.modified),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const restored = await workflows.current(userAddress);
  assert.ok(restored);
  assert.equal(restored.id, wipFlow.id);
  assert.ok(['A', 'B'].includes(restored.name));
  assert.equal(await workflows.current(other), null);

  await workflows.clearDraft(userAddress);
  assert.equal(await workflows.current(userAddress), null);

  // Any stale composer draft referencing an already-published workflow is auto-evicted on current()
  await workflows.draft(flow, userAddress);
  assert.equal(await workflows.current(userAddress), null);
});
test('private HTTP routes reject absent and invalid tokens', async () => { for (const url of ['/api/workflows', '/api/draft', '/api/analytics']) { const result = await app.inject({ method: 'GET', url }); assert.equal(result.statusCode, 401); const invalid = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer invalid' } }); assert.equal(invalid.statusCode, 401); } });
test('health checks all four actual backing services', async () => { const result = await app.inject({ method: 'GET', url: '/api/health' }); assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { status: 'ready', users: true, workflows: true, cache: true, composer: true }); });
test('public browsing does not disclose a VIBE brief', async () => { assert.equal((await workflows.get(flow.id)).brief, undefined); assert.equal((await workflows.list()).find(row => row.id === flow.id)?.brief, undefined); assert.equal((await workflows.get(flow.id, userAddress)).brief, flow.brief); });
test('account consent is explicit, persisted, and tied to the policy and authenticated identity', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const policy = await app.inject({ method: 'GET', url: '/api/policy' }); assert.equal(policy.statusCode, 200);
    const hash = policy.json().hash;
    const before = await app.inject({ method: 'GET', url: '/api/user', headers }); assert.equal(before.json().consented, false);
    const denied = await app.inject({ method: 'PUT', url: '/api/draft', headers, payload: flow }); assert.equal(denied.statusCode, 428);
    const unchecked = await app.inject({ method: 'POST', url: '/api/consent', headers, payload: { policy: hash, terms: true, privacy: false } }); assert.equal(unchecked.statusCode, 400);
    const stale = await app.inject({ method: 'POST', url: '/api/consent', headers, payload: { policy: '0'.repeat(64), terms: true, privacy: true } }); assert.equal(stale.statusCode, 409);
    const accepted = await app.inject({ method: 'POST', url: '/api/consent', headers: { ...headers, 'user-agent': 'Consent verification' }, payload: { policy: hash, terms: true, privacy: true } }); assert.equal(accepted.statusCode, 200);
    const restored = await app.inject({ method: 'GET', url: '/api/consent', headers }); assert.deepEqual(restored.json(), accepted.json());
    const again = await app.inject({ method: 'POST', url: '/api/consent', headers, payload: { policy: hash, terms: true, privacy: true } }); assert.deepEqual(again.json(), accepted.json());
    const signed = await app.inject({ method: 'GET', url: '/api/user', headers }); assert.equal(signed.json().consented, true);
    const [receipt] = await user`SELECT * FROM consents WHERE "userAddress"=${userAddress}`; assert.equal(receipt.policy, hash); assert.equal(receipt.token, digest(token)); assert.equal(receipt.agent, 'Consent verification'); assert.deepEqual(receipt.checks, { terms: true, privacy: true }); assert.ok(receipt.text.includes('Confidential Intents'));
    await workflows.recordRun({
      id: randomUUID(),
      workflowId: flow.id,
      workflowName: flow.name,
      userAddress,
      creatorAddress: userAddress,
      network: 'near:mainnet',
      status: 'succeeded',
      durationMs: 420,
      composeBillWei: '10000',
      creatorFeeWei: '0',
      platformFeeWei: '200',
      totalChargedWei: '10200',
      txHash: 'tx-test-123',
      steps: [{ id: 's1', label: 'Research', kind: 'model', output: 'ok' }],
    });
    const analyticsRes = await app.inject({ method: 'GET', url: '/api/analytics', headers });
    assert.equal(analyticsRes.statusCode, 200);
    const analyticsData = analyticsRes.json();
    assert.equal(analyticsData.totals.requests.total, 1);
    assert.equal(analyticsData.totals.requests.succeeded, 1);
    assert.equal(analyticsData.totals.billing.finalAmountAtomic, '10200');
    assert.equal(analyticsData.settlements.data[0].settleTransactionHash, 'tx-test-123');
    await user`DELETE FROM consents WHERE "userAddress"=${userAddress}`;
});

test('profile banner, socials, collision checks, config fees/telegram, and unpublished workflow privacy work end-to-end', async () => {
    const headersA = { authorization: `Bearer ${token}` };
    const headersB = { authorization: `Bearer ${otherToken}` };
    const policyRes = await app.inject({ method: 'GET', url: '/api/policy' });
    const policyHash = policyRes.json().hash;
    assert.equal(policyRes.json().sections.length, 5);

    const cfgRes = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(cfgRes.statusCode, 200);
    const cfg = cfgRes.json();
    assert.deepEqual(cfg.fees.creatorOptions, [1, 2, 3]);
    assert.deepEqual(
      cfg.providers.map((p: { id: string }) => p.id),
      ['google', 'discord', 'github', 'x'],
    );
    assert.ok(!cfg.providers.some((p: { id: string }) => p.id === 'telegram'));
    assert.ok(cfg.linkProviders.some((p: { id: string }) => p.id === 'telegram'));

    const tgAuthAttempt = await app.inject({
      method: 'GET',
      url: '/api/oauth/telegram/start?origin=http://localhost:4001',
    });
    assert.ok(tgAuthAttempt.body.includes('Telegram is only supported for profile linking.'));

    const optRes = await app.inject({ method: 'GET', url: '/api/options' });
    assert.equal(optRes.statusCode, 200);
    assert.equal(optRes.json().tasks.length, 6);
    assert.equal(optRes.json().maxTaskTags, 3);
    assert.ok(await cache.get('options'));

    assert.throws(() =>
      terms.parse({ creatorFee: 2, tasks: ['model', 'connector'], description: 'Invalid node kinds' }),
    );

    await app.inject({ method: 'POST', url: '/api/consent', headers: headersA, payload: { policy: policyHash, terms: true, privacy: true } });
    await app.inject({ method: 'POST', url: '/api/consent', headers: headersB, payload: { policy: policyHash, terms: true, privacy: true } });

    const bannerUrl = 'https://gateway.pinata.cloud/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
    const xSocial = { platform: 'x', handle: '@alice_synth', url: 'https://x.com/alice_synth', verified: true, providerId: 'x:alice_synth' };

    const putA = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: headersA,
      payload: {
        name: 'Alice Synth',
        bio: 'Workflow composer',
        banner: bannerUrl,
        socials: [xSocial],
      },
    });
    assert.equal(putA.statusCode, 200);
    assert.equal(putA.json().banner, bannerUrl);
    assert.equal(putA.json().socials.length, 1);

    const pubProfile = await app.inject({ method: 'GET', url: `/api/profile/${encodeURIComponent(userAddress)}` });
    assert.equal(pubProfile.statusCode, 200);
    assert.equal(pubProfile.json().name, 'Alice Synth');
    assert.equal(pubProfile.json().banner, bannerUrl);
    assert.equal(pubProfile.json().socials[0].handle, '@alice_synth');

    const collisionRes = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: headersB,
      payload: {
        name: 'Bob',
        bio: '',
        socials: [xSocial],
      },
    });
    assert.equal(collisionRes.statusCode, 409);

    const batchRes = await app.inject({
      method: 'GET',
      url: `/api/profiles?addresses=${encodeURIComponent(userAddress)}`,
    });
    assert.equal(batchRes.statusCode, 200);
    assert.equal(batchRes.json().profiles[userAddress.toLowerCase()].name, 'Alice Synth');
    assert.ok(await cache.get(`profile:${userAddress.toLowerCase()}`));

    const draftFlow = {
      id: randomUUID(),
      name: 'unknown #1',
      brief: 'Private creator draft',
      banner: bannerUrl,
      tasks: ['Research', 'DeFi Execution'],
      nodes: [{ id: randomUUID(), type: 'step' as const, position: { x: 0, y: 0 }, data: { label: 'Step 1', kind: 'model' as const, note: '' } }],
      edges: [],
      modified: new Date().toISOString(),
    };
    const putWip = await app.inject({ method: 'PUT', url: '/api/draft', headers: headersA, payload: draftFlow });
    assert.equal(putWip.statusCode, 200);
    assert.ok(await workflows.current(userAddress));

    const savedDraft = await app.inject({ method: 'POST', url: '/api/workflows', headers: headersA, payload: draftFlow });
    assert.equal(savedDraft.statusCode, 200);
    assert.equal(savedDraft.json().banner, bannerUrl);
    assert.equal(savedDraft.json().creatorName, 'Alice Synth');
    assert.deepEqual(savedDraft.json().tasks, ['Research', 'DeFi Execution']);
    assert.equal(await workflows.current(userAddress), null);

    await app.inject({ method: 'PUT', url: '/api/draft', headers: headersA, payload: { ...draftFlow, id: randomUUID() } });
    assert.ok(await workflows.current(userAddress));
    const delWip = await app.inject({ method: 'DELETE', url: '/api/draft', headers: headersA });
    assert.equal(delWip.statusCode, 204);
    assert.equal(await workflows.current(userAddress), null);

    // Multi-WIP index in Composer Valkey: multiple unsaved WIPs coexist, saving promotes only one, DELETE /api/draft/:id discards individually
    const wip1 = { ...draftFlow, id: randomUUID(), name: 'WIP Alpha', modified: new Date(Date.now() - 2000).toISOString() };
    const wip2 = { ...draftFlow, id: randomUUID(), name: 'WIP Beta', modified: new Date().toISOString() };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/draft', headers: headersA, payload: wip1 })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/draft', headers: headersA, payload: wip2 })).statusCode, 200);

    const listWipsBoth = await app.inject({ method: 'GET', url: '/api/drafts', headers: headersA });
    assert.equal(listWipsBoth.statusCode, 200);
    assert.deepEqual(
      (listWipsBoth.json() as Array<{ id: string }>).map(d => d.id),
      [wip2.id, wip1.id],
    );

    // Promote wip1 to Saved in Neon -> only wip2 remains in unsaved WIPs
    const promotedWip1 = await app.inject({ method: 'POST', url: '/api/workflows', headers: headersA, payload: wip1 });
    assert.equal(promotedWip1.statusCode, 200);
    const listAfterSave = await app.inject({ method: 'GET', url: '/api/drafts', headers: headersA });
    assert.deepEqual(
      (listAfterSave.json() as Array<{ id: string }>).map(d => d.id),
      [wip2.id],
    );

    // Discard wip2 individually via DELETE /api/draft/:id
    const discardWip2 = await app.inject({ method: 'DELETE', url: `/api/draft/${wip2.id}`, headers: headersA });
    assert.equal(discardWip2.statusCode, 204);
    const listAfterDiscard = await app.inject({ method: 'GET', url: '/api/drafts', headers: headersA });
    assert.deepEqual(listAfterDiscard.json(), []);

    const anonGet = await app.inject({ method: 'GET', url: `/api/workflows/${draftFlow.id}` });
    assert.equal(anonGet.statusCode, 404);
    const otherGet = await app.inject({ method: 'GET', url: `/api/workflows/${draftFlow.id}`, headers: headersB });
    assert.equal(otherGet.statusCode, 404);
    const ownerGet = await app.inject({ method: 'GET', url: `/api/workflows/${draftFlow.id}`, headers: headersA });
    assert.equal(ownerGet.statusCode, 200);

    const otherRun = await app.inject({ method: 'POST', url: `/api/workflows/${draftFlow.id}/run`, headers: headersB });
    assert.equal(otherRun.statusCode, 404);

    // Telegram HMAC verification unit check
    const botToken = '123456789:AAFakeBotTokenForTest';
    const tgPayload: Record<string, string> = {
      auth_date: '1700000000',
      first_name: 'Alice',
      id: '998877',
      username: 'alice_tg',
    };
    const dataCheck = Object.keys(tgPayload).sort().map(k => `${k}=${tgPayload[k]}`).join('\n');
    const secret = createHash('sha256').update(botToken).digest();
    tgPayload.hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
    const verifiedTg = verifyTelegramAuthData(tgPayload, botToken);
    assert.equal(verifiedTg.social.platform, 'telegram');
    assert.equal(verifiedTg.social.handle, '@alice_tg');
});
