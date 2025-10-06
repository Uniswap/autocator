import { getAddress } from 'viem/utils';
import {
  ValidationResult,
  CompactMessage,
  ValidatedCompactMessage,
  BatchCompactMessage,
  ValidatedBatchCompactMessage,
  MultichainCompactMessage,
  ValidatedMultichainCompactMessage,
} from './types';
import { toPositiveBigInt } from '../utils/encoding';

export async function validateStructure(
  compact: CompactMessage
): Promise<ValidationResult & { validatedCompact?: ValidatedCompactMessage }> {
  try {
    // Check arbiter and sponsor addresses
    try {
      getAddress(compact.arbiter);
      getAddress(compact.sponsor);
    } catch (err) {
      return {
        isValid: false,
        error: `Invalid arbiter address: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }

    try {
      // Convert and validate id
      const id = toPositiveBigInt(compact.id, 'id');

      // Convert and validate expires
      const expires = toPositiveBigInt(compact.expires, 'expires');

      // Convert and validate amount
      const amount = toPositiveBigInt(compact.amount, 'amount');

      // Nonce is required
      if (compact.nonce === null) {
        return {
          isValid: false,
          error:
            'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
        };
      }

      // Convert and validate nonce
      const nonce = toPositiveBigInt(compact.nonce, 'nonce');

      // Create validated compact message
      const validatedCompact: ValidatedCompactMessage = {
        arbiter: compact.arbiter,
        sponsor: compact.sponsor,
        nonce,
        expires,
        id,
        amount: amount.toString(),
        witnessTypeString: compact.witnessTypeString,
        witnessHash: compact.witnessHash,
      };

      // Check witness data consistency
      if (
        (validatedCompact.witnessTypeString === null &&
          validatedCompact.witnessHash !== null) ||
        (validatedCompact.witnessTypeString !== null &&
          validatedCompact.witnessHash === null)
      ) {
        return {
          isValid: false,
          error: 'Witness type and hash must both be present or both be null',
        };
      }

      return { isValid: true, validatedCompact };
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      isValid: false,
      error: `Structural validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function validateExpiration(expires: bigint): ValidationResult {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const twoHours = BigInt(7200);

  if (expires <= now) {
    return {
      isValid: false,
      error: 'Compact has expired',
    };
  }

  if (expires > now + twoHours) {
    return {
      isValid: false,
      error: 'Expiration must be within 2 hours',
    };
  }

  return { isValid: true };
}

// Validation for BatchCompact structure
export async function validateBatchStructure(
  compact: BatchCompactMessage
): Promise<
  ValidationResult & { validatedCompact?: ValidatedBatchCompactMessage }
> {
  try {
    // Check arbiter and sponsor addresses
    try {
      getAddress(compact.arbiter);
      getAddress(compact.sponsor);
    } catch (err) {
      return {
        isValid: false,
        error: `Invalid address: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }

    // Nonce is required
    if (compact.nonce === null) {
      return {
        isValid: false,
        error:
          'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
      };
    }

    // Convert and validate nonce
    const nonce = toPositiveBigInt(compact.nonce, 'nonce');

    // Convert and validate expires
    const expires = toPositiveBigInt(compact.expires, 'expires');

    // Validate commitments
    if (!compact.commitments || compact.commitments.length === 0) {
      return {
        isValid: false,
        error: 'BatchCompact must have at least one commitment',
      };
    }

    // Validate each commitment
    const validatedCommitments = [];
    for (const commitment of compact.commitments) {
      // Validate lock tag (should be hex string)
      if (
        !commitment.lockTag ||
        !commitment.lockTag.match(/^0x[0-9a-fA-F]{24}$/)
      ) {
        return {
          isValid: false,
          error: `Invalid lock tag format: ${commitment.lockTag}`,
        };
      }

      // Validate token address
      try {
        getAddress(commitment.token);
      } catch {
        return {
          isValid: false,
          error: `Invalid token address: ${commitment.token}`,
        };
      }

      // Validate amount
      const amount = toPositiveBigInt(commitment.amount, 'commitment amount');

      validatedCommitments.push({
        lockTag: commitment.lockTag,
        token: commitment.token,
        amount: amount.toString(),
      });
    }

    // Create validated batch compact message
    const validatedCompact: ValidatedBatchCompactMessage = {
      arbiter: compact.arbiter,
      sponsor: compact.sponsor,
      nonce,
      expires,
      commitments: validatedCommitments,
      witnessTypeString: compact.witnessTypeString,
      witnessHash: compact.witnessHash,
    };

    // Check witness data consistency
    if (
      (validatedCompact.witnessTypeString === null &&
        validatedCompact.witnessHash !== null) ||
      (validatedCompact.witnessTypeString !== null &&
        validatedCompact.witnessHash === null)
    ) {
      return {
        isValid: false,
        error: 'Witness type and hash must both be present or both be null',
      };
    }

    return { isValid: true, validatedCompact };
  } catch (error) {
    return {
      isValid: false,
      error: `Batch structural validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// Validation for MultichainCompact structure
export async function validateMultichainStructure(
  compact: MultichainCompactMessage
): Promise<
  ValidationResult & { validatedCompact?: ValidatedMultichainCompactMessage }
> {
  try {
    // Check sponsor address
    try {
      getAddress(compact.sponsor);
    } catch (err) {
      return {
        isValid: false,
        error: `Invalid sponsor address: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }

    // Nonce is required
    if (compact.nonce === null) {
      return {
        isValid: false,
        error:
          'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.',
      };
    }

    // Convert and validate nonce
    const nonce = toPositiveBigInt(compact.nonce, 'nonce');

    // Convert and validate expires
    const expires = toPositiveBigInt(compact.expires, 'expires');

    // Validate elements
    if (!compact.elements || compact.elements.length === 0) {
      return {
        isValid: false,
        error: 'MultichainCompact must have at least one element',
      };
    }

    // Validate each element
    const validatedElements = [];
    for (const element of compact.elements) {
      // Check arbiter address
      try {
        getAddress(element.arbiter);
      } catch {
        return {
          isValid: false,
          error: `Invalid arbiter address in element: ${element.arbiter}`,
        };
      }

      // Validate chain ID
      const chainId = toPositiveBigInt(element.chainId, 'element chainId');

      // Validate commitments in element
      if (!element.commitments || element.commitments.length === 0) {
        return {
          isValid: false,
          error: 'Each element must have at least one commitment',
        };
      }

      const validatedCommitments = [];
      for (const commitment of element.commitments) {
        // Validate lock tag (should be hex string)
        if (
          !commitment.lockTag ||
          !commitment.lockTag.match(/^0x[0-9a-fA-F]{24}$/)
        ) {
          return {
            isValid: false,
            error: `Invalid lock tag format in element: ${commitment.lockTag}`,
          };
        }

        // Validate token address
        try {
          getAddress(commitment.token);
        } catch {
          return {
            isValid: false,
            error: `Invalid token address in element: ${commitment.token}`,
          };
        }

        // Validate amount
        const amount = toPositiveBigInt(commitment.amount, 'commitment amount');

        validatedCommitments.push({
          lockTag: commitment.lockTag,
          token: commitment.token,
          amount: amount.toString(),
        });
      }

      // Validate witnessHash (required for each element)
      if (!element.witnessHash) {
        return {
          isValid: false,
          error: 'Each element must have a witnessHash',
        };
      }

      validatedElements.push({
        arbiter: element.arbiter,
        chainId,
        commitments: validatedCommitments,
        witnessHash: element.witnessHash,
      });
    }

    // Validate witnessTypeString (required for multichain compacts)
    if (!compact.witnessTypeString) {
      return {
        isValid: false,
        error: 'MultichainCompact must have a witnessTypeString',
      };
    }

    // Create validated multichain compact message
    const validatedCompact: ValidatedMultichainCompactMessage = {
      sponsor: compact.sponsor,
      nonce,
      expires,
      elements: validatedElements,
      witnessTypeString: compact.witnessTypeString,
    };

    return { isValid: true, validatedCompact };
  } catch (error) {
    return {
      isValid: false,
      error: `Multichain structural validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
