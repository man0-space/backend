import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '../catalog.js';
import { close } from '../databases/cache.js';

test.after(async () => {
  await close();
});

test('catalog loads SDK models with text/image/video/music/embeddings/others buckets + Frontier > Latest ordering, connectors, and agents', async () => {
  const [models, connectors, agents] = await Promise.all([
    catalog('model', true),
    catalog('connector', true),
    catalog('agent', true),
  ]);

  assert.ok(models.length > 500, 'expected full SDK model catalog');
  for (const bucket of ['text', 'image', 'video', 'music', 'embeddings', 'others']) {
    assert.ok(
      models.some(m => m.groups?.includes(bucket)),
      `expected model catalog to include '${bucket}' primary group`,
    );
  }
  assert.ok(
    models.some(m => m.subgroups?.includes('text/chat')) &&
    models.some(m => m.subgroups?.includes('others/speech')) &&
    models.some(m => m.subgroups?.includes('others/realtime')),
    'expected model subgroups for operations and others/* compose-market modalities',
  );
  assert.ok(
    models.every(m => Boolean(m.family) && Boolean(m.modality)) &&
    models.some(m => !m.id.startsWith('openai:') && !m.id.startsWith('alibaba:')),
    'expected canonical SDK modelId, family, and modality on every model entry',
  );

  // Verify Frontier > Latest > others tier ordering
  const firstNonFrontierIdx = models.findIndex(m => !m.isFrontier);
  assert.ok(firstNonFrontierIdx > 0, 'expected frontier models at the very top of model catalog');
  assert.ok(
    models.slice(firstNonFrontierIdx).every(m => !m.isFrontier),
    'expected all isFrontier models to precede non-frontier models',
  );
  const firstOtherIdx = models.findIndex(m => !m.isFrontier && !m.isLatest);
  assert.ok(firstOtherIdx > firstNonFrontierIdx, 'expected isLatest models immediately after isFrontier');
  assert.ok(
    models.slice(firstOtherIdx).every(m => !m.isFrontier && !m.isLatest),
    'expected all isLatest models to precede remaining models',
  );

  assert.ok(connectors.length > 200, 'expected non-empty connector catalog');
  assert.ok(
    connectors.some(c => c.groups?.includes('mcps')),
    'expected mcps connectors',
  );
  assert.ok(
    connectors.some(
      c =>
        c.groups?.includes('accounts') &&
        c.id.startsWith('account:') &&
        Boolean(c.logo) &&
        Array.isArray(c.subgroups) &&
        c.subgroups.some(s => s.startsWith('accounts/')),
    ),
    'expected accounts connectors with logos, account: prefix, and accounts/* subcategories',
  );
  assert.ok(
    connectors.some(c => c.groups?.includes('onchain') && c.id === 'near-intents') &&
    connectors.some(c => c.groups?.includes('onchain') && c.id.startsWith('onchain:')),
    'expected onchain connectors and near-intents',
  );

  assert.ok(agents.length > 50, 'expected paginated SDK agent catalog');
});
