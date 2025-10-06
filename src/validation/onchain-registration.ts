import { graphqlClient } from '../graphql';
import { getFinalizationThreshold } from '../chain-config';

// Define the types for our GraphQL responses
export interface RegisteredCompactResponse {
  registeredCompact: {
    blockNumber: string;
    timestamp: string;
    typehash: string;
    expires: string;
    sponsor: {
      address: string;
    };
    claim: {
      blockNumber: string;
      timestamp: string;
    } | null;
  } | null;
}

// Query to get registered compact details
export const GET_REGISTERED_COMPACT = `
  query GetRegisteredCompact($claimHash: String!, $chainId: BigInt!) {
    registeredCompact(claimHash: $claimHash, chainId: $chainId) {
      blockNumber
      timestamp
      typehash
      expires
      sponsor {
        address
      }
      claim {
        blockNumber
        timestamp
      }
    }
  }
`;

export enum OnchainRegistrationStatus {
  NOT_FOUND = 'NOT_FOUND',
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  CLAIM_PENDING = 'CLAIM_PENDING',
  CLAIMED = 'CLAIMED',
}

export interface OnchainRegistrationResult {
  status: OnchainRegistrationStatus;
  timeUntilFinalized?: number; // Seconds until registration is finalized
  timeUntilClaimFinalized?: number; // Seconds until claim is finalized
  registeredCompact?: RegisteredCompactResponse['registeredCompact'];
}

/**
 * Check if a compact is registered onchain
 * @param claimHash The hash of the compact to check
 * @param chainId The chain ID to check on
 * @returns The status of the onchain registration
 */
export async function checkOnchainRegistration(
  claimHash: string,
  chainId: string
): Promise<OnchainRegistrationResult> {
  try {
    // Get the finalization threshold for this chain
    const finalizationThreshold = getFinalizationThreshold(chainId);

    // Current time in seconds
    const currentTimeSeconds = Math.floor(Date.now() / 1000);

    // Query the indexer for the registered compact
    const response = await graphqlClient.request<RegisteredCompactResponse>(
      GET_REGISTERED_COMPACT,
      {
        claimHash,
        chainId,
      }
    );

    // If no registered compact is found, return NOT_FOUND
    if (!response.registeredCompact) {
      return { status: OnchainRegistrationStatus.NOT_FOUND };
    }

    const registeredCompact = response.registeredCompact;

    // Calculate the finalization timestamp for the registration
    const registrationTimestamp = parseInt(registeredCompact.timestamp);
    const registrationFinalizationTimestamp =
      registrationTimestamp + finalizationThreshold;

    // Check if the registration is still pending finalization
    if (currentTimeSeconds < registrationFinalizationTimestamp) {
      return {
        status: OnchainRegistrationStatus.PENDING,
        timeUntilFinalized:
          registrationFinalizationTimestamp - currentTimeSeconds,
        registeredCompact,
      };
    }

    // Check if there's a claim
    if (registeredCompact.claim) {
      // Calculate the finalization timestamp for the claim
      const claimTimestamp = parseInt(registeredCompact.claim.timestamp);
      const claimFinalizationTimestamp = claimTimestamp + finalizationThreshold;

      // Check if the claim is still pending finalization
      if (currentTimeSeconds < claimFinalizationTimestamp) {
        return {
          status: OnchainRegistrationStatus.CLAIM_PENDING,
          timeUntilClaimFinalized:
            claimFinalizationTimestamp - currentTimeSeconds,
          registeredCompact,
        };
      }

      // If the claim is finalized, return CLAIMED
      return {
        status: OnchainRegistrationStatus.CLAIMED,
        registeredCompact,
      };
    }

    // Check if the compact is expired
    // A compact is considered expired if the current time is past the expiration time plus the finalization threshold
    const expirationTimestamp = parseInt(registeredCompact.expires);
    const finalExpirationTimestamp =
      expirationTimestamp + finalizationThreshold;

    if (currentTimeSeconds > finalExpirationTimestamp) {
      return {
        status: OnchainRegistrationStatus.EXPIRED,
        registeredCompact,
      };
    }

    // If the registration is finalized, not expired, and has no claim, it's active
    return {
      status: OnchainRegistrationStatus.ACTIVE,
      registeredCompact,
    };
  } catch (error) {
    // If there's an error, throw it to be handled by the caller
    throw new Error(
      `Failed to check onchain registration: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
