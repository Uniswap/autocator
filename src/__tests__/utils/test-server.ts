import fastify, { FastifyInstance } from 'fastify';
// import env from '@fastify/env'; // Not used
import cors from '@fastify/cors';
// import { randomUUID } from 'crypto'; // Not used
import { setupRoutes } from '../../routes';
import { dbManager } from '../setup';
import { signMessage, sign } from 'viem/accounts';
import {
  getAddress,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  concat,
} from 'viem/utils';
import { serializeCompactSignature, signatureToCompactSignature } from 'viem';
import { CompactMessage } from '../../validation/types';
import { setupGraphQLMocks } from './graphql-mock';
import { fetchAndCacheSupportedChains } from '../../graphql';

// Helper to generate test data
// const defaultBaseUrl = 'https://autocator.example'; // Not used
export const validPayload = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

// Test private key (do not use in production)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Helper to generate signature for any message
export async function generateSignature(message: string): Promise<string> {
  const signature = await signMessage({
    message,
    privateKey: TEST_PRIVATE_KEY as `0x${string}`,
  });
  return signature;
}

// EIP-712 domain for The Compact V1
const DOMAIN = {
  name: 'The Compact',
  version: '1',
  verifyingContract: '0x00000000000000171ede64904551eeDF3C6C9788',
} as const;

// EIP-712 domain typehash
const EIP712_DOMAIN_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    [
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ]
  )
);

// Helper to generate a valid EIP-712 signature for a compact
export async function generateValidCompactSignature(
  compact: {
    id: bigint;
    arbiter: string;
    sponsor: string;
    nonce: bigint;
    expires: bigint;
    amount: string;
    witnessTypeString: string | null;
    witnessHash: string | null;
  },
  chainId: string | number
): Promise<string> {
  // Normalize addresses
  const normalizedArbiter = getAddress(compact.arbiter);
  const normalizedSponsor = getAddress(compact.sponsor);
  const chainIdBigInt = BigInt(chainId);

  // Generate claim hash
  let claimHash: `0x${string}`;
  if (!compact.witnessTypeString || !compact.witnessHash) {
    // Generate type hash
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'Compact(address arbiter,address sponsor,uint256 nonce,uint256 expires,uint256 id,uint256 amount)',
        ]
      )
    );

    // Generate message hash
    claimHash = keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          compact.id,
          BigInt(compact.amount),
        ]
      )
    );
  } else {
    // Generate type hash with witness
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'Compact(address arbiter,address sponsor,uint256 nonce,uint256 expires,uint256 id,uint256 amount,' +
            compact.witnessTypeString,
        ]
      )
    );

    // Generate message hash
    claimHash = keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'witnessHash', type: 'bytes32' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          compact.id,
          BigInt(compact.amount),
          compact.witnessHash as `0x${string}`,
        ]
      )
    );
  }

  // Generate domain hash
  const domainHash = keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'name', type: 'bytes32' },
        { name: 'version', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(encodePacked(['string'], [DOMAIN.name])),
        keccak256(encodePacked(['string'], [DOMAIN.version])),
        chainIdBigInt,
        DOMAIN.verifyingContract,
      ]
    )
  );

  // Generate digest
  const digest = keccak256(concat(['0x1901', domainHash, claimHash]));

  // Sign the digest
  const signResult = await sign({
    hash: digest,
    privateKey: TEST_PRIVATE_KEY as `0x${string}`,
  });

  // Convert to EIP2098 compact signature format
  const compactSig = signatureToCompactSignature(signResult);
  return serializeCompactSignature(compactSig);
}

// Store server instances to close them properly
let serverInstances: FastifyInstance[] = [];

// Create a test server instance
export async function createTestServer(): Promise<FastifyInstance> {
  // Configure logger based on environment
  const isProd = process.env.NODE_ENV === 'production';
  const server = fastify({
    logger: isProd
      ? {
          level: 'error',
        }
      : {
          level: 'error',
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname,reqId,responseTime,req,res',
              colorize: true,
              messageFormat: '{msg}',
            },
          },
        },
  });

  try {
    // Setup GraphQL mocks before any server initialization
    setupGraphQLMocks();

    // Set environment variables directly for testing
    process.env.SIGNING_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    process.env.ALLOCATOR_ADDRESS =
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.DOMAIN = 'autocator.example';
    process.env.BASE_URL = 'https://autocator.example';
    process.env.SUPPORTED_CHAINS_REFRESH_INTERVAL = '600';

    await server.register(cors, {
      origin: '*',
    });

    const db = await dbManager.getDb();
    if (!db) {
      throw new Error('Database not initialized');
    }

    // Decorate fastify instance with db
    server.decorate('db', db);

    // Initialize supported chains cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS as string);

    // Register routes
    await setupRoutes(server);

    await server.ready();

    // Add server to instances array for proper cleanup
    serverInstances.push(server);

    return server;
  } catch (err) {
    console.error('Error setting up test server:', err);
    throw err;
  }
}

// Helper to pad hex string to specific byte length
function padToBytes(hex: string, byteLength: number): string {
  return hex.slice(2).padStart(byteLength * 2, '0');
}

// Helper to ensure hex string has 0x prefix
function ensure0x(hex: string): `0x${string}` {
  return hex.startsWith('0x')
    ? (hex as `0x${string}`)
    : (`0x${hex}` as `0x${string}`);
}

export const validCompact = {
  // Pack scope (0), reset period (7), allocatorId (1), and token (0) into the ID
  id: BigInt(
    '0x7000000000000000000000010000000000000000000000000000000000000000'
  ), // Set reset period to 7 (30 days)
  arbiter: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  sponsor: validPayload.address,
  // Create nonce where first 20 bytes match sponsor address
  nonce: BigInt(
    '0x' + validPayload.address.toLowerCase().slice(2) + '0'.repeat(24)
  ),
  expires: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
  amount: '1000000000000000000',
  witnessTypeString: 'witness-type',
  witnessHash:
    '0x1234567890123456789012345678901234567890123456789012345678901234',
  chainId: 1,
};

// Helper to get fresh compact with current expiration
let compactCounter = BigInt(0);
export function getFreshCompact(): typeof validCompact {
  const counter = compactCounter++;

  // Get normalized sponsor address
  const sponsorAddress = getAddress(validCompact.sponsor).toLowerCase();

  // Create nonce with sponsor in first 20 bytes and counter in last 12 bytes
  // First convert the sponsor address to a BigInt (removing 0x prefix)
  const sponsorBigInt = BigInt('0x' + sponsorAddress.slice(2));

  // Shift sponsor left by 96 bits (12 bytes) to make room for counter
  const nonce = (sponsorBigInt << BigInt(96)) | counter;

  // Create new ID preserving everything except the token bits
  const tokenMask = (BigInt(1) << BigInt(160)) - BigInt(1);
  const id = (validCompact.id & ~tokenMask) | (counter & tokenMask);

  // Set expiration to 1 hour from now (within server's 2-hour limit)
  const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);

  return {
    ...validCompact,
    id,
    nonce,
    expires,
  };
}

// Helper to convert BigInt values to strings for API requests
export function compactToAPI(
  compact: typeof validCompact,
  options: { nullNonce?: boolean } = {}
): CompactMessage {
  const nonce = options.nullNonce ? null : compact.nonce;

  // Convert ID to hex preserving all bits
  const idHex = compact.id.toString(16).padStart(64, '0');

  return {
    id: ensure0x(idHex),
    arbiter: ensure0x(padToBytes(getAddress(compact.arbiter), 20)),
    sponsor: ensure0x(padToBytes(getAddress(compact.sponsor), 20)),
    nonce:
      nonce === null
        ? null
        : ensure0x(padToBytes('0x' + nonce.toString(16), 32)),
    expires: compact.expires.toString(),
    amount: compact.amount, // Keep amount as decimal string
    witnessTypeString: compact.witnessTypeString,
    witnessHash: compact.witnessHash
      ? ensure0x(padToBytes(compact.witnessHash, 32))
      : null,
  };
}

export async function cleanupTestServer(): Promise<void> {
  // No need to call dbManager.cleanup() here as it's already called in the global afterEach
  // This prevents double cleanup which might cause issues

  // Close all server instances
  for (const server of serverInstances) {
    try {
      await server.close();
    } catch (err) {
      console.error('Error closing server:', err);
    }
  }

  // Clear the server instances array
  serverInstances = [];

  // Force close any open handles from the logger
  // This is a workaround for the "Jest has detected the following 1 open handle" warning
  process.removeAllListeners('beforeExit');

  // Give time for any async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
}
