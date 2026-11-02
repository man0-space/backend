import 'dotenv/config';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function rpcFor(network: string): string {
  if (network === 'mainnet' || network === 'near:mainnet') {
    return required('NEAR_MAINNET_RPC');
  }
  if (network === 'testnet' || network === 'near:testnet') {
    return required('NEAR_TESTNET_RPC');
  }
  throw new Error('NEAR_NETWORK must be mainnet or testnet.');
}

export function treasuryFor(network: string): string {
  if (network === 'mainnet' || network === 'near:mainnet') {
    return required('MAN0_TREASURY_ADDRESS');
  }
  if (network === 'testnet' || network === 'near:testnet') {
    return required('MAN0_TESTNET_TREASURY_ADDRESS');
  }
  throw new Error('NEAR_NETWORK must be mainnet or testnet.');
}

export function usdcFor(network: string): string {
  if (network === 'mainnet' || network === 'near:mainnet') {
    return '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  }
  if (network === 'testnet' || network === 'near:testnet') {
    return process.env.NEAR_TESTNET_USDC_ADDRESS?.trim() || 'usdc.tidepool-sandbox.testnet';
  }
  throw new Error('NEAR_NETWORK must be mainnet or testnet.');
}

const rawNetwork = process.env.NEAR_NETWORK?.trim();
const factoryAddress = required('FACTORY_ADDRESS');
const network = rawNetwork
  ? rawNetwork === 'testnet' || rawNetwork === 'near:testnet'
    ? 'testnet'
    : 'mainnet'
  : factoryAddress.endsWith('.testnet')
    ? 'testnet'
    : 'mainnet';

export const config = {
  port: Number(required('PORT')),
  users: required('USER_DATABASE_URL'),
  workflows: required('WORKFLOW_DATABASE_URL'),
  cache: required('VALKEY_CACHE_SERVICE_URI'),
  composer: required('VALKEY_COMPOSER_SERVICE_URI'),
  network: network as 'mainnet' | 'testnet',
  rpc: rpcFor(network),
  secret: required('SESSION_KEY'),
  origins: required('APP_ORIGINS')
    .split(',')
    .map(origin => origin.trim()),
  composeApiUrl: required('COMPOSE_API_URL').replace(/\/+$/, ''),
  treasuryAddress: required('MAN0_TREASURY_ADDRESS'),
  testnetTreasuryAddress: required('MAN0_TESTNET_TREASURY_ADDRESS'),
  facilitatorPrivateKey: required('NEAR_FACILITATOR_KEY'),
  pinataJwt: required('PINATA_JWT'),
  pinataGateway: required('PINATA_GATEWAY_URL'),
  nebiusApiKey: required('NEBIUS_API_KEY'),
  googleAiApiKey: required('GOOGLE_GENERATIVE_AI_API_KEY'),
  contracts: {
    factory: factoryAddress,
    workflow: required('WORKFLOW_ADDRESS'),
    reputation: required('REPUTATION_ADDRESS'),
    validation: required('VALIDATION_ADDRESS'),
  },
};
