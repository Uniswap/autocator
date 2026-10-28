import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  cleanupTestServer,
  validPayload,
} from '../utils/test-server';
import {
  setupGraphQLMocks,
  setHybridMockToFail,
  setMockToFail,
} from '../utils/graphql-mock';
import { resetIndexerHealthCache } from '../../graphql';
import { fetchAndCacheSupportedChains } from '../../graphql';
import { sign } from 'viem/accounts';
import {
  getAddress,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  concat,
  signatureToCompactSignature,
  serializeCompactSignature,
} from 'viem';
import {
  constructHybridNonce,
  hybridNonceToHex,
} from '../../validation/hybrid-nonce';
import { NonceCommand } from '../../validation/types';
import {
  TRIBUNAL_ADDRESS,
  initializeAllowedArbiters,
} from '../../validation/arbiter';

// Helper to encode lockTag correctly
// lockTag structure (96 bits = 12 bytes):
// - allocatorId: bits 0-91 (92 bits)
// - resetPeriod: bits 92-94 (3 bits)
// - scope: bit 95 (1 bit)
function encodeLockTag(
  allocatorId: bigint,
  resetPeriod: number,
  scope: number
): `0x${string}` {
  const packed =
    (allocatorId & ((BigInt(1) << BigInt(92)) - BigInt(1))) |
    (BigInt(resetPeriod) << BigInt(92)) |
    (BigInt(scope) << BigInt(95));
  const hex = packed.toString(16).padStart(24, '0');
  return `0x${hex}` as `0x${string}`;
}

// Test private key (do not use in production)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

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

// BatchCompact typehash (without witness)
const BATCH_COMPACT_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    [
      'BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments)Lock(bytes12 lockTag,address token,uint256 amount)',
    ]
  )
);

interface Lock {
  lockTag: string;
  token: string;
  amount: string;
}

interface BatchCompact {
  arbiter: string;
  sponsor: string;
  nonce: string;
  expires: string;
  commitments: Lock[];
  witnessTypeString: string | null;
  witnessHash: string | null;
}

/**
 * Generate a valid EIP-712 signature for a BatchCompact
 */
async function generateValidBatchCompactSignature(
  compact: BatchCompact,
  chainId: string
): Promise<`0x${string}`> {
  const normalizedArbiter = getAddress(compact.arbiter);
  const normalizedSponsor = getAddress(compact.sponsor);
  const chainIdBigInt = BigInt(chainId);
  const nonceBigInt = BigInt(compact.nonce);
  const expiresBigInt = BigInt(compact.expires);

  // Sort commitments by lock ID (lockTag + token) for deterministic ordering
  const sortedCommitments = [...compact.commitments].sort((a, b) => {
    const aId = (BigInt(a.lockTag) << BigInt(160)) | BigInt(a.token);
    const bId = (BigInt(b.lockTag) << BigInt(160)) | BigInt(b.token);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  // Encode commitments array
  const commitmentsHash = keccak256(
    encodeAbiParameters(
      [
        {
          name: 'commitments',
          type: 'tuple[]',
          components: [
            { name: 'lockTag', type: 'bytes12' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
        },
      ],
      [
        sortedCommitments.map((c) => ({
          lockTag: (c.lockTag.startsWith('0x')
            ? c.lockTag
            : `0x${c.lockTag}`) as `0x${string}`,
          token: getAddress(c.token),
          amount: BigInt(c.amount),
        })),
      ]
    )
  );

  // Generate claim hash (without witness for now)
  const claimHash = keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'arbiter', type: 'address' },
        { name: 'sponsor', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expires', type: 'uint256' },
        { name: 'commitmentsHash', type: 'bytes32' },
      ],
      [
        BATCH_COMPACT_TYPEHASH,
        normalizedArbiter,
        normalizedSponsor,
        nonceBigInt,
        expiresBigInt,
        commitmentsHash,
      ]
    )
  );

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
    privateKey: TEST_PRIVATE_KEY,
  });

  // Convert to EIP2098 compact signature format
  const compactSig = signatureToCompactSignature(signResult);
  return serializeCompactSignature(compactSig);
}

// Reset period enum values (matching frontend/src/utils/lockTag.ts)
const ResetPeriod = {
  OneSecond: 0,
  FifteenSeconds: 1,
  OneMinute: 2,
  TenMinutes: 3,
  OneHourAndFiveMinutes: 4,
  OneDay: 5,
  SevenDaysAndOneHour: 6,
  ThirtyDays: 7,
} as const;

// Scope enum values
const Scope = {
  Multichain: 0,
  ChainSpecific: 1,
} as const;

/**
 * Create a fresh BatchCompact for testing
 */
let batchCompactCounter = BigInt(0);
function getFreshBatchCompact(): BatchCompact {
  const counter = batchCompactCounter++;
  const sponsor = validPayload.address;

  // Create a hybrid nonce with OFF_CHAIN command
  const nonce = constructHybridNonce(NonceCommand.OFF_CHAIN, sponsor, counter);

  // Create a properly encoded lockTag:
  // - allocatorId = 1 (92 bits)
  // - resetPeriod = 7 (ThirtyDays, 3 bits)
  // - scope = 0 (Multichain, 1 bit)
  const lockTag = encodeLockTag(
    BigInt(1),
    ResetPeriod.ThirtyDays,
    Scope.Multichain
  );

  // Use a test token address
  const token = '0x0000000000000000000000000000000000000001';

  return {
    arbiter: TRIBUNAL_ADDRESS, // Use Tribunal as the arbiter
    sponsor,
    nonce: hybridNonceToHex(nonce),
    expires: (Math.floor(Date.now() / 1000) + 3600).toString(), // 1 hour from now
    commitments: [
      {
        lockTag,
        token,
        amount: '1000000000000000000', // 1 token
      },
    ],
    witnessTypeString: null,
    witnessHash: null,
  };
}

describe('Allocation Routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    // Setup GraphQL mocks before creating the test server
    setupGraphQLMocks();

    // Initialize allowed arbiters (includes Tribunal by default)
    initializeAllowedArbiters();

    server = await createTestServer();

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);
  });

  afterEach(async () => {
    // Reset mock state to prevent leakage between tests
    setMockToFail(false);
    setHybridMockToFail(false);
    resetIndexerHealthCache();

    await cleanupTestServer();
  });

  describe('POST /allocation', () => {
    describe('Standard allocation', () => {
      it('should successfully process a valid standard allocation request', async () => {
        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        if (response.statusCode !== 200) {
          console.error('Allocation failed:', response.payload);
        }

        expect(response.statusCode).toBe(200);
        const result = JSON.parse(response.payload);
        expect(result).toHaveProperty('claimHash');
        expect(result).toHaveProperty('allocation');
        expect(result.allocation).toHaveProperty('commitments');
        expect(result.allocation).toHaveProperty('nonce');
        expect(result.allocation).toHaveProperty('signature');
        expect(result.allocation.commitments).toHaveLength(1);
        expect(result.message).toBe('Off-chain allocation successful');
      });

      it('should store the allocation in the database', async () => {
        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(200);
        const result = JSON.parse(response.payload);

        // Query the database to verify storage
        const dbResult = await server.db.query<{ count: number }>(
          'SELECT COUNT(*) as count FROM compacts WHERE claim_hash = $1',
          [Buffer.from(result.claimHash.slice(2), 'hex')]
        );
        expect(dbResult.rows[0].count).toBe(1);
      });

      it('should reject request without type', async () => {
        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('type is required');
      });

      it('should reject request with unknown type', async () => {
        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'unknown',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Unknown request type');
      });

      it('should reject request with invalid arbiter', async () => {
        const freshCompact = getFreshBatchCompact();
        // Use a random address that's not in the allowed list
        freshCompact.arbiter = '0x1234567890123456789012345678901234567890';

        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('not in the allowed list');
      });

      it('should reject request with invalid sponsor signature', async () => {
        const freshCompact = getFreshBatchCompact();
        // Use a wrong signature
        const wrongSignature =
          '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature: wrongSignature,
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Invalid sponsor signature');
      });

      it('should reject request with nonce having wrong command type', async () => {
        const freshCompact = getFreshBatchCompact();
        // Use ON_CHAIN command instead of OFF_CHAIN
        const wrongNonce = constructHybridNonce(
          NonceCommand.ON_CHAIN,
          validPayload.address,
          BigInt(9999)
        );
        freshCompact.nonce = hybridNonceToHex(wrongNonce);

        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('command mismatch');
      });
    });

    describe('Indexer health checks (fail-closed)', () => {
      it('should return 503 when unified indexer is down', async () => {
        // Make the unified indexer fail
        setMockToFail(true);

        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(503);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Service temporarily unavailable');
        expect(result.error).toContain('unified-compact-indexer');
      });

      it('should return 503 via setHybridMockToFail (legacy compatibility)', async () => {
        // Legacy function - now both setMockToFail and setHybridMockToFail
        // affect the same unified indexer
        setHybridMockToFail(true);

        const freshCompact = getFreshBatchCompact();
        const sponsorSignature = await generateValidBatchCompactSignature(
          freshCompact,
          '1'
        );

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'standard',
            chainId: '1',
            compact: freshCompact,
            sponsorSignature,
          },
        });

        expect(response.statusCode).toBe(503);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Service temporarily unavailable');
        expect(result.error).toContain('unified-compact-indexer');
      });
    });

    describe('Permit2 allocation', () => {
      it('should reject permit2 request with missing witness in permit2Message', async () => {
        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'permit2',
            chainId: '1',
            permit2Message: {
              permitted: [],
              spender: '0x0000000000000000000000000000000000000001',
              nonce: '0',
              deadline: '9999999999',
              depositLockTag: encodeLockTag(
                BigInt(1),
                ResetPeriod.ThirtyDays,
                Scope.Multichain
              ),
              witness: {}, // Missing compact in witness
            },
            signature:
              '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
            mandateHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            witnessTypeString: 'test',
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Invalid Permit2 message');
      });

      it('should reject permit2 request with missing depositLockTag', async () => {
        const freshCompact = getFreshBatchCompact();
        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'permit2',
            chainId: '1',
            permit2Message: {
              permitted: [],
              spender: '0x0000000000000000000000000000000000000001',
              nonce: '0',
              deadline: '9999999999',
              // Missing depositLockTag!
              witness: {
                activator: '0x0000000000000000000000000000000000000001',
                ids: [],
                compact: freshCompact,
              },
            },
            signature:
              '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
            mandateHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            witnessTypeString: 'test',
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('depositLockTag is required');
      });

      it('should reject permit2 request with invalid mandate hash', async () => {
        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'permit2',
            chainId: '1',
            permit2Message: {
              permitted: [],
              spender: '0x0000000000000000000000000000000000000001',
              nonce: '0',
              deadline: '9999999999',
              depositLockTag: encodeLockTag(
                BigInt(1),
                ResetPeriod.ThirtyDays,
                Scope.Multichain
              ),
              witness: {
                activator: '0x0000000000000000000000000000000000000001',
                ids: [],
                compact: getFreshBatchCompact(),
              },
            },
            signature:
              '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
            mandateHash: '0xinvalid', // Invalid mandate hash
            witnessTypeString: 'test',
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Invalid mandate hash');
      });
    });

    describe('On-chain registration allocation', () => {
      it('should reject if compact is not registered (returns null from indexer)', async () => {
        // Use an ON_CHAIN nonce for on-chain allocation
        const freshCompact = getFreshBatchCompact();
        const sponsor = freshCompact.sponsor;
        const onChainNonce = constructHybridNonce(
          NonceCommand.ON_CHAIN,
          sponsor,
          BigInt(9999)
        );
        freshCompact.nonce = hybridNonceToHex(onChainNonce);

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'onchain',
            chainId: '1',
            compact: freshCompact,
            mandateHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            witnessTypeString: 'Mandate mandate)',
          },
        });

        // The mock returns null by default (compact not registered)
        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('not registered');
      });

      it('should reject if mandate hash is invalid', async () => {
        const freshCompact = getFreshBatchCompact();

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'onchain',
            chainId: '1',
            compact: freshCompact,
            mandateHash: '0x1234', // Too short
            witnessTypeString: 'Mandate mandate)',
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Invalid mandate hash');
      });

      it('should reject if witness type string is empty', async () => {
        const freshCompact = getFreshBatchCompact();

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'onchain',
            chainId: '1',
            compact: freshCompact,
            mandateHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            witnessTypeString: '', // Empty
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('Invalid witness type string');
      });

      it('should reject if nonce has wrong command type (not ON_CHAIN)', async () => {
        // The fresh compact uses OFF_CHAIN by default
        const freshCompact = getFreshBatchCompact();

        const response = await server.inject({
          method: 'POST',
          url: '/allocation',
          payload: {
            type: 'onchain',
            chainId: '1',
            compact: freshCompact,
            mandateHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            witnessTypeString: 'Mandate mandate)',
          },
        });

        expect(response.statusCode).toBe(400);
        const result = JSON.parse(response.payload);
        expect(result.error).toContain('command mismatch');
      });
    });
  });

  describe('GET /allocation/:chainId/:claimHash', () => {
    it('should return an existing allocation from local database', async () => {
      // First create an allocation
      const freshCompact = getFreshBatchCompact();
      const sponsorSignature = await generateValidBatchCompactSignature(
        freshCompact,
        '1'
      );

      const createResponse = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'standard',
          chainId: '1',
          compact: freshCompact,
          sponsorSignature,
        },
      });

      expect(createResponse.statusCode).toBe(200);
      const createResult = JSON.parse(createResponse.payload);
      const { claimHash } = createResult;

      // Now query for it
      const response = await server.inject({
        method: 'GET',
        url: `/allocation/1/${claimHash}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result.exists).toBe(true);
      expect(result.source).toBe('local');
      expect(result.allocation).toHaveProperty('claimHash', claimHash);
      expect(result.allocation).toHaveProperty('sponsor');
      expect(result.allocation).toHaveProperty('nonce');
    });

    it('should return 404 for non-existent allocation', async () => {
      const nonExistentHash =
        '0x0000000000000000000000000000000000000000000000000000000000000000';

      const response = await server.inject({
        method: 'GET',
        url: `/allocation/1/${nonExistentHash}`,
      });

      expect(response.statusCode).toBe(404);
      const result = JSON.parse(response.payload);
      expect(result.exists).toBe(false);
      expect(result.error).toBe('Allocation not found');
    });
  });

  describe('POST /allocation/suggested-nonce', () => {
    it('should return a valid hybrid nonce with OFF_CHAIN command', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/allocation/suggested-nonce',
        payload: {
          chainId: '1',
          sponsor: validPayload.address,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('command', 'OFF_CHAIN');
      expect(result).toHaveProperty('sponsor');
      expect(result).toHaveProperty('fragment');

      // Verify nonce structure
      const nonceHex = result.nonce as string;
      expect(nonceHex).toMatch(/^0x[0-9a-f]{64}$/i);

      // First byte should be 0x02 (OFF_CHAIN command)
      expect(nonceHex.slice(2, 4)).toBe('02');
    });

    it('should return incremented nonce fragment after previous allocation', async () => {
      // First, create an allocation to consume a nonce
      const freshCompact = getFreshBatchCompact();
      const sponsorSignature = await generateValidBatchCompactSignature(
        freshCompact,
        '1'
      );

      await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'standard',
          chainId: '1',
          compact: freshCompact,
          sponsorSignature,
        },
      });

      // Now get suggested nonce
      const response = await server.inject({
        method: 'POST',
        url: '/allocation/suggested-nonce',
        payload: {
          chainId: '1',
          sponsor: validPayload.address,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      // Fragment should be incremented (at least 1)
      expect(BigInt(result.fragment)).toBeGreaterThan(BigInt(0));
    });

    it('should reject request without chainId', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/allocation/suggested-nonce',
        payload: {
          sponsor: validPayload.address,
        },
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('chainId and sponsor are required');
    });

    it('should reject request without sponsor', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/allocation/suggested-nonce',
        payload: {
          chainId: '1',
        },
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('chainId and sponsor are required');
    });
  });

  describe('Multiple commitments', () => {
    it('should handle BatchCompact with multiple commitments', async () => {
      const freshCompact = getFreshBatchCompact();

      // Add a second commitment with chain-specific scope
      // Using allocatorId = 1, resetPeriod = 7 (ThirtyDays), scope = 1 (ChainSpecific)
      const secondLockTag = encodeLockTag(
        BigInt(1),
        ResetPeriod.ThirtyDays,
        Scope.ChainSpecific
      );
      freshCompact.commitments.push({
        lockTag: secondLockTag,
        token: '0x0000000000000000000000000000000000000002', // Different token
        amount: '500000000000000000', // 0.5 tokens (mock returns 2 ETH balance, need room for both)
      });

      const sponsorSignature = await generateValidBatchCompactSignature(
        freshCompact,
        '1'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'standard',
          chainId: '1',
          compact: freshCompact,
          sponsorSignature,
        },
      });

      if (response.statusCode !== 200) {
        console.error('Multiple commitments test failed:', response.payload);
      }

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result.allocation.commitments).toHaveLength(2);
    });
  });
});
