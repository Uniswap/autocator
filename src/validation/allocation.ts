import { getAddress } from 'viem/utils';
import { PGlite } from '@electric-sql/pglite';
import { getCompactDetails, getCachedSupportedChains } from '../graphql';
import { getAllocatedBalance } from '../balance';
import {
  ValidationResult,
  ValidatedCompactMessage,
  ValidatedBatchCompactMessage,
  ValidatedMultichainCompactMessage,
} from './types';

// Helper function to build lock ID from token and lock tag
function buildLockId(token: string, lockTag: string): bigint {
  // Lock ID = (lockTag << 160) | token
  const tokenAddress = BigInt(token);
  const lockTagValue = BigInt(lockTag);
  return (lockTagValue << BigInt(160)) | tokenAddress;
}

export async function validateAllocation(
  compact: ValidatedCompactMessage,
  chainId: string,
  db: PGlite
): Promise<ValidationResult> {
  try {
    // Extract allocatorId from the compact id
    const allocatorId =
      (compact.id >> BigInt(160)) & ((BigInt(1) << BigInt(92)) - BigInt(1));

    const response = await getCompactDetails({
      allocator: process.env.ALLOCATOR_ADDRESS!,
      sponsor: compact.sponsor,
      lockId: compact.id.toString(),
      chainId,
    });

    // Check withdrawal status
    const resourceLock = response.account.resourceLocks.items[0];
    if (!resourceLock) {
      return { isValid: false, error: 'Resource lock not found' };
    }

    if (resourceLock.withdrawalStatus !== 0) {
      return {
        isValid: false,
        error: 'Resource lock has forced withdrawals enabled',
      };
    }

    // Get the cached chain config to verify allocatorId
    const chainConfig = getCachedSupportedChains()?.find(
      (chain) => chain.chainId === chainId
    );

    // Verify allocatorId matches
    if (!chainConfig || BigInt(chainConfig.allocatorId) !== allocatorId) {
      return { isValid: false, error: 'Invalid allocator ID' };
    }

    // Calculate pending balance
    const pendingBalance = response.accountDeltas.items.reduce(
      (sum, delta) => sum + BigInt(delta.delta),
      BigInt(0)
    );

    // Calculate allocatable balance
    const resourceLockBalance = BigInt(resourceLock.balance);
    const allocatableBalance =
      resourceLockBalance > pendingBalance
        ? resourceLockBalance - pendingBalance
        : BigInt(0);

    // Get allocated balance from database with proper hex formatting
    const allocatedBalance = await getAllocatedBalance(
      db,
      getAddress(compact.sponsor).toLowerCase(),
      chainId,
      compact.id,
      response.account.claims.items.map((item) => item.claimHash)
    );

    // Convert amount string to BigInt for comparison
    const compactAmount = BigInt(compact.amount);

    // Verify sufficient balance
    const totalNeededBalance = allocatedBalance + compactAmount;
    if (allocatableBalance < totalNeededBalance) {
      return {
        isValid: false,
        error: `Insufficient allocatable balance (have ${allocatableBalance}, need ${totalNeededBalance})`,
      };
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Allocation validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// Validate allocation for BatchCompact
export async function validateBatchAllocation(
  compact: ValidatedBatchCompactMessage,
  chainId: string,
  db: PGlite
): Promise<ValidationResult> {
  try {
    // Get the cached chain config to verify allocatorId
    const chainConfig = getCachedSupportedChains()?.find(
      (chain) => chain.chainId === chainId
    );

    if (!chainConfig) {
      return { isValid: false, error: 'Chain configuration not found' };
    }

    // Check each commitment in the batch
    for (const commitment of compact.commitments) {
      const lockId = buildLockId(commitment.token, commitment.lockTag);

      // Extract allocatorId from lock tag
      const allocatorId =
        (BigInt(commitment.lockTag) >> BigInt(4)) &
        ((BigInt(1) << BigInt(92)) - BigInt(1));

      // Verify allocatorId matches
      if (BigInt(chainConfig.allocatorId) !== allocatorId) {
        return {
          isValid: false,
          error: `Invalid allocator ID for commitment with lockTag ${commitment.lockTag}`,
        };
      }

      const response = await getCompactDetails({
        allocator: process.env.ALLOCATOR_ADDRESS!,
        sponsor: compact.sponsor,
        lockId: lockId.toString(),
        chainId,
      });

      // Check withdrawal status
      const resourceLock = response.account.resourceLocks.items[0];
      if (!resourceLock) {
        return {
          isValid: false,
          error: `Resource lock not found for commitment ${commitment.lockTag}`,
        };
      }

      if (resourceLock.withdrawalStatus !== 0) {
        return {
          isValid: false,
          error: `Resource lock ${commitment.lockTag} has forced withdrawals enabled`,
        };
      }

      // Calculate pending balance
      const pendingBalance = response.accountDeltas.items.reduce(
        (sum, delta) => sum + BigInt(delta.delta),
        BigInt(0)
      );

      // Calculate allocatable balance
      const resourceLockBalance = BigInt(resourceLock.balance);
      const allocatableBalance =
        resourceLockBalance > pendingBalance
          ? resourceLockBalance - pendingBalance
          : BigInt(0);

      // Get allocated balance from database
      const allocatedBalance = await getAllocatedBalance(
        db,
        getAddress(compact.sponsor).toLowerCase(),
        chainId,
        lockId,
        response.account.claims.items.map((item) => item.claimHash)
      );

      // Convert amount string to BigInt for comparison
      const compactAmount = BigInt(commitment.amount);

      // Verify sufficient balance
      const totalNeededBalance = allocatedBalance + compactAmount;
      if (allocatableBalance < totalNeededBalance) {
        return {
          isValid: false,
          error: `Insufficient allocatable balance for commitment ${commitment.lockTag} (have ${allocatableBalance}, need ${totalNeededBalance})`,
        };
      }
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Batch allocation validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// Validate allocation for MultichainCompact
export async function validateMultichainAllocation(
  compact: ValidatedMultichainCompactMessage,
  chainId: string,
  db: PGlite
): Promise<ValidationResult> {
  try {
    // Get the cached chain config to verify allocatorId
    const chainConfig = getCachedSupportedChains()?.find(
      (chain) => chain.chainId === chainId
    );

    if (!chainConfig) {
      return { isValid: false, error: 'Chain configuration not found' };
    }

    // Find elements for current chain
    const currentChainElements = compact.elements.filter(
      (element) => element.chainId === BigInt(chainId)
    );

    if (currentChainElements.length === 0) {
      return {
        isValid: false,
        error: `No elements found for chain ${chainId}`,
      };
    }

    // Check each element for this chain
    for (const element of currentChainElements) {
      // Check each commitment in the element
      for (const commitment of element.commitments) {
        const lockId = buildLockId(commitment.token, commitment.lockTag);

        // Extract allocatorId from lock tag
        const allocatorId =
          (BigInt(commitment.lockTag) >> BigInt(4)) &
          ((BigInt(1) << BigInt(92)) - BigInt(1));

        // Verify allocatorId matches
        if (BigInt(chainConfig.allocatorId) !== allocatorId) {
          return {
            isValid: false,
            error: `Invalid allocator ID for commitment with lockTag ${commitment.lockTag}`,
          };
        }

        const response = await getCompactDetails({
          allocator: process.env.ALLOCATOR_ADDRESS!,
          sponsor: compact.sponsor,
          lockId: lockId.toString(),
          chainId,
        });

        // Check withdrawal status
        const resourceLock = response.account.resourceLocks.items[0];
        if (!resourceLock) {
          return {
            isValid: false,
            error: `Resource lock not found for commitment ${commitment.lockTag}`,
          };
        }

        if (resourceLock.withdrawalStatus !== 0) {
          return {
            isValid: false,
            error: `Resource lock ${commitment.lockTag} has forced withdrawals enabled`,
          };
        }

        // Calculate pending balance
        const pendingBalance = response.accountDeltas.items.reduce(
          (sum, delta) => sum + BigInt(delta.delta),
          BigInt(0)
        );

        // Calculate allocatable balance
        const resourceLockBalance = BigInt(resourceLock.balance);
        const allocatableBalance =
          resourceLockBalance > pendingBalance
            ? resourceLockBalance - pendingBalance
            : BigInt(0);

        // Get allocated balance from database
        const allocatedBalance = await getAllocatedBalance(
          db,
          getAddress(compact.sponsor).toLowerCase(),
          chainId,
          lockId,
          response.account.claims.items.map((item) => item.claimHash)
        );

        // Convert amount string to BigInt for comparison
        const compactAmount = BigInt(commitment.amount);

        // Verify sufficient balance
        const totalNeededBalance = allocatedBalance + compactAmount;
        if (allocatableBalance < totalNeededBalance) {
          return {
            isValid: false,
            error: `Insufficient allocatable balance for commitment ${commitment.lockTag} (have ${allocatableBalance}, need ${totalNeededBalance})`,
          };
        }
      }
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Multichain allocation validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
