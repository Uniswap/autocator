import {
  graphqlClient,
  hybridAllocatorClient,
  resetIndexerHealthCache,
} from '../../graphql';

// Use allocatorId = 1 to match tests
const ALLOCATOR_ID = '1';

// Mock response for supported chains query
const mockSupportedChainsResponse = {
  allocator: {
    supportedChains: {
      items: [
        {
          chainId: '1',
          allocatorId: ALLOCATOR_ID,
        },
        {
          chainId: '10',
          allocatorId: ALLOCATOR_ID,
        },
        {
          chainId: '8453',
          allocatorId: ALLOCATOR_ID,
        },
      ],
    },
  },
};

// Mock response for account deltas query
const mockAccountDeltasResponse = {
  accountDeltas: {
    items: [
      {
        delta: '1000000000000000000',
      },
    ],
  },
  account: {
    resourceLocks: {
      items: [
        {
          withdrawalStatus: 0,
          balance: '2000000000000000000',
        },
      ],
    },
    claims: {
      items: [
        {
          claimHash:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
        },
      ],
    },
  },
};

// Track request calls
let requestCallCount = 0;
let hybridRequestCallCount = 0;
let shouldFail = false;
let shouldHybridFail = false;

// Mock on-chain allocations for testing
interface MockOnChainAllocation {
  claimHash: string;
  nonce: string;
  expires: string;
  commitments: string; // JSON string
  timestamp: string;
}
let mockOnChainAllocations: MockOnChainAllocation[] = [];

// Setup GraphQL mocks
export function setupGraphQLMocks(): void {
  requestCallCount = 0;
  hybridRequestCallCount = 0;
  shouldFail = false;
  shouldHybridFail = false;
  mockOnChainAllocations = [];
  // Reset the health cache to ensure fresh state for each test
  resetIndexerHealthCache();

  type GraphQLRequestFn = (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<unknown>;

  // Override the request method of the main GraphQL client (compact indexer)
  (graphqlClient as { request: GraphQLRequestFn }).request = async (
    query: string,
    _variables?: Record<string, unknown>
  ) => {
    requestCallCount++;

    if (shouldFail) {
      throw new Error('Network error');
    }

    // Return appropriate mock based on the query
    if (query.includes('GetSupportedChains')) {
      return mockSupportedChainsResponse;
    }
    if (query.includes('GetDetails')) {
      return mockAccountDeltasResponse;
    }
    if (query.includes('GetAllResourceLocks')) {
      return {
        account: {
          resourceLocks: {
            items: [],
          },
        },
      };
    }
    // Handle CheckConsumedNonce query
    if (
      query.includes('CheckConsumedNonce') ||
      query.includes('consumedNonce')
    ) {
      return {
        consumedNonce: null, // Nonce not consumed
      };
    }
    // Handle CheckOnchainRegistration query
    if (
      query.includes('CheckOnchainRegistration') ||
      query.includes('registeredCompact')
    ) {
      return {
        registeredCompact: null, // No onchain registration
      };
    }
    // Handle health check query
    if (query.includes('HealthCheck') || query.includes('__typename')) {
      return { __typename: 'Query' };
    }
    throw new Error(`Unhandled GraphQL query: ${query}`);
  };

  // Override the request method of the hybrid allocator GraphQL client
  (hybridAllocatorClient as { request: GraphQLRequestFn }).request = async (
    query: string,
    _variables?: Record<string, unknown>
  ) => {
    hybridRequestCallCount++;

    if (shouldHybridFail) {
      throw new Error('Hybrid allocator indexer network error');
    }

    // Handle health check query
    if (query.includes('HealthCheck') || query.includes('__typename')) {
      return { __typename: 'Query' };
    }
    // Handle GetAllocations query - returns mock on-chain allocations
    // NOTE: Must check before GetAllocation since "GetAllocation" is a substring of "GetAllocations"
    if (query.includes('GetAllocations')) {
      return { allocations: { items: mockOnChainAllocations } };
    }
    // Handle GetAllocation query (single allocation by claim hash)
    if (query.includes('GetAllocation')) {
      return { allocation: null }; // No existing allocation by default
    }
    // Handle GetActiveSigners query
    if (query.includes('GetActiveSigners')) {
      return { signers: { items: [] } };
    }
    // Handle GetAllocatorInstance query
    if (query.includes('GetAllocatorInstance')) {
      return {
        allocatorInstance: {
          allocatorId: ALLOCATOR_ID,
          ownerAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          compactAddress: '0x00000000000000171ede64904551eeDF3C6C9788',
        },
      };
    }
    throw new Error(`Unhandled hybrid allocator GraphQL query: ${query}`);
  };
}

// Get the number of times request was called
export function getRequestCallCount(): number {
  return requestCallCount;
}

// Get the number of times hybrid allocator request was called
export function getHybridRequestCallCount(): number {
  return hybridRequestCallCount;
}

// Set the compact indexer mock to fail
export function setMockToFail(fail: boolean = true): void {
  shouldFail = fail;
  // Reset the health cache so the next health check picks up the new state
  resetIndexerHealthCache();
}

// Set the hybrid allocator indexer mock to fail
export function setHybridMockToFail(fail: boolean = true): void {
  shouldHybridFail = fail;
  // Reset the health cache so the next health check picks up the new state
  resetIndexerHealthCache();
}

// Set both indexers to fail (for testing fail-closed behavior)
export function setBothIndexersToFail(fail: boolean = true): void {
  shouldFail = fail;
  shouldHybridFail = fail;
  // Reset the health cache so the next health check picks up the new state
  resetIndexerHealthCache();
}

/**
 * Set mock on-chain allocations for testing.
 * These will be returned by the GetAllocations query.
 *
 * @param allocations - Array of mock allocations with commitments as JSON string
 */
export function setMockOnChainAllocations(
  allocations: Array<{
    claimHash: string;
    nonce: string;
    expires: string;
    commitments: string; // JSON string of Lock[]
    timestamp: string;
  }>
): void {
  mockOnChainAllocations = allocations;
}

/**
 * Clear mock on-chain allocations
 */
export function clearMockOnChainAllocations(): void {
  mockOnChainAllocations = [];
}

// Export mock responses for assertions
export { mockSupportedChainsResponse, mockAccountDeltasResponse };
