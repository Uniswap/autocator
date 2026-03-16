import { PGlite } from '@electric-sql/pglite';
import {
  graphqlClient,
  SupportedChainsResponse,
  AccountDeltasResponse,
  AccountResponse,
  ConsumedNonceResponse,
} from '../../../graphql';

// Extract allocator ID from lockId (matches the calculation in balance.ts)
const TEST_LOCK_ID = BigInt(
  '0x7000000000000000000000010000000000000000000000000000000000000000'
);
const ALLOCATOR_ID = (
  (TEST_LOCK_ID >> BigInt(160)) &
  ((BigInt(1) << BigInt(92)) - BigInt(1))
).toString();

export async function setupCompactTestDb(): Promise<PGlite> {
  const db = new PGlite();

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS nonces (
      id UUID PRIMARY KEY,
      chain_id bigint NOT NULL,
      sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
      nonce_high bigint NOT NULL,
      nonce_low integer NOT NULL,
      consumed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, sponsor, nonce_high, nonce_low)
    )
  `);

  return db;
}

export async function cleanupCompactTestDb(db: PGlite): Promise<void> {
  // Drop in order due to foreign key constraints
  await db.query('DROP TABLE IF EXISTS compact_commitments');
  await db.query('DROP TABLE IF EXISTS compact_elements');
  await db.query('DROP TABLE IF EXISTS compacts');
  await db.query('DROP TABLE IF EXISTS nonces');
}

// Track request calls
let requestCallCount = 0;
let shouldFail = false;

interface GraphQLDocument {
  source: string;
}

type GraphQLRequestFn = (
  query: string | GraphQLDocument,
  variables?: Record<string, unknown>
) => Promise<
  | SupportedChainsResponse
  | (AccountDeltasResponse & AccountResponse)
  | ConsumedNonceResponse
>;

export function setupGraphQLMocks(): void {
  requestCallCount = 0;
  shouldFail = false;

  // Override the request method of the GraphQL client
  (graphqlClient as { request: GraphQLRequestFn }).request = async (
    document: string | GraphQLDocument,
    _variables?: Record<string, unknown>
  ): Promise<
    | SupportedChainsResponse
    | (AccountDeltasResponse & AccountResponse)
    | ConsumedNonceResponse
  > => {
    requestCallCount++;

    if (shouldFail) {
      throw new Error('Network error');
    }

    // Extract the query string from the document
    const query = typeof document === 'string' ? document : document.source;

    // Handle different query types based on query content
    if (query.includes('CheckConsumedNonce')) {
      // Return mock for consumed nonce query (nonce not consumed)
      return {
        consumedNonce: null,
      };
    }

    if (query.includes('GetSupportedChains')) {
      // Return mock for supported chains query only
      return {
        allocator: {
          supportedChains: {
            items: [{ chainId: '1', allocatorId: ALLOCATOR_ID }],
          },
        },
      };
    }

    if (query.includes('GetDetails')) {
      // Return mock for compact details query only
      return {
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
      };
    }

    // Handle GetAllocations query for on-chain allocated balance
    // NOTE: Must check before GetAllocation since "GetAllocation" is a substring of "GetAllocations"
    if (
      query.includes('GetAllocations') ||
      query.includes('allocations(where')
    ) {
      return { allocations: { items: [] } } as unknown as
        | SupportedChainsResponse
        | (AccountDeltasResponse & AccountResponse)
        | ConsumedNonceResponse;
    }

    // Default: return combined mock for generic queries (for backward compatibility with tests)
    return {
      allocator: {
        supportedChains: {
          items: [{ chainId: '1', allocatorId: ALLOCATOR_ID }],
        },
      },
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
    };
  };
}

// Get the number of times request was called
export function getRequestCallCount(): number {
  return requestCallCount;
}

// Set the mock to fail on next request
export function setMockToFail(fail: boolean = true): void {
  shouldFail = fail;
}

// Add test for ALLOCATOR_ID calculation
describe('Compact Test Setup Constants', () => {
  it('should calculate ALLOCATOR_ID correctly from TEST_LOCK_ID', () => {
    // The allocatorId should be derived from TEST_LOCK_ID according to the formula:
    // ((TEST_LOCK_ID >> 160) & ((1 << 92) - 1))
    const expectedAllocatorId = (
      (TEST_LOCK_ID >> BigInt(160)) &
      ((BigInt(1) << BigInt(92)) - BigInt(1))
    ).toString();
    expect(ALLOCATOR_ID).toBe(expectedAllocatorId);
  });
});
