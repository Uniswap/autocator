import { GraphQLClient } from 'graphql-request';
import { FastifyInstance } from 'fastify';
import { getFinalizationThreshold } from './chain-config';

// GraphQL endpoint from environment - uses unified indexer for all queries
const INDEXER_ENDPOINT = process.env.INDEXER_URL
  ? `${process.env.INDEXER_URL.replace(/\/$/, '')}/graphql`
  : 'https://unified-compact-indexer.marble.live/graphql';

// Create singleton GraphQL client for unified indexer
export const graphqlClient = new GraphQLClient(INDEXER_ENDPOINT);

// Indexer health status
interface IndexerHealthStatus {
  indexer: boolean;
  lastCheck: number;
}

let indexerHealthStatus: IndexerHealthStatus = {
  indexer: false,
  lastCheck: 0,
};

// Health check TTL in milliseconds (10 seconds)
const HEALTH_CHECK_TTL = 10000;

// Store supported chains data in memory
let supportedChainsCache: Array<{
  chainId: string;
  allocatorId: string;
  finalizationThresholdSeconds: number;
}> | null = null;

// Store the refresh interval timer
let refreshInterval: ReturnType<typeof setInterval> | null = null;

// Define the types for our GraphQL responses
export interface AccountDeltasResponse {
  accountDeltas: {
    items: Array<{
      delta: string;
    }>;
  };
}

export interface AccountResponse {
  account: {
    resourceLocks: {
      items: Array<{
        withdrawalStatus: number;
        balance: string;
      }>;
    };
    claims: {
      items: Array<{
        claimHash: string;
      }>;
    };
  };
}

export interface SupportedChainsResponse {
  allocator: {
    supportedChains: {
      items: Array<{
        chainId: string;
        allocatorId: string;
      }>;
    };
  } | null;
}

export interface AllResourceLocksResponse {
  account: {
    resourceLocks: {
      items: Array<{
        chainId: string;
        resourceLock: {
          lockId: string;
          allocatorAddress: string;
        };
      }>;
    };
  };
}

export interface ConsumedNonceResponse {
  consumedNonce: {
    blockNumber: string | null;
  } | null;
}

// Query to get all supported chains
export const GET_SUPPORTED_CHAINS = `
  query GetSupportedChains($allocator: String!) {
    allocator(address: $allocator) {
      supportedChains {
        items {
          chainId
          allocatorId
        }
      }
    }
  }
`;

// Function to fetch and cache supported chains
export async function fetchAndCacheSupportedChains(
  allocatorAddress: string,
  server?: FastifyInstance
): Promise<void> {
  try {
    const response = await graphqlClient.request<SupportedChainsResponse>(
      GET_SUPPORTED_CHAINS,
      { allocator: allocatorAddress.toLowerCase() }
    );

    // Handle case where allocator hasn't been registered on-chain yet
    if (!response.allocator) {
      // Allocator not found in indexer - this is normal for new allocators
      // Keep existing cache if we have one, otherwise leave as null
      if (server) {
        server.log.info(
          `Allocator ${allocatorAddress} not yet indexed - supported chains cache not updated`
        );
      }
      return;
    }

    supportedChainsCache = response.allocator.supportedChains.items.map(
      (item) => ({
        chainId: item.chainId,
        allocatorId: item.allocatorId,
        finalizationThresholdSeconds: getFinalizationThreshold(item.chainId),
      })
    );
  } catch (error) {
    // Log error if server instance is provided
    if (server) {
      console.error('GraphQL Network Error:', {
        err: error instanceof Error ? error.message : String(error),
        path: '/graphql',
      });
    }
    // Don't update cache if there's an error
  }
}

// Start periodic refresh of supported chains
export function startSupportedChainsRefresh(
  allocatorAddress: string,
  intervalSeconds: number,
  server?: FastifyInstance
): void {
  // Clear any existing interval
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  // Set up new interval
  refreshInterval = setInterval(
    () => void fetchAndCacheSupportedChains(allocatorAddress, server),
    intervalSeconds * 1000
  );
}

// Stop periodic refresh
export function stopSupportedChainsRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// Function to get cached supported chains
export function getCachedSupportedChains(): Array<{
  chainId: string;
  allocatorId: string;
  finalizationThresholdSeconds: number;
}> | null {
  return supportedChainsCache;
}

// Calculate timestamps for GraphQL query
export function calculateQueryTimestamps(chainId: string): {
  finalizationTimestamp: number;
  thresholdTimestamp: number;
} {
  const currentTimeSeconds = Math.ceil(Date.now() / 1000);
  const finalizationThreshold = getFinalizationThreshold(chainId);

  return {
    // Current time minus finalization threshold
    finalizationTimestamp: currentTimeSeconds - finalizationThreshold,
    // Current time minus 3 hours (in seconds)
    thresholdTimestamp: currentTimeSeconds - 3 * 60 * 60,
  };
}

// The main query from the architecture document
export const GET_COMPACT_DETAILS = `
  query GetDetails(
    $allocator: String!,
    $sponsor: String!,
    $lockId: BigInt!,
    $chainId: BigInt!,
    $finalizationTimestamp: BigInt!,
    $thresholdTimestamp: BigInt!
  ) {
    accountDeltas(
      where: {
        address: $sponsor,
        resourceLock: $lockId,
        chainId: $chainId,
        delta_gt: "0",
        blockTimestamp_gt: $finalizationTimestamp
      },
      orderBy: "blockTimestamp",
      orderDirection: "DESC"
    ) {
      items {
        delta
      }
    }
    account(address: $sponsor) {
      resourceLocks(where: {resourceLock: $lockId, chainId: $chainId}) {
        items {
          withdrawalStatus
          balance
        }
      }
      claims(
        where: {
          allocator: $allocator,
          chainId: $chainId,
          timestamp_gt: $thresholdTimestamp
        },
        orderBy: "timestamp",
        orderDirection: "DESC"
      ) {
        items {
          claimHash
        }
      }
    }
  }
`;

export interface CompactDetailsVariables {
  allocator: string;
  sponsor: string;
  lockId: string;
  chainId: string;
  finalizationTimestamp: string;
  thresholdTimestamp: string;
  [key: string]: string; // Add index signature for GraphQL client
}

// Base variables without timestamps
export type CompactDetailsBaseVariables = Omit<
  CompactDetailsVariables,
  'finalizationTimestamp' | 'thresholdTimestamp'
>;

// Function to fetch compact details
export async function getCompactDetails({
  allocator,
  sponsor,
  lockId,
  chainId,
}: {
  allocator: string;
  sponsor: string;
  lockId: string;
  chainId: string;
}): Promise<AccountDeltasResponse & AccountResponse> {
  const { finalizationTimestamp, thresholdTimestamp } =
    calculateQueryTimestamps(chainId);

  return graphqlClient.request(GET_COMPACT_DETAILS, {
    allocator: allocator.toLowerCase(),
    sponsor: sponsor.toLowerCase(),
    lockId,
    chainId,
    finalizationTimestamp: finalizationTimestamp.toString(),
    thresholdTimestamp: thresholdTimestamp.toString(),
  });
}

// Query to check if a nonce has been consumed
export const CHECK_CONSUMED_NONCE = `
  query CheckConsumedNonce($allocator: String!, $chainId: BigInt!, $nonce: BigInt!) {
    consumedNonce(allocator: $allocator, chainId: $chainId, nonce: $nonce) {
      blockNumber
    }
  }
`;

// Function to check if a nonce has been consumed on-chain
export async function isNonceConsumedOnChain(
  allocator: string,
  chainId: string,
  nonce: string
): Promise<boolean> {
  try {
    const response = await graphqlClient.request<ConsumedNonceResponse>(
      CHECK_CONSUMED_NONCE,
      {
        allocator: allocator.toLowerCase(),
        chainId,
        nonce,
      }
    );

    // If blockNumber is not null, the nonce has been consumed
    return (
      response.consumedNonce?.blockNumber !== null &&
      response.consumedNonce?.blockNumber !== undefined
    );
  } catch (error) {
    // If there's an error, we should be conservative and assume it might be consumed
    console.error('Error checking nonce consumption:', error);
    // Return false to allow local database to be the source of truth if indexer is down
    return false;
  }
}

export async function getAllResourceLocks(
  sponsor: string
): Promise<AllResourceLocksResponse> {
  return graphqlClient.request(
    `
    query GetAllResourceLocks($sponsor: String!) {
      account(address: $sponsor) {
        resourceLocks {
          items {
            chainId
            resourceLock {
              lockId
              allocatorAddress
            }
          }
        }
      }
    }
    `,
    { sponsor: sponsor.toLowerCase() }
  );
}

export interface ProcessedCompactDetails {
  totalDelta: bigint;
  allocatorId: string | null;
  withdrawalStatus: number | null;
  balance: string | null;
  claimHashes: string[];
}

export function processCompactDetails(
  response: AccountDeltasResponse & AccountResponse,
  chainId: string
): ProcessedCompactDetails {
  // Get allocatorId from cache
  const chainConfig = supportedChainsCache?.find(
    (chain) => chain.chainId === chainId
  );
  const allocatorId = chainConfig?.allocatorId ?? null;

  // Sum up all deltas
  const totalDelta = response.accountDeltas.items.reduce(
    (sum, item) => sum + BigInt(item.delta),
    BigInt(0)
  );

  // Extract withdrawal status and balance (may not be present if no resource locks found)
  const resourceLock = response.account.resourceLocks.items[0];
  const withdrawalStatus = resourceLock?.withdrawalStatus ?? null;
  const balance = resourceLock?.balance ?? null;

  // Extract all claim hashes
  const claimHashes = response.account.claims.items.map(
    (item) => item.claimHash
  );

  return {
    totalDelta,
    allocatorId,
    withdrawalStatus,
    balance,
    claimHashes,
  };
}

// ============================================================
// Hybrid Allocator Integration (via Unified Indexer)
// ============================================================

// Response types for hybrid allocator data
export interface HybridAllocationResponse {
  allocation: {
    claimHash: string;
    sponsorAddress: string;
    nonce: string;
    expires: string;
    commitments: string; // JSON string of Lock[]
    timestamp: string;
  } | null;
}

export interface HybridAllocationsResponse {
  allocations: {
    items: Array<{
      claimHash: string;
      nonce: string;
      expires: string;
      commitments: string; // JSON string of Lock[]
      timestamp: string;
    }>;
  };
}

export interface HybridSignersResponse {
  signers: {
    items: Array<{
      address: string;
      isActive: boolean;
    }>;
  };
}

export interface HybridAllocatorInstanceResponse {
  allocatorInstance: {
    allocatorId: string;
    ownerAddress: string;
    compactAddress: string;
  } | null;
}

// Query to get allocation by claim hash
export const GET_ALLOCATION_BY_CLAIM_HASH = `
  query GetAllocation($claimHash: String!, $chainId: BigInt!) {
    allocation(id: $claimHash) {
      claimHash
      sponsorAddress
      nonce
      expires
      commitments
      timestamp
    }
  }
`;

// Query to get allocations for a sponsor
export const GET_ALLOCATIONS_FOR_SPONSOR = `
  query GetAllocations($sponsor: String!, $chainId: BigInt!) {
    allocations(where: { sponsorAddress: $sponsor, chainId: $chainId }) {
      items {
        claimHash
        nonce
        expires
        commitments
        timestamp
      }
    }
  }
`;

// Query to get active signers
export const GET_ACTIVE_SIGNERS = `
  query GetActiveSigners {
    signers(where: { isActive: true }) {
      items {
        address
        isActive
      }
    }
  }
`;

// Query to get allocator instance info
export const GET_ALLOCATOR_INSTANCE = `
  query GetAllocatorInstance($chainId: BigInt!) {
    allocatorInstance(chainId: $chainId) {
      allocatorId
      ownerAddress
      compactAddress
    }
  }
`;

// Query to check if a compact has been registered on-chain (finalized)
// Uses timestamp_lte filter to only return registrations older than finalization threshold
export const GET_FINALIZED_REGISTERED_COMPACT = `
  query GetFinalizedRegisteredCompact($claimHash: String!, $chainId: BigInt!, $finalizationTimestamp: BigInt!) {
    registeredCompacts(
      where: {
        claimHash: $claimHash,
        chainId: $chainId,
        timestamp_lte: $finalizationTimestamp
      },
      limit: 1
    ) {
      items {
        claimHash
        sponsor
        timestamp
        blockNumber
        typehash
      }
    }
  }
`;

// Response type for registered compact query
export interface FinalizedRegisteredCompactResponse {
  registeredCompacts: {
    items: Array<{
      claimHash: string;
      sponsor: string;
      timestamp: string;
      blockNumber: string;
      typehash: string;
    }>;
  };
}

/**
 * Check if a compact has been registered on-chain AND is finalized.
 *
 * IMPORTANT: This function throws on error to ensure fail-closed behavior.
 * The allocator must verify on-chain registration before signing.
 *
 * Only returns registrations that are older than the chain's finalization
 * threshold to protect against reorgs.
 *
 * @param claimHash - The claim hash of the compact
 * @param chainId - The chain ID
 * @returns The registered compact details, or null if not registered/finalized
 * @throws Error if the indexer cannot be reached
 */
export async function getFinalizedRegisteredCompact(
  claimHash: string,
  chainId: string
): Promise<
  FinalizedRegisteredCompactResponse['registeredCompacts']['items'][0] | null
> {
  // Calculate finalization timestamp (current time - finalization threshold)
  const { finalizationTimestamp } = calculateQueryTimestamps(chainId);

  // Let errors propagate (fail-closed)
  const response =
    await graphqlClient.request<FinalizedRegisteredCompactResponse>(
      GET_FINALIZED_REGISTERED_COMPACT,
      {
        claimHash,
        chainId,
        finalizationTimestamp: finalizationTimestamp.toString(),
      }
    );

  return response.registeredCompacts.items[0] || null;
}

// Simple health check query (minimal query to test connectivity)
const HEALTH_CHECK_QUERY = `
  query HealthCheck {
    __typename
  }
`;

/**
 * Check if an allocation exists in the indexer
 */
export async function getHybridAllocation(
  claimHash: string,
  chainId: string
): Promise<HybridAllocationResponse['allocation']> {
  try {
    const response = await graphqlClient.request<HybridAllocationResponse>(
      GET_ALLOCATION_BY_CLAIM_HASH,
      { claimHash, chainId }
    );
    return response.allocation;
  } catch (error) {
    console.error('Error fetching hybrid allocation:', error);
    return null;
  }
}

/**
 * Get all allocations for a sponsor from the indexer.
 *
 * IMPORTANT: This function throws on error to ensure fail-closed behavior.
 * The allocator must NEVER issue allocations if on-chain state cannot be verified.
 *
 * @throws Error if allocations cannot be fetched
 */
export async function getHybridAllocationsForSponsor(
  sponsor: string,
  chainId: string
): Promise<HybridAllocationsResponse['allocations']['items']> {
  // Let errors propagate (fail-closed)
  const response = await graphqlClient.request<HybridAllocationsResponse>(
    GET_ALLOCATIONS_FOR_SPONSOR,
    { sponsor: sponsor.toLowerCase(), chainId }
  );
  return response.allocations.items;
}

/**
 * Get active signers from the indexer
 */
export async function getActiveSigners(): Promise<string[]> {
  try {
    const response =
      await graphqlClient.request<HybridSignersResponse>(GET_ACTIVE_SIGNERS);
    return response.signers.items
      .filter((s) => s.isActive)
      .map((s) => s.address);
  } catch (error) {
    console.error('Error fetching active signers:', error);
    return [];
  }
}

// Lock interface for parsing commitments JSON
interface Lock {
  lockTag: string;
  token: string;
  amount: string;
}

/**
 * Get on-chain allocated balance for a specific sponsor and lockId from the indexer.
 * This sums up all allocation amounts that:
 * 1. Match the sponsor address
 * 2. Match the lockId (lockTag + token combination)
 * 3. Haven't expired yet
 * 4. Are not in the processed claims list
 *
 * IMPORTANT: This function throws on error to prevent over-allocation.
 * The allocator must NEVER issue allocations if on-chain state cannot be verified.
 *
 * @param sponsor - The sponsor address
 * @param chainId - The chain ID
 * @param lockId - The lock ID (lockTag << 160 | token)
 * @param processedClaimHashes - List of claim hashes that have already been processed
 * @returns Total on-chain allocated balance for the lockId
 * @throws Error if on-chain allocations cannot be fetched
 */
export async function getOnChainAllocatedBalance(
  sponsor: string,
  chainId: string,
  lockId: bigint,
  processedClaimHashes: string[]
): Promise<bigint> {
  // Fetch allocations - let errors propagate (fail-closed)
  const allocations = await getHybridAllocationsForSponsor(sponsor, chainId);

  if (allocations.length === 0) {
    return BigInt(0);
  }

  const currentTimeSeconds = BigInt(Math.floor(Date.now() / 1000));

  // Convert processed claim hashes to lowercase for comparison
  const processedClaimsSet = new Set(
    processedClaimHashes.map((h) => h.toLowerCase())
  );

  // Extract lockTag and token from lockId for comparison
  // Lock ID = (lockTag << 160) | token
  const tokenMask = (BigInt(1) << BigInt(160)) - BigInt(1);
  const targetToken = lockId & tokenMask;
  const targetLockTag = lockId >> BigInt(160);

  let totalAllocated = BigInt(0);

  for (const allocation of allocations) {
    // Skip expired allocations
    if (BigInt(allocation.expires) <= currentTimeSeconds) {
      continue;
    }

    // Skip already processed claims
    if (processedClaimsSet.has(allocation.claimHash.toLowerCase())) {
      continue;
    }

    // Parse commitments JSON - fail-closed on parse errors
    let commitments: Lock[];
    try {
      commitments = JSON.parse(allocation.commitments) as Lock[];
    } catch (parseError) {
      // If we can't parse commitments, we can't safely determine allocation amounts
      // Fail-closed to prevent potential over-allocation
      throw new Error(
        `Failed to parse commitments for allocation ${allocation.claimHash}: ` +
          `${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
    }

    for (const commitment of commitments) {
      // Normalize and compare lockTag and token
      const commitmentLockTag = BigInt(commitment.lockTag);
      const commitmentToken = BigInt(commitment.token);

      if (
        commitmentLockTag === targetLockTag &&
        commitmentToken === targetToken
      ) {
        totalAllocated += BigInt(commitment.amount);
      }
    }
  }

  return totalAllocated;
}

/**
 * Check health of the unified indexer
 * Returns true only if the indexer is healthy (fail-closed behavior)
 */
export async function checkIndexersHealth(): Promise<{
  allHealthy: boolean;
  compactIndexer: boolean;
  hybridAllocatorIndexer: boolean;
}> {
  const now = Date.now();

  // Return cached status if still valid
  if (now - indexerHealthStatus.lastCheck < HEALTH_CHECK_TTL) {
    return {
      allHealthy: indexerHealthStatus.indexer,
      // Both report the same status since it's a unified indexer
      compactIndexer: indexerHealthStatus.indexer,
      hybridAllocatorIndexer: indexerHealthStatus.indexer,
    };
  }

  // Check the unified indexer
  const indexerHealth = await checkIndexerHealth();

  // Update cached status
  indexerHealthStatus = {
    indexer: indexerHealth,
    lastCheck: now,
  };

  return {
    allHealthy: indexerHealth,
    // Both report the same status since it's a unified indexer
    compactIndexer: indexerHealth,
    hybridAllocatorIndexer: indexerHealth,
  };
}

/**
 * Check if the unified indexer is healthy
 */
async function checkIndexerHealth(): Promise<boolean> {
  try {
    await graphqlClient.request(HEALTH_CHECK_QUERY);
    return true;
  } catch {
    // Silently return false on health check failure - the caller will handle appropriately
    return false;
  }
}

/**
 * Ensure the indexer is healthy before proceeding with off-chain allocation
 * Throws an error if the indexer is unhealthy (fail-closed)
 */
export async function ensureIndexersHealthy(): Promise<void> {
  const health = await checkIndexersHealth();

  if (!health.allHealthy) {
    throw new Error(
      `Service temporarily unavailable: cannot verify allocation safety. ` +
        `Unhealthy indexer: unified-compact-indexer`
    );
  }
}

/**
 * Get the current indexer health status without making a new request
 */
export function getIndexerHealthStatus(): IndexerHealthStatus {
  return { ...indexerHealthStatus };
}

/**
 * Reset the indexer health cache (for testing purposes)
 */
export function resetIndexerHealthCache(): void {
  indexerHealthStatus = {
    indexer: true,
    lastCheck: 0,
  };
}
