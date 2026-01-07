import { getAddress, hexToBytes } from 'viem/utils';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';
import { ValidationResult, NonceCommand } from './types';
import { isNonceConsumedOnChain } from '../graphql';
import { parseHybridNonce, constructHybridNonce } from './hybrid-nonce';

// Helper to convert address to bytea
function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address as `0x${string}`);
}

/**
 * Generate a hybrid nonce for the new format.
 *
 * Hybrid Nonce Structure (32 bytes):
 * - Byte 0: Command (0x01=on-chain, 0x02=off-chain, 0x03=permit2)
 * - Bytes 1-20: Sponsor address (20 bytes)
 * - Bytes 21-31: Freely chosen nonce fragment (11 bytes)
 *
 * @param sponsor - The sponsor's address
 * @param chainId - The chain ID
 * @param db - Database connection
 * @param command - The nonce command type (defaults to OFF_CHAIN for allocator-signed)
 * @param allocatorAddress - Optional allocator address for on-chain consumption checks
 * @returns The generated hybrid nonce as a bigint
 */
export async function generateNonce(
  sponsor: string,
  chainId: string,
  db: PGlite,
  allocatorAddress?: string,
  command: NonceCommand = NonceCommand.OFF_CHAIN
): Promise<bigint> {
  const normalizedSponsor = getAddress(sponsor);
  const sponsorBytes = Buffer.from(
    normalizedSponsor.toLowerCase().slice(2),
    'hex'
  );

  // Query for the highest nonce fragment used by this sponsor on this chain
  const result = await db.query<{ max_low: number | null }>(
    `SELECT MAX(nonce_low) as max_low
     FROM nonces
     WHERE chain_id = $1 AND sponsor = $2`,
    [chainId, sponsorBytes]
  );

  // Generate next fragment (start from 1 if none exists)
  const nextFragment = BigInt((result.rows[0]?.max_low ?? 0) + 1);

  // Construct hybrid nonce with the specified command
  const generatedNonce = constructHybridNonce(
    command,
    normalizedSponsor,
    nextFragment
  );

  // If allocator address is provided, check if the nonce is consumed on-chain
  if (allocatorAddress) {
    const isConsumedOnChain = await isNonceConsumedOnChain(
      allocatorAddress,
      chainId,
      generatedNonce.toString()
    );

    // If consumed on-chain but not in local DB, recursively try the next nonce
    if (isConsumedOnChain) {
      // Store the nonce as used in local DB to sync state
      await storeNonce(generatedNonce, chainId, db);
      // Try generating the next nonce
      return generateNonce(sponsor, chainId, db, allocatorAddress, command);
    }
  }

  return generatedNonce;
}

/**
 * Validate a hybrid nonce.
 *
 * Hybrid Nonce Structure (32 bytes):
 * - Byte 0: Command (0x01=on-chain, 0x02=off-chain, 0x03=permit2)
 * - Bytes 1-20: Sponsor address (20 bytes)
 * - Bytes 21-31: Freely chosen nonce fragment (11 bytes)
 *
 * @param nonce - The nonce to validate
 * @param sponsor - Expected sponsor address
 * @param chainId - The chain ID
 * @param db - Database connection
 * @param allocatorAddress - Optional allocator address for on-chain consumption checks
 * @param expectedCommand - Optional expected command type for validation
 * @returns Validation result
 */
export async function validateNonce(
  nonce: bigint,
  sponsor: string,
  chainId: string,
  db: PGlite,
  allocatorAddress?: string,
  expectedCommand?: NonceCommand
): Promise<ValidationResult> {
  try {
    // Parse the hybrid nonce to extract components
    let parsed;
    try {
      parsed = parseHybridNonce(nonce);
    } catch (error) {
      return {
        isValid: false,
        error: `Invalid hybrid nonce format: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Validate command byte
    if (
      parsed.command !== NonceCommand.ON_CHAIN &&
      parsed.command !== NonceCommand.OFF_CHAIN &&
      parsed.command !== NonceCommand.PERMIT2
    ) {
      return {
        isValid: false,
        error: `Invalid nonce command byte: 0x${(parsed.command as number).toString(16).padStart(2, '0')}`,
      };
    }

    // If expected command is specified, check it matches
    if (expectedCommand !== undefined && parsed.command !== expectedCommand) {
      const commandNames: Record<number, string> = {
        [NonceCommand.ON_CHAIN]: 'ON_CHAIN (0x01)',
        [NonceCommand.OFF_CHAIN]: 'OFF_CHAIN (0x02)',
        [NonceCommand.PERMIT2]: 'PERMIT2 (0x03)',
      };
      return {
        isValid: false,
        error: `Nonce command mismatch: expected ${commandNames[expectedCommand]}, got ${commandNames[parsed.command]}`,
      };
    }

    // Check that the sponsor part matches the sponsor's address (both lowercase)
    const normalizedExpected = getAddress(sponsor).toLowerCase();
    const normalizedParsed = parsed.sponsor.toLowerCase();

    if (normalizedExpected !== normalizedParsed) {
      return {
        isValid: false,
        error: 'Nonce does not match sponsor address',
      };
    }

    // Convert fragment to nonce_low for database lookup
    // The fragment is 11 bytes (88 bits), we store the lower 32 bits as nonce_low
    const nonceLowUnsigned = parsed.fragment & BigInt(0xffffffff);
    const nonceHighUnsigned = parsed.fragment >> BigInt(32);

    // Convert unsigned values to signed for PostgreSQL storage
    const nonceLow =
      nonceLowUnsigned >= BigInt(0x80000000)
        ? Number(nonceLowUnsigned - BigInt(0x100000000))
        : Number(nonceLowUnsigned);

    const nonceHigh =
      nonceHighUnsigned >= BigInt('0x8000000000000000')
        ? Number(nonceHighUnsigned - BigInt('0x10000000000000000'))
        : Number(nonceHighUnsigned);

    // Check if nonce has been used before in this domain
    const result = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM nonces WHERE chain_id = $1 AND sponsor = $2 AND nonce_high = $3 AND nonce_low = $4',
      [chainId, addressToBytes(sponsor), nonceHigh, nonceLow]
    );

    if (result.rows[0].count > 0) {
      return {
        isValid: false,
        error: 'Nonce has already been used (local)',
      };
    }

    // If allocator address is provided, also check if nonce is consumed on-chain
    if (allocatorAddress) {
      const isConsumedOnChain = await isNonceConsumedOnChain(
        allocatorAddress,
        chainId,
        nonce.toString()
      );

      if (isConsumedOnChain) {
        // Sync local database with on-chain state
        await storeNonce(nonce, chainId, db);

        return {
          isValid: false,
          error: 'Nonce has already been consumed on-chain',
        };
      }
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Nonce validation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Store a hybrid nonce in the database.
 *
 * @param nonce - The hybrid nonce to store
 * @param chainId - The chain ID
 * @param db - Database connection
 */
export async function storeNonce(
  nonce: bigint,
  chainId: string,
  db: PGlite
): Promise<void> {
  // Parse the hybrid nonce to extract components
  const parsed = parseHybridNonce(nonce);

  // Convert sponsor to bytes
  const sponsorBytes = addressToBytes(parsed.sponsor);

  // Convert fragment to nonce_high and nonce_low for database storage
  const nonceLowUnsigned = parsed.fragment & BigInt(0xffffffff);
  const nonceHighUnsigned = parsed.fragment >> BigInt(32);

  // Convert unsigned values to signed for PostgreSQL storage
  const nonceLow =
    nonceLowUnsigned >= BigInt(0x80000000)
      ? Number(nonceLowUnsigned - BigInt(0x100000000))
      : Number(nonceLowUnsigned);

  const nonceHigh =
    nonceHighUnsigned >= BigInt('0x8000000000000000')
      ? Number(nonceHighUnsigned - BigInt('0x10000000000000000'))
      : Number(nonceHighUnsigned);

  // Determine nonce_command value (or null if not a valid command)
  const nonceCommand =
    parsed.command === NonceCommand.ON_CHAIN ||
    parsed.command === NonceCommand.OFF_CHAIN ||
    parsed.command === NonceCommand.PERMIT2
      ? parsed.command
      : null;

  // Lock the nonces table for this sponsor and chain before inserting
  await db.query(
    'SELECT 1 FROM nonces WHERE chain_id = $1 AND sponsor = $2 FOR UPDATE',
    [chainId, sponsorBytes]
  );

  await db.query(
    'INSERT INTO nonces (id, chain_id, sponsor, nonce_high, nonce_low, nonce_command) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chain_id, sponsor, nonce_high, nonce_low) DO NOTHING',
    [randomUUID(), chainId, sponsorBytes, nonceHigh, nonceLow, nonceCommand]
  );
}
