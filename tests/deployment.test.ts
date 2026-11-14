import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { backendEnvPath, cloudRunManifest, deploymentEnvironment } from '../deployment.js';

const source = `GOOGLE_CLOUD_PROJECT_ID=gen-lang-client-0482916375
RESEND_API_KEY=deployment-secret-sentinel
PORT=3005
SESSION_KEY=${'ab'.repeat(32)}
QUOTED="text with # and 'quotes'"
MULTILINE="first\\nsecond"
OPTIONAL=
`;
const image = `europe-west1-docker.pkg.dev/gen-lang-client-0482916375/cloud-run-source-deploy/api@sha256:${'a'.repeat(64)}`;

test('secret payload retains dotenv values and runtime PORT precedence', () => {
  const environment = deploymentEnvironment(source);
  assert.equal(environment.payload, source);
  const runtime = { PORT: '8080' } as Record<string, string>;
  dotenv.populate(runtime, dotenv.parse(environment.payload));
  assert.equal(runtime.PORT, '8080');
  assert.equal(runtime.SESSION_KEY, 'ab'.repeat(32));
  assert.equal(runtime.QUOTED, "text with # and 'quotes'");
  assert.equal(runtime.MULTILINE, 'first\nsecond');
  assert.equal(runtime.OPTIONAL, '');
});

test('manifest contains only a pinned secret mount and no environment credentials', () => {
  const environment = deploymentEnvironment(source);
  const manifest = cloudRunManifest(image, '7');
  assert.ok(manifest.includes(`value: ${backendEnvPath}`));
  assert.ok(manifest.includes('secretName: backend-secrets'));
  assert.ok(manifest.includes("key: '7'"));
  assert.ok(manifest.includes('path: .env'));
  assert.ok(manifest.includes('mountPath: /var/run/secrets/backend'));
  assert.ok(manifest.includes('containerPort: 8080'));
  for (const key of ['RESEND_API_KEY', 'SESSION_KEY', 'QUOTED', 'MULTILINE']) {
    assert.equal(manifest.includes(environment.values[key]!), false);
  }
});

test('email delivery is optional for deployment, while the project remains required', () => {
  assert.doesNotThrow(() => deploymentEnvironment(source.replace('RESEND_API_KEY=deployment-secret-sentinel', 'RESEND_API_KEY= ')));
  assert.throws(() => deploymentEnvironment(source.replace('gen-lang-client-0482916375', 'invalid_project')), /project ID/);
});

test('manifest refuses mutable or malformed secret versions and image injection', () => {
  for (const version of ['latest', '', '0', '1\nother: value']) {
    assert.throws(() => cloudRunManifest(image, version), /version/);
  }
  assert.throws(() => cloudRunManifest(`${image}\nother: value`, '1'), /image digest/);
});
