import { validateAllocation } from '../../validation/allocation';
import { getFreshCompact } from '../utils/test-server';
import { PGlite } from '@electric-sql/pglite';
import { hexToBytes } from 'viem/utils';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  fetchAndCacheSupportedChains,
  SupportedChainsResponse,
} from '../../graphql';
import { setupGraphQLMocks } from '../utils/graphql-mock';

interface GraphQLDocument {
  source: string;
}

type GraphQLRequestFn = (
  query: string | GraphQLDocument,
  variables?: Record<string, unknown>
) => Promise<
  SupportedChainsResponse | (AccountDeltasResponse & AccountResponse)
>;

describe('Allocation Validation', () => {
  let db: PGlite;
  let originalRequest: typeof graphqlClient.request;
  const chainId = '10';
  const mockTimestampMs = 1700000000000;
  const mockTimestampSec = Math.floor(mockTimestampMs / 1000);

  beforeAll(async (): Promise<void> => {
    db = new PGlite();

    // Create test tables using the new normalized schema
    await db.query(`
      CREATE TABLE IF NOT EXISTS compacts (
        id UUID PRIMARY KEY,
        chain_id bigint NOT NULL,
        claim_hash bytea NOT NULL CHECK (length(claim_hash) = 32),
        compact_type INTEGER NOT NULL DEFAULT 0 CHECK (compact_type IN (0, 1, 2)),
        sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
        nonce bytea NOT NULL CHECK (length(nonce) = 32),
        expires BIGINT NOT NULL,
        signature bytea NOT NULL,
        witness_type_string TEXT,
        witness_hash bytea CHECK (witness_hash IS NULL OR length(witness_hash) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chain_id, claim_hash)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS compact_elements (
        id UUID PRIMARY KEY,
        compact_id UUID NOT NULL REFERENCES compacts(id) ON DELETE CASCADE,
        element_index INTEGER NOT NULL DEFAULT 0,
        arbiter bytea NOT NULL CHECK (length(arbiter) = 20),
        chain_id bigint NOT NULL,
        mandate_hash bytea CHECK (mandate_hash IS NULL OR length(mandate_hash) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(compact_id, element_index)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS compact_commitments (
        id UUID PRIMARY KEY,
        element_id UUID NOT NULL REFERENCES compact_elements(id) ON DELETE CASCADE,
        lock_tag bytea NOT NULL CHECK (length(lock_tag) = 12),
        token bytea NOT NULL CHECK (length(token) = 20),
        amount bytea NOT NULL CHECK (length(amount) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterAll(async (): Promise<void> => {
    // Clean up (order matters due to foreign keys)
    await db.query('DROP TABLE IF EXISTS compact_commitments');
    await db.query('DROP TABLE IF EXISTS compact_elements');
    await db.query('DROP TABLE IF EXISTS compacts');
  });

  // Counter for unique IDs across tests
  let compactCounter = 0;

  // Helper to extract lock_tag and token from lockId
  function extractLockTagAndToken(lockId: bigint): {
    lockTag: string;
    token: string;
  } {
    // Token is the lower 160 bits
    const token =
      '0x' +
      (lockId & ((BigInt(1) << BigInt(160)) - BigInt(1)))
        .toString(16)
        .padStart(40, '0');
    // Lock tag is the upper 96 bits (12 bytes)
    const lockTagValue = lockId >> BigInt(160);
    const lockTag = '0x' + lockTagValue.toString(16).padStart(24, '0');
    return { lockTag, token };
  }

  // Helper to insert a compact into the normalized schema
  async function insertTestCompact(
    sponsor: string,
    chainIdVal: string,
    claimHash: string,
    arbiter: string,
    nonce: bigint,
    expires: bigint,
    lockId: bigint,
    amount: string
  ): Promise<void> {
    const { lockTag, token } = extractLockTagAndToken(lockId);
    const compactId = `123e4567-e89b-12d3-a456-42661417${String(compactCounter).padStart(4, '0')}`;
    const elementId = `123e4567-e89b-12d3-a456-42661418${String(compactCounter).padStart(4, '0')}`;
    const commitmentId = `123e4567-e89b-12d3-a456-42661419${String(compactCounter).padStart(4, '0')}`;
    compactCounter++;

    // Insert into compacts table
    await db.query(
      `INSERT INTO compacts (id, chain_id, claim_hash, compact_type, sponsor, nonce, expires, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        compactId,
        chainIdVal,
        hexToBytes(claimHash as `0x${string}`),
        0, // Legacy compact type
        hexToBytes(sponsor as `0x${string}`),
        hexToBytes(
          ('0x' + nonce.toString(16).padStart(64, '0')) as `0x${string}`
        ),
        expires.toString(),
        hexToBytes(('0x' + '1'.repeat(130)) as `0x${string}`), // Dummy signature
      ]
    );

    // Insert into compact_elements table
    await db.query(
      `INSERT INTO compact_elements (id, compact_id, element_index, arbiter, chain_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        elementId,
        compactId,
        0,
        hexToBytes(arbiter as `0x${string}`),
        chainIdVal,
      ]
    );

    // Insert into compact_commitments table
    await db.query(
      `INSERT INTO compact_commitments (id, element_id, lock_tag, token, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        commitmentId,
        elementId,
        hexToBytes(lockTag as `0x${string}`),
        hexToBytes(token as `0x${string}`),
        hexToBytes(
          ('0x' +
            BigInt(amount).toString(16).padStart(64, '0')) as `0x${string}`
        ),
      ]
    );
  }

  beforeEach(async (): Promise<void> => {
    // Store original function and setup mocks
    originalRequest = graphqlClient.request;
    setupGraphQLMocks();

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);

    // Mock GraphQL response with sufficient balance
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
                balance: '1000000000000000000000', // 1000 ETH
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      });

    // Clear test data (order matters due to foreign keys)
    await db.query('DELETE FROM compact_commitments');
    await db.query('DELETE FROM compact_elements');
    await db.query('DELETE FROM compacts');
    compactCounter = 0;
  });

  afterEach((): void => {
    // Restore original function
    graphqlClient.request = originalRequest;
  });

  it('should validate when allocatable balance is sufficient', async (): Promise<void> => {
    const compact = getFreshCompact();

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(true);
  });

  it('should reject when allocatable balance is insufficient', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Mock GraphQL response with insufficient balance
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
                balance: (BigInt(compact.amount) / BigInt(2)).toString(), // Half the compact amount
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      });

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Insufficient allocatable balance');
  });

  it('should consider existing allocated balance', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Insert existing compact using normalized schema helper
    await insertTestCompact(
      compact.sponsor,
      chainId,
      '0x' + '1'.repeat(64),
      compact.arbiter,
      compact.nonce,
      BigInt(mockTimestampSec + 3600),
      compact.id,
      compact.amount
    );

    // Mock GraphQL response with balance just enough for two compacts
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
                balance: (BigInt(compact.amount) * BigInt(2)).toString(), // Enough for two compacts
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      });

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(true);
  });

  it('should exclude processed claims from allocated balance', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Insert existing compact using normalized schema helper
    await insertTestCompact(
      compact.sponsor,
      chainId,
      '0x' + '1'.repeat(64),
      compact.arbiter,
      compact.nonce,
      BigInt(mockTimestampSec + 3600),
      compact.id,
      compact.amount
    );

    // Mock GraphQL response with processed claim
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
                balance: compact.amount, // Only enough for one compact
              },
            ],
          },
          claims: {
            items: [
              {
                claimHash: '0x' + '1'.repeat(64), // Mark the existing compact as processed
              },
            ],
          },
        },
      });

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(true);
  });

  it('should reject when withdrawal is enabled', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Mock GraphQL response with withdrawal enabled
    (graphqlClient as { request: GraphQLRequestFn }).request =
      async (): Promise<AccountDeltasResponse & AccountResponse> => ({
        accountDeltas: {
          items: [],
        },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 1, // Withdrawal enabled
                balance: '1000000000000000000000',
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      });

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('forced withdrawals enabled');
  });

  it('should reject when allocatorId from chain config does not match compact ID', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Override the mock response with a different allocator ID
    const differentAllocatorId = '999';
    (graphqlClient as { request: GraphQLRequestFn }).request = async (
      document: string | GraphQLDocument,
      _variables?: Record<string, unknown>
    ): Promise<
      SupportedChainsResponse | (AccountDeltasResponse & AccountResponse)
    > => {
      const query = typeof document === 'string' ? document : document.source;
      if (query.includes('GetSupportedChains')) {
        return {
          allocator: {
            supportedChains: {
              items: [
                {
                  chainId: '10',
                  allocatorId: differentAllocatorId,
                },
              ],
            },
          },
        };
      }
      // Return mock account data for other queries
      return {
        accountDeltas: {
          items: [],
        },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 0,
                balance: '1000000000000000000000',
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      };
    };

    // Refresh chain config with new mock
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Invalid allocator ID');
  });

  it('should reject when allocatorId is missing from chain config', async (): Promise<void> => {
    const compact = getFreshCompact();

    // Override the mock response with empty supported chains
    (graphqlClient as { request: GraphQLRequestFn }).request = async (
      document: string | GraphQLDocument,
      _variables?: Record<string, unknown>
    ): Promise<
      SupportedChainsResponse | (AccountDeltasResponse & AccountResponse)
    > => {
      const query = typeof document === 'string' ? document : document.source;
      if (query.includes('GetSupportedChains')) {
        return {
          allocator: {
            supportedChains: {
              items: [], // No supported chains
            },
          },
        };
      }
      // Return mock account data for other queries
      return {
        accountDeltas: {
          items: [],
        },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 0,
                balance: '1000000000000000000000',
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      };
    };

    // Refresh chain config with new mock
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);

    const result = await validateAllocation(compact, chainId, db);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Invalid allocator ID');
  });
});
