import { test } from 'node:test';
import assert from 'node:assert/strict';
import { close } from '../databases/cache.js';
import {
  deriveSolanaAssociatedTokenAddress,
  detectChainInSegment,
  detectSymbolInSegment,
  discoverDynamicChains,
  encodeSolanaTransferTransaction,
  extractOneClickErrorMessage,
  getLiveOneClickTokens,
  isUniversalNearAccountId,
  NO_FUNDED_WALLET_CODE,
  NO_FUNDED_WALLET_MESSAGE,
  prepareSolanaOriginTransfer,
  resolveUserIntentQuote,
} from '../intents.js';

test('resolveUserIntentQuote routes dynamically on Mainnet Defuse and Testnet Tidepool including multi-leg pooling and gasless intents', async t => {
  t.after(async () => {
    await close();
  });

  // 1. Live Mainnet Defuse catalog & routing
  const mainnetTokens = await getLiveOneClickTokens('mainnet');
  assert.ok(mainnetTokens.length > 100);

  assert.equal(detectChainInSegment('Swap 0.01 bitcoin', mainnetTokens), 'btc');
  assert.equal(detectChainInSegment('Add $20 from Polygon', mainnetTokens), 'pol');
  assert.equal(detectChainInSegment('Send to TON', mainnetTokens), 'ton');
  assert.equal(detectSymbolInSegment('Swap 0.5 SOL to BTC', mainnetTokens), 'SOL');

  await assert.rejects(
    () =>
      resolveUserIntentQuote({
        userAddress: 'composer.near',
        prompt: 'Fund $20',
        dry: true,
        network: 'mainnet',
        connectedWallets: [],
        holdingsOverride: [],
        tokensOverride: mainnetTokens,
      }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, NO_FUNDED_WALLET_CODE);
      assert.equal(err.message, NO_FUNDED_WALLET_MESSAGE);
      return true;
    },
  );

  const polygonUsdc = mainnetTokens.find(
    tok => tok.blockchain === 'pol' && tok.symbol.toUpperCase() === 'USDC',
  );
  const baseUsdc = mainnetTokens.find(
    tok => tok.blockchain === 'base' && tok.symbol.toUpperCase() === 'USDC',
  );
  assert.ok(polygonUsdc && baseUsdc, 'Polygon and Base USDC exist in live Defuse catalog');

  const fundedEvmQuote = await resolveUserIntentQuote({
    userAddress: 'composer.near',
    prompt: 'Fund $15',
    dry: true,
    network: 'mainnet',
    connectedWallets: [
      { network: 'evm', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
    ],
    tokensOverride: mainnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        token: polygonUsdc,
        chainLabel: 'Polygon',
        hexChainId: '0x89',
        balanceAtomic: '50000000',
        balanceFormatted: 50,
        balanceUsd: 50,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        token: baseUsdc,
        chainLabel: 'Base',
        hexChainId: '0x2105',
        balanceAtomic: '45000000',
        balanceFormatted: 45,
        balanceUsd: 45,
        hasNativeGas: true,
      },
    ],
  });

  assert.equal(fundedEvmQuote.action, 'deposit');
  assert.ok(['pol', 'base'].includes(fundedEvmQuote.originToken.blockchain));
  assert.equal(fundedEvmQuote.destinationToken.blockchain, 'near');
  assert.equal(fundedEvmQuote.legs.length, 1);
  assert.ok(Number(fundedEvmQuote.quote.amountOutFormatted) > 14);

  const solToken = mainnetTokens.find(
    tok => tok.blockchain === 'sol' && tok.symbol.toUpperCase() === 'SOL',
  );
  assert.ok(solToken, 'Solana SOL exists in live Defuse catalog');

  const solToBtcQuote = await resolveUserIntentQuote({
    userAddress: 'composer.near',
    prompt: 'Swap 0.3 SOL to BTC bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    dry: true,
    network: 'mainnet',
    connectedWallets: [
      { network: 'svm', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    ],
    tokensOverride: mainnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'svm',
        walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        token: solToken,
        chainLabel: 'Solana',
        balanceAtomic: '2000000000',
        balanceFormatted: 2,
        balanceUsd: 166.64,
        hasNativeGas: true,
      },
    ],
  });

  assert.equal(solToBtcQuote.action, 'swap');
  assert.equal(solToBtcQuote.originToken.blockchain, 'sol');
  assert.equal(solToBtcQuote.destinationToken.blockchain, 'btc');
  assert.equal(solToBtcQuote.recipientAddress, 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
  assert.ok(Number(solToBtcQuote.quote.amountOutFormatted) > 0);

  // 2. Live Testnet Tidepool catalog & multi-leg greedy pooling across Base Sepolia + Arbitrum Sepolia
  const testnetTokens = await getLiveOneClickTokens('testnet');
  assert.ok(testnetTokens.length > 10);

  const baseEth = testnetTokens.find(
    tok => tok.blockchain === 'base' && tok.symbol.toUpperCase() === 'ETH' && !tok.contractAddress,
  );
  const arbEth = testnetTokens.find(
    tok => tok.blockchain === 'arb' && tok.symbol.toUpperCase() === 'ETH' && !tok.contractAddress,
  );
  assert.ok(baseEth && arbEth, 'Base Sepolia and Arbitrum Sepolia native ETH exist in live Tidepool catalog');

  const pooledTestnetQuote = await resolveUserIntentQuote({
    userAddress: '0uphnd2xtj40wg6qh3ayfxf46kpag3wmkgt7xy3m8tptfp7mejfs2g',
    prompt: 'Fund $0.30 from Base and Arbitrum',
    dry: true,
    network: 'testnet',
    connectedWallets: [
      { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
    ],
    tokensOverride: testnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: baseEth,
        chainLabel: 'Base Sepolia',
        hexChainId: '0x14a34',
        balanceAtomic: '40000000000000000',
        balanceFormatted: 0.04,
        balanceUsd: 0.04 * baseEth.price,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: arbEth,
        chainLabel: 'Arbitrum Sepolia',
        hexChainId: '0x66eee',
        balanceAtomic: '120000000000000000',
        balanceFormatted: 0.12,
        balanceUsd: 0.12 * arbEth.price,
        hasNativeGas: true,
      },
    ],
  });

  assert.equal(pooledTestnetQuote.action, 'deposit');
  assert.equal(pooledTestnetQuote.legs.length, 2);
  assert.deepEqual(
    pooledTestnetQuote.legs.map(l => l.originToken.blockchain).sort(),
    ['arb', 'base'],
  );
  assert.equal(pooledTestnetQuote.destinationToken.blockchain, 'near');
  assert.ok(Number(pooledTestnetQuote.totalOutFormatted) >= 0.25);

  // 3. Gasless INTENTS balance takes priority over external origin-chain deposit
  const gaslessQuote = await resolveUserIntentQuote({
    userAddress: '0uphnd2xtj40wg6qh3ayfxf46kpag3wmkgt7xy3m8tptfp7mejfs2g',
    prompt: 'Fund $0.20',
    dry: true,
    network: 'testnet',
    connectedWallets: [
      { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
    ],
    tokensOverride: testnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: arbEth,
        chainLabel: 'Arbitrum Sepolia',
        hexChainId: '0x66eee',
        balanceAtomic: '120000000000000000',
        balanceFormatted: 0.12,
        balanceUsd: 0.12 * arbEth.price,
        hasNativeGas: true,
      },
      {
        source: 'intents',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        intentsAccountId: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: baseEth,
        chainLabel: 'Base Sepolia',
        balanceAtomic: '20000000000000000',
        balanceFormatted: 0.02,
        balanceUsd: 0.02 * baseEth.price,
        hasNativeGas: false,
      },
    ],
  });

  assert.equal(gaslessQuote.legs[0]!.source, 'intents');
  assert.equal(gaslessQuote.legs[0]!.depositType, 'INTENTS');

  // 3b. Single-leg EVM selection over capped Solana Devnet (0.005 SOL Tidepool cap) + Smart Account-only Swap isolation
  const solTestnet = testnetTokens.find(
    tok => tok.blockchain === 'sol' && tok.symbol.toUpperCase() === 'SOL',
  );
  const nearTestnetUsdc = testnetTokens.find(
    tok => tok.blockchain === 'near' && tok.symbol.toUpperCase() === 'USDC',
  );
  assert.ok(solTestnet && nearTestnetUsdc, 'Testnet SOL and NEAR USDC exist in Tidepool catalog');

  const singleLegOverCappedSol = await resolveUserIntentQuote({
    userAddress: 'composer.testnet',
    prompt: 'Deposit $2',
    dry: true,
    network: 'testnet',
    connectedWallets: [
      { network: 'svm', address: '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq' },
      { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
    ],
    tokensOverride: testnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'svm',
        walletAddress: '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq',
        token: solTestnet,
        chainLabel: 'Solana Devnet',
        balanceAtomic: '17096000000',
        balanceFormatted: 17.096,
        balanceUsd: 17.096 * solTestnet.price,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: arbEth,
        chainLabel: 'Arbitrum Sepolia',
        hexChainId: '0x66eee',
        balanceAtomic: '150000000000000000',
        balanceFormatted: 0.15,
        balanceUsd: 0.15 * arbEth.price,
        hasNativeGas: true,
      },
    ],
  });
  assert.equal(singleLegOverCappedSol.legs.length, 1);
  assert.equal(singleLegOverCappedSol.legs[0]!.originToken.blockchain, 'arb');
  assert.equal(singleLegOverCappedSol.legs[0]!.originWalletNetwork, 'evm');

  await assert.rejects(
    () =>
      resolveUserIntentQuote({
        userAddress: 'composer.testnet',
        prompt: 'Swap $2 to SOL',
        dry: true,
        network: 'testnet',
        connectedWallets: [
          { network: 'svm', address: '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq' },
          { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
        ],
        tokensOverride: testnetTokens,
        holdingsOverride: [
          {
            source: 'account',
            walletNetwork: 'near',
            walletAddress: 'composer.testnet',
            token: nearTestnetUsdc,
            chainLabel: 'NEAR Testnet',
            balanceAtomic: '800000',
            balanceFormatted: 0.8,
            balanceUsd: 0.8,
            hasNativeGas: true,
          },
          {
            source: 'external',
            walletNetwork: 'evm',
            walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
            token: arbEth,
            chainLabel: 'Arbitrum Sepolia',
            hexChainId: '0x66eee',
            balanceAtomic: '150000000000000000',
            balanceFormatted: 0.15,
            balanceUsd: 0.15 * arbEth.price,
            hasNativeGas: true,
          },
        ],
      }),
    /Smart Account balance/i,
  );

  // 4. Testnet dynamic chain discovery resolves Solana Devnet + Arbitrum/Base/Ethereum Sepolia
  const testnetChains = await discoverDynamicChains(testnetTokens, 'testnet');
  assert.equal(testnetChains.get('sol')?.walletFamily, 'svm');
  assert.ok((testnetChains.get('sol')?.rpcUrls.length ?? 0) > 0);
  assert.equal(testnetChains.get('arb')?.evmChainId, 421614);
  assert.equal(testnetChains.get('base')?.evmChainId, 84532);
  assert.equal(testnetChains.get('eth')?.evmChainId, 11155111);

  // 5. Solana native SOL and SPL Token wire transaction encoding + live Devnet prepare
  const sender = '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq';
  const recipient = 'BayhXTaqf223sazQiseFMrVcpEC26u1bpTyKyTr8rGDx';
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const nativeEncoded = encodeSolanaTransferTransaction({
    senderAddress: sender,
    depositAddress: recipient,
    amountAtomic: '25000000',
    recentBlockhash: '11111111111111111111111111111111',
  });
  assert.equal(nativeEncoded.wireBytes[0], 1); // 1 required signature
  assert.ok(nativeEncoded.wireBytes.subarray(1, 65).every(b => b === 0));
  assert.ok(nativeEncoded.messageBase58.length > 80);

  const splAta = deriveSolanaAssociatedTokenAddress(sender, usdcMint);
  assert.ok(splAta.length >= 32 && splAta.length <= 44);

  const splEncoded = encodeSolanaTransferTransaction({
    senderAddress: sender,
    depositAddress: recipient,
    amountAtomic: '5000000',
    recentBlockhash: '11111111111111111111111111111111',
    tokenContract: usdcMint,
    decimals: 6,
    memo: 'man0-test',
  });
  assert.equal(splEncoded.wireBytes[0], 1);
  assert.ok(splEncoded.wireBytes.length > nativeEncoded.wireBytes.length);

  const livePrepared = await prepareSolanaOriginTransfer({
    senderAddress: sender,
    depositAddress: recipient,
    amountAtomic: '10000000',
    network: 'testnet',
  });
  assert.ok(livePrepared.recentBlockhash.length >= 32);
  assert.ok(livePrepared.lastValidBlockHeight > 0);
  assert.ok(livePrepared.messageBase58.length > 80);

  // 6. Mainnet 0u... universal account quoting & new-user ($0 Smart Account + linked EVM wallet) swaps
  const universalAcct = '0u0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk';
  assert.equal(isUniversalNearAccountId(universalAcct), true);
  assert.equal(isUniversalNearAccountId('composer.near'), false);

  assert.equal(
    extractOneClickErrorMessage(
      Object.assign(new Error('Bad Request - Invalid input or quote state'), {
        body: { message: 'recipient is not valid' },
      }),
      'Fallback',
    ),
    'recipient is not valid',
  );
  assert.equal(
    extractOneClickErrorMessage(
      Object.assign(new Error('Bad Request - Invalid input or quote state'), {
        body: { message: ['amount is too low', 'recipient is invalid'] },
      }),
      'Fallback',
    ),
    'amount is too low; recipient is invalid',
  );

  const universalDepositQuote = await resolveUserIntentQuote({
    userAddress: universalAcct,
    prompt: 'Fund $5',
    dry: true,
    network: 'mainnet',
    connectedWallets: [
      { network: 'evm', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
    ],
    tokensOverride: mainnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        token: baseUsdc,
        chainLabel: 'Base',
        hexChainId: '0x2105',
        balanceAtomic: '25000000',
        balanceFormatted: 25,
        balanceUsd: 25,
        hasNativeGas: true,
      },
    ],
  });
  assert.equal(universalDepositQuote.action, 'deposit');
  assert.equal(universalDepositQuote.destinationToken.blockchain, 'near');
  assert.equal(universalDepositQuote.legs.length, 1);
  assert.equal(universalDepositQuote.legs[0]!.originWalletNetwork, 'evm');

  const newUserSwapToSol = await resolveUserIntentQuote({
    userAddress: universalAcct,
    prompt: 'Swap $5 to SOL',
    dry: true,
    network: 'mainnet',
    connectedWallets: [
      { network: 'evm', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
      { network: 'svm', address: sender },
    ],
    tokensOverride: mainnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        token: baseUsdc,
        chainLabel: 'Base',
        hexChainId: '0x2105',
        balanceAtomic: '25000000',
        balanceFormatted: 25,
        balanceUsd: 25,
        hasNativeGas: true,
      },
    ],
  });
  assert.equal(newUserSwapToSol.action, 'swap');
  assert.equal(newUserSwapToSol.destinationToken.symbol.toUpperCase(), 'SOL');
  assert.equal(newUserSwapToSol.legs[0]!.originWalletNetwork, 'evm');

  const newUserSwapToNear = await resolveUserIntentQuote({
    userAddress: universalAcct,
    prompt: 'Swap $5 to NEAR',
    dry: true,
    network: 'mainnet',
    connectedWallets: [
      { network: 'evm', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
    ],
    tokensOverride: mainnetTokens,
    holdingsOverride: [
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        token: baseUsdc,
        chainLabel: 'Base',
        hexChainId: '0x2105',
        balanceAtomic: '25000000',
        balanceFormatted: 25,
        balanceUsd: 25,
        hasNativeGas: true,
      },
    ],
  });
  assert.equal(newUserSwapToNear.action, 'swap');
  assert.equal(newUserSwapToNear.destinationToken.blockchain, 'near');
  assert.equal(newUserSwapToNear.legs[0]!.originWalletNetwork, 'evm');

  // 7. Regression: Deposit excludes internal Smart Account dust (e.g. wNEAR on NEAR Testnet),
  //    pools multi-chain EVM Sepolia ETH cleanly up to 0.006 ETH per chain, and reports
  //    testnet bridge per-swap caps accurately instead of contradictory "$314.82 < $100" errors.
  const nearTestnetWnear = testnetTokens.find(
    tok => tok.blockchain === 'near' && tok.symbol.toUpperCase() === 'WNEAR',
  );
  assert.ok(nearTestnetWnear, 'Testnet wNEAR exists in Tidepool catalog');

  const multiLegTestnetDeposit = await resolveUserIntentQuote({
    userAddress: universalAcct,
    prompt: 'Deposit $18',
    dry: true,
    network: 'testnet',
    connectedWallets: [
      { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
      { network: 'svm', address: sender },
    ],
    tokensOverride: testnetTokens,
    holdingsOverride: [
      {
        source: 'account',
        walletNetwork: 'near',
        walletAddress: universalAcct,
        token: nearTestnetWnear,
        chainLabel: 'NEAR Testnet',
        balanceAtomic: '146300000000000000000000',
        balanceFormatted: 0.1463,
        balanceUsd: 0.47,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'svm',
        walletAddress: sender,
        token: solTestnet,
        chainLabel: 'Solana Devnet',
        balanceAtomic: '16980000000',
        balanceFormatted: 16.98,
        balanceUsd: 16.98 * solTestnet.price,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: arbEth,
        chainLabel: 'Arbitrum Sepolia',
        hexChainId: '0x66eee',
        balanceAtomic: '133800000000000000',
        balanceFormatted: 0.1338,
        balanceUsd: 0.1338 * arbEth.price,
        hasNativeGas: true,
      },
      {
        source: 'external',
        walletNetwork: 'evm',
        walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
        token: baseEth,
        chainLabel: 'Base Sepolia',
        hexChainId: '0x14a34',
        balanceAtomic: '47600000000000000',
        balanceFormatted: 0.0476,
        balanceUsd: 0.0476 * baseEth.price,
        hasNativeGas: true,
      },
    ],
  });
  assert.equal(multiLegTestnetDeposit.action, 'deposit');
  assert.ok(
    multiLegTestnetDeposit.legs.every(l => l.source === 'external' && l.originToken.blockchain !== 'near'),
    'Deposit never pulls internal Smart Account wNEAR dust',
  );
  assert.ok(Number(multiLegTestnetDeposit.totalOutFormatted) >= 17);

  await assert.rejects(
    () =>
      resolveUserIntentQuote({
        userAddress: universalAcct,
        prompt: 'Deposit $100',
        dry: true,
        network: 'testnet',
        connectedWallets: [
          { network: 'evm', address: '0x89caf60b0e742b9299e14d611b205870207b5ce3' },
          { network: 'svm', address: sender },
        ],
        tokensOverride: testnetTokens,
        holdingsOverride: [
          {
            source: 'account',
            walletNetwork: 'near',
            walletAddress: universalAcct,
            token: nearTestnetWnear,
            chainLabel: 'NEAR Testnet',
            balanceAtomic: '146300000000000000000000',
            balanceFormatted: 0.1463,
            balanceUsd: 0.47,
            hasNativeGas: true,
          },
          {
            source: 'external',
            walletNetwork: 'svm',
            walletAddress: sender,
            token: solTestnet,
            chainLabel: 'Solana Devnet',
            balanceAtomic: '16980000000',
            balanceFormatted: 16.98,
            balanceUsd: 16.98 * solTestnet.price,
            hasNativeGas: true,
          },
          {
            source: 'external',
            walletNetwork: 'evm',
            walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
            token: arbEth,
            chainLabel: 'Arbitrum Sepolia',
            hexChainId: '0x66eee',
            balanceAtomic: '133800000000000000',
            balanceFormatted: 0.1338,
            balanceUsd: 0.1338 * arbEth.price,
            hasNativeGas: true,
          },
          {
            source: 'external',
            walletNetwork: 'evm',
            walletAddress: '0x89caf60b0e742b9299e14d611b205870207b5ce3',
            token: baseEth,
            chainLabel: 'Base Sepolia',
            hexChainId: '0x14a34',
            balanceAtomic: '47600000000000000',
            balanceFormatted: 0.0476,
            balanceUsd: 0.0476 * baseEth.price,
            hasNativeGas: true,
          },
        ],
      }),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /Testnet bridge per-swap cap/i);
      assert.doesNotMatch(err.message ?? '', /wNEAR/i);
      assert.doesNotMatch(err.message ?? '', /NEAR Testnet/i);
      return true;
    },
  );
});
