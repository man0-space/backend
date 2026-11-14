import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  backendSecret,
  backendServiceAccount,
  cloudRunManifest,
  deploymentEnvironment,
} from './deployment.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const envPath = new URL('.env', import.meta.url);
const manifestPath = new URL('cloudrun.yaml', import.meta.url);

const environment = deploymentEnvironment(readFileSync(envPath, 'utf8'));
const { project } = environment;
const region = 'europe-west1';
const service = 'api';
const repository = `${region}-docker.pkg.dev/${project}/cloud-run-source-deploy/${service}`;

function run(args: string[], capture = false): string {
  return execFileSync('gcloud', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

run(['services', 'enable', 'secretmanager.googleapis.com', `--project=${project}`, '--quiet']);

try {
  run(['secrets', 'describe', backendSecret, `--project=${project}`, '--format=value(name)', '--quiet'], true);
} catch (error) {
  const stderr = String((error as { stderr?: unknown }).stderr ?? '');
  if (!stderr.includes('NOT_FOUND')) throw error;
  run(['secrets', 'create', backendSecret, `--project=${project}`, '--replication-policy=automatic', '--quiet']);
}

run([
  'secrets', 'add-iam-policy-binding', backendSecret,
  `--project=${project}`,
  `--member=serviceAccount:${backendServiceAccount}`,
  '--role=roles/secretmanager.secretAccessor',
  '--quiet',
]);

let secretVersion: string;
try {
  const versionName = execFileSync('gcloud', [
    'secrets', 'versions', 'add', backendSecret,
    `--project=${project}`,
    '--data-file=-',
    '--format=value(name)',
    '--quiet',
  ], {
    cwd: root,
    encoding: 'utf8',
    input: environment.payload,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  secretVersion = versionName.split('/').at(-1) ?? '';
  if (!/^[1-9][0-9]*$/.test(secretVersion)) throw new Error('Invalid secret version.');
} catch {
  throw new Error('Unable to store backend configuration in Secret Manager. Check its permissions.');
}

console.log(`Backend configuration: ${backendSecret}, version ${secretVersion}.`);

const tag = `${repository}:build-${Date.now()}-${randomUUID().slice(0, 8)}`;
run(['builds', 'submit', `--project=${project}`, `--tag=${tag}`, '.']);

const digest = run(
  [
    'artifacts',
    'docker',
    'images',
    'describe',
    tag,
    `--project=${project}`,
    '--format=value(image_summary.digest)',
  ],
  true,
).trim();

if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
  throw new Error(`Invalid image digest: ${digest}`);
}

const image = `${repository}@${digest}`;
writeFileSync(manifestPath, cloudRunManifest(image, secretVersion));

run([
  'run',
  'services',
  'replace',
  'cloudrun.yaml',
  `--region=${region}`,
  `--project=${project}`,
  '--quiet',
]);

run([
  'run',
  'services',
  'add-iam-policy-binding',
  service,
  `--region=${region}`,
  `--project=${project}`,
  '--member=allUsers',
  '--role=roles/run.invoker',
  '--quiet',
]);

console.log(`${service}: ${image}`);
