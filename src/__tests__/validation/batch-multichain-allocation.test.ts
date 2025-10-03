import { PGlite } from '@electric-sql/pglite';
import { hexToBytes } from 'viem/utils';
import {
  validateBatchAllocation,
  validateMultichainAllocation,
  validateAllocation,
} from '../../validation/allocation';
import {
  ValidatedBatchCompactMessage,
  ValidatedMultichainCompactMessage,
  ValidatedCompactMessage,
} from '../../validation/types';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  fetchAndCacheSupportedChains,
  SupportedChainsResponse,
} from '../../graphql';
import { setupGraphQLMocks } from '../utils/graphql-mock';
import { getFreshCompact } from '../utils/test-server';

interface GraphQLDocument {
  source: string;
}

type GraphQLRequestFn = (
  query: string | GraphQLDocument,
  variables?: Record<string, unknown>
) => Promise<
  SupportedChainsResponse | (AccountDeltasResponse & AccountResponse)
>;

describe('BatchCompact and MultichainCompact Allocation Validation', () => {
  let db: PGlite;
  let originalRequest: typeof graphqlClient.request;
  let originalDateNow: () => number;
  const chainId = '10';
  const mockTimestampMs = 1696348800000; // Fixed timestamp for deterministic tests
  const mockTimestampSec = Math.floor(mockTimestampMs / 1000);

  // Test addresses
  const testSponsor = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const testArbiter = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  // Helper to create a lock ID from token and lock tag
  function buildLockId(token: string, lockTag: string): bigint {
    const tokenAddress = BigInt(token);
    const lockTagValue = BigInt(lockTag);
    return (lockTagValue << BigInt(160)) | tokenAddress;
  }

  // Helper to create lock tag matching Solidity implementation
  // lockTag := or(or(shl(255, scope), shl(252, resetPeriod)), shl(160, allocatorId))
  // In bytes12 (96 bits): bit 95 = scope, bits 92-94 = resetPeriod, bits 0-91 = allocatorId
  function createLockTag(
    allocatorId: string,
    resetPeriod = 7,
    scope = 0
  ): string {
    const allocatorIdBigInt = BigInt(allocatorId);
    const resetPeriodBigInt = BigInt(resetPeriod) & BigInt(7); // 3 bits
    const scopeBigInt = BigInt(scope) & BigInt(1); // 1 bit
    // Place in bytes12: (scope << 95) | (resetPeriod << 92) | allocatorId
    const lockTagValue =
      (scopeBigInt << BigInt(95)) |
      (resetPeriodBigInt << BigInt(92)) |
      allocatorIdBigInt;
    return '0x' + lockTagValue.toString(16).padStart(24, '0');
  }

  beforeAll(async (): Promise<void> => {
    db = new PGlite();

    // Create test tables
    await db.query(`
      CREATE TABLE IF NOT EXISTS compacts (
        id UUID PRIMARY KEY,
        chain_id bigint NOT NULL,
        claim_hash bytea NOT NULL CHECK (length(claim_hash) = 32),
        arbiter bytea NOT NULL CHECK (length(arbiter) = 20),
        sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
        nonce bytea NOT NULL CHECK (length(nonce) = 32),
        expires BIGINT NOT NULL,
        lock_id bytea NOT NULL CHECK (length(lock_id) = 32),
        amount bytea NOT NULL CHECK (length(amount) = 32),
        witness_type_string TEXT,
        witness_hash bytea CHECK (witness_hash IS NULL OR length(witness_hash) = 32),
        signature bytea NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chain_id, claim_hash)
      )
    `);
  });

  afterAll(async (): Promise<void> => {
    await db.query('DROP TABLE IF EXISTS compacts');
  });

  beforeEach(async (): Promise<void> => {
    originalRequest = graphqlClient.request;
    originalDateNow = Date.now;
    setupGraphQLMocks();
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);
    await db.query('DELETE FROM compacts');

    // Mock Date.now() to return our fixed timestamp
    Date.now = () => mockTimestampMs;
  });

  afterEach((): void => {
    graphqlClient.request = originalRequest;
    Date.now = originalDateNow;
  });

  describe('BatchCompact Allocation Tests', () => {
    it('validates BatchCompact with multiple resource locks', async (): Promise<void> => {
      const lockTag1 = createLockTag('1');
      const lockTag2 = createLockTag('1');
      const token1 = '0x0000000000000000000000000000000000000001';
      const token2 = '0x0000000000000000000000000000000000000002';

      const batchCompact: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag: lockTag1,
            token: token1,
            amount: '1000000000000000000', // 1 ETH
          },
          {
            lockTag: lockTag2,
            token: token2,
            amount: '2000000000000000000', // 2 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL responses for each lock
      let requestCount = 0;
      (graphqlClient as { request: GraphQLRequestFn }).request = async (
        _document: string | GraphQLDocument,
        _variables?: Record<string, unknown>
      ): Promise<AccountDeltasResponse & AccountResponse> => {
        requestCount++;

        // Return different balances for different locks
        const balance =
          requestCount === 1 ? '2000000000000000000' : '3000000000000000000';

        return {
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance,
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        };
      };

      const result = await validateBatchAllocation(batchCompact, chainId, db);
      expect(result.isValid).toBe(true);
      expect(requestCount).toBe(2); // Should make one request per lock
    });

    it('rejects BatchCompact when one resource lock has insufficient balance', async (): Promise<void> => {
      const lockTag1 = createLockTag('1');
      const lockTag2 = createLockTag('1');
      const token1 = '0x0000000000000000000000000000000000000001';
      const token2 = '0x0000000000000000000000000000000000000002';

      const batchCompact: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag: lockTag1,
            token: token1,
            amount: '1000000000000000000', // 1 ETH
          },
          {
            lockTag: lockTag2,
            token: token2,
            amount: '2000000000000000000', // 2 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL responses - second lock has insufficient balance
      let requestCount = 0;
      (graphqlClient as { request: GraphQLRequestFn }).request = async (
        _document: string | GraphQLDocument,
        _variables?: Record<string, unknown>
      ): Promise<AccountDeltasResponse & AccountResponse> => {
        requestCount++;

        // First lock has enough, second doesn't
        const balance =
          requestCount === 1 ? '2000000000000000000' : '1000000000000000000';

        return {
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance,
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        };
      };

      const result = await validateBatchAllocation(batchCompact, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Insufficient allocatable balance');
    });

    it('tracks allocations across multiple BatchCompacts targeting same lock', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // First batch compact
      const batchCompact1: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag,
            token,
            amount: '1000000000000000000', // 1 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Insert first compact into database
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174000',
          chainId,
          hexToBytes(('0x' + '1'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(
            ('0x' +
              batchCompact1.nonce
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          batchCompact1.expires.toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt(batchCompact1.commitments[0].amount)
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(('0x' + '1'.repeat(130)) as `0x${string}`),
        ]
      );

      // Second batch compact targeting same lock
      const batchCompact2: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '1'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag,
            token,
            amount: '1500000000000000000', // 1.5 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL response - total balance just enough for both
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '2500000000000000000', // 2.5 ETH total
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      const result = await validateBatchAllocation(batchCompact2, chainId, db);
      expect(result.isValid).toBe(true);
    });

    it('prevents overallocation when multiple BatchCompacts exceed available balance', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // Insert existing compact
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174000',
          chainId,
          hexToBytes(('0x' + '1'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + '1'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('1500000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(('0x' + '1'.repeat(130)) as `0x${string}`),
        ]
      );

      // New batch compact that would exceed available balance
      const batchCompact: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '2'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag,
            token,
            amount: '1500000000000000000', // 1.5 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL response - not enough for both
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '2000000000000000000', // Only 2 ETH total
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      const result = await validateBatchAllocation(batchCompact, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Insufficient allocatable balance');
    });
  });

  describe('MultichainCompact Allocation Tests', () => {
    it('validates MultichainCompact across multiple chains', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';

      const multichainCompact: ValidatedMultichainCompactMessage = {
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        elements: [
          {
            arbiter: testArbiter,
            chainId: BigInt(chainId),
            commitments: [
              {
                lockTag,
                token,
                amount: '1000000000000000000', // 1 ETH
              },
            ],
            witnessHash: '0x' + '1'.repeat(64),
          },
          {
            arbiter: testArbiter,
            chainId: BigInt('137'), // Polygon
            commitments: [
              {
                lockTag,
                token,
                amount: '2000000000000000000', // 2 ETH
              },
            ],
            witnessHash: '0x' + '2'.repeat(64),
          },
        ],
        witnessTypeString: 'uint256 arg',
      };

      // Mock GraphQL response
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '5000000000000000000', // 5 ETH
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      // Validate for chain 10
      const result = await validateMultichainAllocation(
        multichainCompact,
        chainId,
        db
      );
      expect(result.isValid).toBe(true);
    });

    it('validates only elements for the current chain', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';

      const multichainCompact: ValidatedMultichainCompactMessage = {
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        elements: [
          {
            arbiter: testArbiter,
            chainId: BigInt('137'), // Different chain
            commitments: [
              {
                lockTag,
                token,
                amount: '1000000000000000000',
              },
            ],
            witnessHash: '0x' + '1'.repeat(64),
          },
        ],
        witnessTypeString: 'uint256 arg',
      };

      const result = await validateMultichainAllocation(
        multichainCompact,
        chainId,
        db
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('No elements found for chain');
    });

    it('tracks allocations across different compact types targeting same lock', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // Insert regular compact
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174001',
          chainId,
          hexToBytes(('0x' + '1'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + '1'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('500000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 0.5 ETH
          hexToBytes(('0x' + '1'.repeat(130)) as `0x${string}`),
        ]
      );

      // Insert batch compact allocation
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174002',
          chainId,
          hexToBytes(('0x' + '2'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + '2'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('700000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 0.7 ETH
          hexToBytes(('0x' + '2'.repeat(130)) as `0x${string}`),
        ]
      );

      // New multichain compact
      const multichainCompact: ValidatedMultichainCompactMessage = {
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '3'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        elements: [
          {
            arbiter: testArbiter,
            chainId: BigInt(chainId),
            commitments: [
              {
                lockTag,
                token,
                amount: '800000000000000000', // 0.8 ETH
              },
            ],
            witnessHash: '0x' + '3'.repeat(64),
          },
        ],
        witnessTypeString: 'uint256 arg',
      };

      // Mock GraphQL response - exactly 2 ETH available
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '2000000000000000000', // 2 ETH total
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      // Total: 0.5 + 0.7 + 0.8 = 2.0 ETH - should be valid
      const result = await validateMultichainAllocation(
        multichainCompact,
        chainId,
        db
      );
      expect(result.isValid).toBe(true);
    });

    it('prevents overallocation across mixed compact types', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // Insert existing allocations totaling 1.5 ETH
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174003',
          chainId,
          hexToBytes(('0x' + '3'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + '3'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('1500000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 1.5 ETH
          hexToBytes(('0x' + '3'.repeat(130)) as `0x${string}`),
        ]
      );

      // New multichain compact requesting 1 ETH
      const multichainCompact: ValidatedMultichainCompactMessage = {
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '4'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        elements: [
          {
            arbiter: testArbiter,
            chainId: BigInt(chainId),
            commitments: [
              {
                lockTag,
                token,
                amount: '1000000000000000000', // 1 ETH
              },
            ],
            witnessHash: '0x' + '4'.repeat(64),
          },
        ],
        witnessTypeString: 'uint256 arg',
      };

      // Mock GraphQL response - only 2 ETH available
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '2000000000000000000', // 2 ETH total
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      // Total would be: 1.5 + 1 = 2.5 ETH - should fail
      const result = await validateMultichainAllocation(
        multichainCompact,
        chainId,
        db
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Insufficient allocatable balance');
    });

    it('handles multiple locks within same MultichainCompact element', async (): Promise<void> => {
      const lockTag1 = createLockTag('1');
      const lockTag2 = createLockTag('1');
      const token1 = '0x0000000000000000000000000000000000000001';
      const token2 = '0x0000000000000000000000000000000000000002';

      const multichainCompact: ValidatedMultichainCompactMessage = {
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + '0'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        elements: [
          {
            arbiter: testArbiter,
            chainId: BigInt(chainId),
            commitments: [
              {
                lockTag: lockTag1,
                token: token1,
                amount: '1000000000000000000', // 1 ETH
              },
              {
                lockTag: lockTag2,
                token: token2,
                amount: '2000000000000000000', // 2 ETH
              },
            ],
            witnessHash: '0x' + '1'.repeat(64),
          },
        ],
        witnessTypeString: 'uint256 arg',
      };

      // Mock different balances for different locks
      let requestCount = 0;
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => {
          requestCount++;
          const balance =
            requestCount === 1 ? '1500000000000000000' : '2500000000000000000';

          return {
            accountDeltas: {
              items: [],
            },
            account: {
              resourceLocks: {
                items: [
                  {
                    withdrawalStatus: 0,
                    balance,
                  },
                ],
              },
              claims: {
                items: [],
              },
            },
          };
        };

      const result = await validateMultichainAllocation(
        multichainCompact,
        chainId,
        db
      );
      expect(result.isValid).toBe(true);
      expect(requestCount).toBe(2); // Should check both locks
    });
  });

  describe('Cross-Compact Type Overallocation Prevention', () => {
    it('prevents overallocation when combining Compact, BatchCompact, and MultichainCompact', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // Insert regular compact - 0.5 ETH
      // Ensure lock_id is exactly 32 bytes
      const lockIdHex = '0x' + lockId.toString(16).padStart(64, '0');
      const lockIdBytes = hexToBytes(lockIdHex as `0x${string}`);

      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174010',
          chainId,
          hexToBytes(('0x' + 'a'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + 'a'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          lockIdBytes,
          hexToBytes(
            ('0x' +
              BigInt('500000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(('0x' + 'a'.repeat(130)) as `0x${string}`),
        ]
      );

      // Insert batch compact - 0.7 ETH
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174011',
          chainId,
          hexToBytes(('0x' + 'b'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + 'b'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('700000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(('0x' + 'b'.repeat(130)) as `0x${string}`),
        ]
      );

      // Insert multichain compact - 0.8 ETH
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174012',
          chainId,
          hexToBytes(('0x' + 'c'.repeat(64)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + 'c'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('800000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(('0x' + 'c'.repeat(130)) as `0x${string}`),
        ]
      );

      // Total existing allocations: 0.5 + 0.7 + 0.8 = 2.0 ETH

      // Try to add another compact that would push total over available balance
      // Create a regular Compact with the same lockId structure
      const testCompact: ValidatedCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + 'd'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        id: lockId, // Use the same lockId as the inserted compacts
        amount: '600000000000000000', // 0.6 ETH
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL response - 2.5 ETH available
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '2500000000000000000', // 2.5 ETH total
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      // Total would be: 2.0 + 0.6 = 2.6 ETH > 2.5 ETH available - should fail
      const result = await validateAllocation(testCompact, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Insufficient allocatable balance');
    });

    it('tracks allocations when some are processed claims', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);

      // Insert multiple compacts
      const claimHash1 = '0x' + 'd'.repeat(64);
      const claimHash2 = '0x' + 'e'.repeat(64);

      // Compact 1 - will be marked as processed
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174020',
          chainId,
          hexToBytes(claimHash1 as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + 'd'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('1000000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 1 ETH
          hexToBytes(('0x' + 'd'.repeat(130)) as `0x${string}`),
        ]
      );

      // Compact 2 - still pending
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174021',
          chainId,
          hexToBytes(claimHash2 as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(testSponsor as `0x${string}`),
          hexToBytes(('0x' + 'e'.repeat(64)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('800000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 0.8 ETH
          hexToBytes(('0x' + 'e'.repeat(130)) as `0x${string}`),
        ]
      );

      // New batch compact
      const batchCompact: ValidatedBatchCompactMessage = {
        arbiter: testArbiter,
        sponsor: testSponsor,
        nonce: BigInt(
          '0x' + testSponsor.toLowerCase().slice(2) + 'f'.repeat(24)
        ),
        expires: BigInt(mockTimestampSec + 3600),
        commitments: [
          {
            lockTag,
            token,
            amount: '700000000000000000', // 0.7 ETH
          },
        ],
        witnessTypeString: null,
        witnessHash: null,
      };

      // Mock GraphQL response - mark first claim as processed
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '1500000000000000000', // 1.5 ETH available
                },
              ],
            },
            claims: {
              items: [
                {
                  claimHash: claimHash1, // First compact is processed
                },
              ],
            },
          },
        });

      // Allocated: 0.8 ETH (second compact, first is processed)
      // New request: 0.7 ETH
      // Total: 1.5 ETH = exactly what's available
      const result = await validateBatchAllocation(batchCompact, chainId, db);
      expect(result.isValid).toBe(true);
    });

    it('handles overlapping allocations with different sponsors', async (): Promise<void> => {
      const lockTag = createLockTag('1');
      const token = '0x0000000000000000000000000000000000000001';
      const lockId = buildLockId(token, lockTag);
      const otherSponsor = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

      // Insert compact from different sponsor - should not affect our validation
      await db.query(
        `
        INSERT INTO compacts (
          id, chain_id, claim_hash, arbiter, sponsor, nonce, expires,
          lock_id, amount, signature
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          '123e4567-e89b-12d3-a456-426614174030',
          chainId,
          hexToBytes(('0x' + '1a'.repeat(32)) as `0x${string}`),
          hexToBytes(testArbiter as `0x${string}`),
          hexToBytes(otherSponsor as `0x${string}`), // Different sponsor
          hexToBytes(('0x' + '1a'.repeat(32)) as `0x${string}`),
          (mockTimestampSec + 3600).toString(),
          hexToBytes(
            ('0x' + lockId.toString(16).padStart(64, '0')) as `0x${string}`
          ),
          hexToBytes(
            ('0x' +
              BigInt('5000000000000000000')
                .toString(16)
                .padStart(64, '0')) as `0x${string}`
          ), // 5 ETH
          hexToBytes(('0x' + '1a'.repeat(65)) as `0x${string}`),
        ]
      );

      // Our sponsor's compact
      const compact = getFreshCompact();
      // Keep the id from getFreshCompact which has proper structure
      compact.amount = '1000000000000000000'; // 1 ETH

      // Mock GraphQL response - only check our sponsor's balance
      (graphqlClient as { request: GraphQLRequestFn }).request =
        async (): Promise<AccountDeltasResponse & AccountResponse> => ({
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: '1000000000000000000', // 1 ETH for our sponsor
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        });

      // Should succeed since different sponsors have separate allocations
      const result = await validateAllocation(
        compact as ValidatedCompactMessage,
        chainId,
        db
      );
      expect(result.isValid).toBe(true);
    });
  });
});
