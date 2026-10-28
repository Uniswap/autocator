/**
 * Hybrid Allocator Nonce Utilities
 *
 * Nonce Structure (32 bytes):
 * - Byte 0: Command (0x01=on-chain, 0x02=off-chain, 0x03=permit2)
 * - Bytes 1-20: Sponsor address (20 bytes)
 * - Bytes 21-31: Freely chosen nonce fragment (11 bytes)
 *
 * This differs from the current Autocator nonce format which is:
 * - Bytes 0-19: Sponsor address (20 bytes)
 * - Bytes 20-31: Nonce fragment (12 bytes)
 */

import { getAddress } from 'viem';
import { NonceCommand, ParsedNonce, ValidationResult } from './types';

// Maximum value for 11-byte nonce fragment (2^88 - 1)
const MAX_NONCE_FRAGMENT = (BigInt(1) << BigInt(88)) - BigInt(1);

/**
 * Construct a HybridAllocator nonce from its components
 *
 * @param command - The nonce command type (ON_CHAIN, OFF_CHAIN, or PERMIT2)
 * @param sponsor - The sponsor address (20 bytes)
 * @param fragment - The nonce fragment (11 bytes, max value 2^88 - 1)
 * @returns The constructed 32-byte nonce as a bigint
 */
export function constructHybridNonce(
  command: NonceCommand,
  sponsor: string,
  fragment: bigint
): bigint {
  // Validate fragment fits in 11 bytes (88 bits)
  if (fragment < BigInt(0) || fragment > MAX_NONCE_FRAGMENT) {
    throw new Error(
      `Nonce fragment must be between 0 and ${MAX_NONCE_FRAGMENT.toString()}`
    );
  }

  // Normalize and validate sponsor address
  const normalizedSponsor = getAddress(sponsor);

  // Convert sponsor address to bigint (remove 0x prefix)
  const sponsorBigInt = BigInt(normalizedSponsor);

  // Construct the nonce:
  // - Command byte is at position 31 (most significant byte when viewed as big-endian)
  // - Sponsor is at positions 11-30 (20 bytes)
  // - Fragment is at positions 0-10 (11 bytes, least significant)
  const commandPart = BigInt(command) << BigInt(248); // Shift to byte 31
  const sponsorPart = sponsorBigInt << BigInt(88); // Shift to bytes 11-30
  const fragmentPart = fragment; // Bytes 0-10

  return commandPart | sponsorPart | fragmentPart;
}

/**
 * Parse a HybridAllocator nonce into its components
 *
 * @param nonce - The 32-byte nonce as a bigint
 * @returns The parsed nonce components
 */
export function parseHybridNonce(nonce: bigint): ParsedNonce {
  // Extract command byte (byte 31, most significant)
  const commandByte = Number((nonce >> BigInt(248)) & BigInt(0xff));

  // Validate command byte
  if (
    commandByte !== NonceCommand.ON_CHAIN &&
    commandByte !== NonceCommand.OFF_CHAIN &&
    commandByte !== NonceCommand.PERMIT2
  ) {
    throw new Error(
      `Invalid nonce command byte: 0x${commandByte.toString(16)}`
    );
  }

  // Extract sponsor address (bytes 11-30, 20 bytes)
  const sponsorBigInt =
    (nonce >> BigInt(88)) & ((BigInt(1) << BigInt(160)) - BigInt(1));
  const sponsor = getAddress(
    `0x${sponsorBigInt.toString(16).padStart(40, '0')}`
  );

  // Extract fragment (bytes 0-10, 11 bytes)
  const fragment = nonce & MAX_NONCE_FRAGMENT;

  return {
    command: commandByte as NonceCommand,
    sponsor,
    fragment,
  };
}

/**
 * Check if a nonce has the correct command type for off-chain allocation
 *
 * @param nonce - The nonce to check
 * @returns True if the nonce has OFF_CHAIN command type
 */
export function isOffChainNonce(nonce: bigint): boolean {
  const commandByte = Number((nonce >> BigInt(248)) & BigInt(0xff));
  return commandByte === NonceCommand.OFF_CHAIN;
}

/**
 * Check if a nonce has the correct command type for on-chain allocation
 *
 * @param nonce - The nonce to check
 * @returns True if the nonce has ON_CHAIN command type
 */
export function isOnChainNonce(nonce: bigint): boolean {
  const commandByte = Number((nonce >> BigInt(248)) & BigInt(0xff));
  return commandByte === NonceCommand.ON_CHAIN;
}

/**
 * Check if a nonce has the correct command type for Permit2 allocation
 *
 * @param nonce - The nonce to check
 * @returns True if the nonce has PERMIT2 command type
 */
export function isPermit2Nonce(nonce: bigint): boolean {
  const commandByte = Number((nonce >> BigInt(248)) & BigInt(0xff));
  return commandByte === NonceCommand.PERMIT2;
}

/**
 * Validate that a hybrid nonce is correctly structured and matches the sponsor
 *
 * @param nonce - The nonce to validate
 * @param expectedSponsor - The expected sponsor address
 * @param expectedCommand - Optional: The expected command type (defaults to OFF_CHAIN for allocator-signed)
 * @returns Validation result
 */
export function validateHybridNonce(
  nonce: bigint,
  expectedSponsor: string,
  expectedCommand?: NonceCommand
): ValidationResult {
  try {
    const parsed = parseHybridNonce(nonce);

    // Check sponsor matches
    const normalizedExpected = getAddress(expectedSponsor).toLowerCase();
    const normalizedParsed = parsed.sponsor.toLowerCase();

    if (normalizedExpected !== normalizedParsed) {
      return {
        isValid: false,
        error: `Nonce sponsor mismatch: expected ${normalizedExpected}, got ${normalizedParsed}`,
      };
    }

    // If expected command is specified, check it matches
    if (expectedCommand !== undefined && parsed.command !== expectedCommand) {
      const commandNames = {
        [NonceCommand.ON_CHAIN]: 'ON_CHAIN (0x01)',
        [NonceCommand.OFF_CHAIN]: 'OFF_CHAIN (0x02)',
        [NonceCommand.PERMIT2]: 'PERMIT2 (0x03)',
      };
      return {
        isValid: false,
        error: `Nonce command mismatch: expected ${commandNames[expectedCommand]}, got ${commandNames[parsed.command]}`,
      };
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Invalid nonce format: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Convert a hybrid nonce to a hex string
 *
 * @param nonce - The nonce as a bigint
 * @returns The nonce as a 0x-prefixed hex string (64 chars + 0x = 66 chars)
 */
export function hybridNonceToHex(nonce: bigint): `0x${string}` {
  return `0x${nonce.toString(16).padStart(64, '0')}` as `0x${string}`;
}

/**
 * Parse a hex string to a hybrid nonce
 *
 * @param hex - The hex string (with or without 0x prefix)
 * @returns The nonce as a bigint
 */
export function hexToHybridNonce(hex: string): bigint {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + cleanHex);
}
