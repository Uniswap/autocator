import { PGlite } from '@electric-sql/pglite';
import {
  ValidationResult,
  CompactMessage,
  BatchCompactMessage,
  MultichainCompactMessage,
  ValidatedCompactMessage,
  ValidatedBatchCompactMessage,
  ValidatedMultichainCompactMessage,
  AnyCompactMessage,
  AnyValidatedCompactMessage,
  CompactCategory,
  getCompactCategory,
} from './types';
import { validateNonce } from './nonce';
import {
  validateStructure,
  validateExpiration,
  validateBatchStructure,
  validateMultichainStructure,
} from './structure';
import { validateDomainAndId } from './domain';
import {
  validateAllocation,
  validateBatchAllocation,
  validateMultichainAllocation,
} from './allocation';

// Main validation function that routes to appropriate validator
export async function validateAnyCompact(
  compact: AnyCompactMessage,
  chainId: string,
  db: PGlite
): Promise<
  ValidationResult & { validatedCompact?: AnyValidatedCompactMessage }
> {
  const category = getCompactCategory(compact);

  switch (category) {
    case CompactCategory.Compact:
      return validateCompact(compact as CompactMessage, chainId, db);
    case CompactCategory.BatchCompact:
      return validateBatchCompact(compact as BatchCompactMessage, chainId, db);
    case CompactCategory.MultichainCompact:
      return validateMultichainCompact(
        compact as MultichainCompactMessage,
        chainId,
        db
      );
    default:
      return { isValid: false, error: 'Unknown compact type' };
  }
}

// Original Compact validation (single resource lock)
export async function validateCompact(
  compact: CompactMessage,
  chainId: string,
  db: PGlite
): Promise<ValidationResult & { validatedCompact?: ValidatedCompactMessage }> {
  try {
    // 1. Chain ID validation
    const chainIdNum = parseInt(chainId);
    if (
      isNaN(chainIdNum) ||
      chainIdNum <= 0 ||
      chainIdNum.toString() !== chainId
    ) {
      return { isValid: false, error: 'Invalid chain ID format' };
    }

    // 2. Structural Validation
    const structureResult = await validateStructure(compact);
    if (!structureResult.isValid || !structureResult.validatedCompact) {
      return structureResult;
    }

    const validatedCompact = structureResult.validatedCompact;

    // 3. Nonce Validation (nonce is required)
    if (validatedCompact.nonce === null) {
      return {
        isValid: false,
        error:
          'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
      };
    }

    const nonceResult = await validateNonce(
      validatedCompact.nonce,
      validatedCompact.sponsor,
      chainId,
      db,
      process.env.ALLOCATOR_ADDRESS
    );
    if (!nonceResult.isValid) return nonceResult;

    // 4. Expiration Validation
    const expirationResult = validateExpiration(validatedCompact.expires);
    if (!expirationResult.isValid) return expirationResult;

    // 5. Domain and ID Validation
    const domainResult = await validateDomainAndId(
      validatedCompact.id,
      validatedCompact.expires,
      chainId,
      process.env.ALLOCATOR_ADDRESS!
    );
    if (!domainResult.isValid) return domainResult;

    // 6. Allocation Validation
    const allocationResult = await validateAllocation(
      validatedCompact,
      chainId,
      db
    );
    if (!allocationResult.isValid) return allocationResult;

    return { isValid: true, validatedCompact };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}

// BatchCompact validation (multiple resource locks)
export async function validateBatchCompact(
  compact: BatchCompactMessage,
  chainId: string,
  db: PGlite
): Promise<
  ValidationResult & { validatedCompact?: ValidatedBatchCompactMessage }
> {
  try {
    // 1. Chain ID validation
    const chainIdNum = parseInt(chainId);
    if (
      isNaN(chainIdNum) ||
      chainIdNum <= 0 ||
      chainIdNum.toString() !== chainId
    ) {
      return { isValid: false, error: 'Invalid chain ID format' };
    }

    // 2. Structural Validation
    const structureResult = await validateBatchStructure(compact);
    if (!structureResult.isValid || !structureResult.validatedCompact) {
      return structureResult;
    }

    const validatedCompact = structureResult.validatedCompact;

    // 3. Nonce Validation (nonce is required)
    if (validatedCompact.nonce === null) {
      return {
        isValid: false,
        error:
          'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
      };
    }

    const nonceResult = await validateNonce(
      validatedCompact.nonce,
      validatedCompact.sponsor,
      chainId,
      db,
      process.env.ALLOCATOR_ADDRESS
    );
    if (!nonceResult.isValid) return nonceResult;

    // 4. Expiration Validation
    const expirationResult = validateExpiration(validatedCompact.expires);
    if (!expirationResult.isValid) return expirationResult;

    // 5. Validate commitments structure
    if (
      !validatedCompact.commitments ||
      validatedCompact.commitments.length === 0
    ) {
      return {
        isValid: false,
        error: 'BatchCompact must have at least one commitment',
      };
    }

    // 6. Allocation Validation for all commitments
    const allocationResult = await validateBatchAllocation(
      validatedCompact,
      chainId,
      db
    );
    if (!allocationResult.isValid) return allocationResult;

    return { isValid: true, validatedCompact };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}

// MultichainCompact validation (multiple chains)
export async function validateMultichainCompact(
  compact: MultichainCompactMessage,
  chainId: string,
  db: PGlite
): Promise<
  ValidationResult & { validatedCompact?: ValidatedMultichainCompactMessage }
> {
  try {
    // 1. Chain ID validation
    const chainIdNum = parseInt(chainId);
    if (
      isNaN(chainIdNum) ||
      chainIdNum <= 0 ||
      chainIdNum.toString() !== chainId
    ) {
      return { isValid: false, error: 'Invalid chain ID format' };
    }

    // 2. Structural Validation
    const structureResult = await validateMultichainStructure(compact);
    if (!structureResult.isValid || !structureResult.validatedCompact) {
      return structureResult;
    }

    const validatedCompact = structureResult.validatedCompact;

    // 3. Nonce Validation (nonce is required)
    if (validatedCompact.nonce === null) {
      return {
        isValid: false,
        error:
          'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
      };
    }

    const nonceResult = await validateNonce(
      validatedCompact.nonce,
      validatedCompact.sponsor,
      chainId,
      db,
      process.env.ALLOCATOR_ADDRESS
    );
    if (!nonceResult.isValid) return nonceResult;

    // 4. Expiration Validation
    const expirationResult = validateExpiration(validatedCompact.expires);
    if (!expirationResult.isValid) return expirationResult;

    // 5. Validate elements structure
    if (!validatedCompact.elements || validatedCompact.elements.length === 0) {
      return {
        isValid: false,
        error: 'MultichainCompact must have at least one element',
      };
    }

    // 6. Check if current chain is in the multichain compact
    const currentChainElement = validatedCompact.elements.find(
      (element) => element.chainId === BigInt(chainId)
    );

    if (!currentChainElement) {
      return {
        isValid: false,
        error: `Current chain ${chainId} not found in multichain compact elements`,
      };
    }

    // 7. Witness validation is handled in structure validation
    // Each element must have a witnessHash and the compact must have a witnessTypeString

    // 8. Allocation Validation for elements on this chain
    const allocationResult = await validateMultichainAllocation(
      validatedCompact,
      chainId,
      db
    );
    if (!allocationResult.isValid) return allocationResult;

    return { isValid: true, validatedCompact };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}
