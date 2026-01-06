/**
 * Arbiter Validation Module
 *
 * Manages the whitelist of allowed arbiters for compact allocation.
 * The Tribunal arbiter is included by default.
 */

import { getAddress } from 'viem';

// Contract addresses (same on all chains)
export const HYBRID_ALLOCATOR_ADDRESS =
  '0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B' as const;

export const TRIBUNAL_ADDRESS =
  '0x000000000000790009689f43bAedb61D67D45bB8' as const;

export const THE_COMPACT_ADDRESS =
  '0x00000000000000171ede64904551eeDF3C6C9788' as const;

// Default allowed arbiters (Tribunal is always allowed)
const DEFAULT_ALLOWED_ARBITERS = new Set([TRIBUNAL_ADDRESS.toLowerCase()]);

// Current set of allowed arbiters
let allowedArbiters: Set<string> = new Set(DEFAULT_ALLOWED_ARBITERS);

/**
 * Initialize the allowed arbiters set from environment configuration
 *
 * @param arbitersEnv - Comma-separated list of additional allowed arbiter addresses
 */
export function initializeAllowedArbiters(arbitersEnv?: string): void {
  // Start with default arbiters
  allowedArbiters = new Set(DEFAULT_ALLOWED_ARBITERS);

  // Add custom arbiters from environment if provided
  if (arbitersEnv && arbitersEnv.trim() !== '') {
    const customArbiters = arbitersEnv
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '')
      .map((a) => {
        try {
          return getAddress(a).toLowerCase();
        } catch {
          console.warn(`Invalid arbiter address: ${a}`);
          return null;
        }
      })
      .filter((a): a is string => a !== null);

    customArbiters.forEach((a) => allowedArbiters.add(a));
  }
}

/**
 * Normalize an address to checksummed format
 * Handles all-lowercase and all-uppercase addresses by treating them as valid
 *
 * @param address - The address to normalize
 * @returns The checksummed address
 */
function normalizeAddress(address: string): string {
  // If the address is all lowercase or all uppercase (after 0x), treat it as valid
  // and convert to checksummed format
  const hexPart = address.slice(2);
  if (hexPart === hexPart.toLowerCase() || hexPart === hexPart.toUpperCase()) {
    // All lowercase or all uppercase - convert to checksummed
    return getAddress(address.toLowerCase());
  }
  // Mixed case - must be checksummed, validate it
  return getAddress(address);
}

/**
 * Check if an arbiter address is in the allowed list
 *
 * @param arbiter - The arbiter address to check
 * @returns True if the arbiter is allowed
 */
export function isArbiterAllowed(arbiter: string): boolean {
  try {
    const normalized = normalizeAddress(arbiter).toLowerCase();
    return allowedArbiters.has(normalized);
  } catch {
    return false;
  }
}

/**
 * Validate an arbiter address
 *
 * @param arbiter - The arbiter address to validate
 * @returns Validation result with error message if not allowed
 */
export function validateArbiter(arbiter: string): {
  isValid: boolean;
  error?: string;
} {
  try {
    const normalized = getAddress(arbiter);

    if (!isArbiterAllowed(arbiter)) {
      return {
        isValid: false,
        error: `Arbiter ${normalized} is not in the allowed list`,
      };
    }

    return { isValid: true };
  } catch {
    return {
      isValid: false,
      error: `Invalid arbiter address: ${arbiter}`,
    };
  }
}

/**
 * Get the current list of allowed arbiters
 *
 * @returns Array of allowed arbiter addresses (checksummed)
 */
export function getAllowedArbiters(): string[] {
  return Array.from(allowedArbiters).map((a) => getAddress(a));
}

/**
 * Check if an address is the Tribunal arbiter
 *
 * @param arbiter - The arbiter address to check
 * @returns True if the arbiter is Tribunal
 */
export function isTribunal(arbiter: string): boolean {
  try {
    const normalized = getAddress(arbiter).toLowerCase();
    return normalized === TRIBUNAL_ADDRESS.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Add an arbiter to the allowed list (for runtime configuration)
 *
 * @param arbiter - The arbiter address to add
 * @returns True if added successfully, false if already exists or invalid
 */
export function addAllowedArbiter(arbiter: string): boolean {
  try {
    const normalized = getAddress(arbiter).toLowerCase();
    if (allowedArbiters.has(normalized)) {
      return false;
    }
    allowedArbiters.add(normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove an arbiter from the allowed list (cannot remove Tribunal)
 *
 * @param arbiter - The arbiter address to remove
 * @returns True if removed successfully, false if not found or is Tribunal
 */
export function removeAllowedArbiter(arbiter: string): boolean {
  try {
    const normalized = getAddress(arbiter).toLowerCase();

    // Cannot remove Tribunal (it's always allowed)
    if (normalized === TRIBUNAL_ADDRESS.toLowerCase()) {
      return false;
    }

    if (!allowedArbiters.has(normalized)) {
      return false;
    }

    allowedArbiters.delete(normalized);
    return true;
  } catch {
    return false;
  }
}
