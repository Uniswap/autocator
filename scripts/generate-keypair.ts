#!/usr/bin/env npx ts-node

/**
 * Script to generate an Ethereum key pair for use as a signer on the HybridAllocator contract.
 *
 * Usage:
 *   npx ts-node scripts/generate-keypair.ts
 *
 * The script will output:
 *   - Private key (to be stored securely and used in PRIVATE_KEY env var)
 *   - Public address (to be registered as a signer on the HybridAllocator)
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function main() {
  // Generate a new random private key
  const privateKey = generatePrivateKey();

  // Derive the public address from the private key
  const account = privateKeyToAccount(privateKey);

  console.log('\n=== Generated Ethereum Key Pair ===\n');
  console.log('⚠️  IMPORTANT: Store the private key securely and never share it!\n');
  console.log('Private Key:', privateKey);
  console.log('Public Address:', account.address);
  console.log('\n=== Instructions ===\n');
  console.log('1. Add the private key to your .env file:');
  console.log(`   PRIVATE_KEY=${privateKey}`);
  console.log(`   SIGNING_ADDRESS=${account.address}`);
  console.log('\n2. Register this address as a signer on HybridAllocator on each chain:');
  console.log(`   - Call addSigner(${account.address}) on each HybridAllocator contract`);
  console.log('   - Contract address: 0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B');
  console.log('\n3. Supported chains:');
  console.log('   - Ethereum Mainnet (chainId: 1)');
  console.log('   - Optimism (chainId: 10)');
  console.log('   - Arbitrum One (chainId: 42161)');
  console.log('   - Base (chainId: 8453)');
  console.log('   - Unichain (chainId: 130)');
  console.log('   - Sepolia (chainId: 11155111)');
  console.log('   - Optimism Sepolia (chainId: 11155420)');
  console.log('   - Arbitrum Sepolia (chainId: 421614)');
  console.log('   - Base Sepolia (chainId: 84532)');
  console.log('   - Unichain Sepolia (chainId: 1301)');
  console.log('\n');
}

main();
