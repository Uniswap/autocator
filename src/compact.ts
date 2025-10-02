import type { FastifyInstance } from 'fastify';
import './types/database.d.ts';
import {
  type Hex,
  recoverAddress,
  parseCompactSignature,
  compactSignatureToSignature,
  serializeSignature,
} from 'viem';
import { getAddress, hexToBytes, toHex, numberToHex } from 'viem/utils';
import {
  validateCompact,
  type CompactMessage,
  type ValidatedCompactMessage,
  storeNonce,
  checkOnchainRegistration,
  OnchainRegistrationStatus,
} from './validation';
import {
  signCompact,
  generateClaimHash,
  generateDomainHash,
  generateDigest,
} from './crypto';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

export interface CompactSubmission {
  chainId: string;
  compact: CompactMessage;
}

// Separate interface for stored compacts where nonce is always present
export interface StoredCompactMessage {
  id: bigint;
  arbiter: string;
  sponsor: string;
  nonce: bigint; // This is non-null
  expires: bigint;
  amount: string;
  witnessTypeString: string | null;
  witnessHash: string | null;
}

export interface CompactRecord {
  chainId: string;
  compact: StoredCompactMessage;
  hash: string;
  signature: string;
  createdAt: string;
}

// Helper to convert address to bytea
function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address as `0x${string}`);
}

// Helper to convert bytea to checksummed address
function byteaToAddress(bytes: Uint8Array): string {
  return getAddress('0x' + Buffer.from(bytes).toString('hex'));
}

// Helper to convert hex string to bytea
function hexToBuffer(hex: string): Uint8Array {
  return hexToBytes((hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`);
}

// Helper to convert bytea to hex string
function bufferToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

// Helper to convert BigInt amount to 32-byte array
function amountToBytes(amount: string | bigint): Uint8Array {
  const amountBigInt = typeof amount === 'string' ? BigInt(amount) : amount;
  const hex = numberToHex(amountBigInt, { size: 32 });
  return hexToBytes(hex);
}

// Helper to convert 32-byte array to amount string
function bytesToAmount(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return BigInt(hex).toString();
}

// Helper to convert ValidatedCompactMessage to StoredCompactMessage
function toStoredCompact(
  compact: ValidatedCompactMessage
): StoredCompactMessage {
  return {
    id: compact.id,
    arbiter: compact.arbiter,
    sponsor: compact.sponsor,
    nonce: compact.nonce,
    expires: compact.expires,
    amount: compact.amount,
    witnessTypeString: compact.witnessTypeString,
    witnessHash: compact.witnessHash,
  };
}

export async function submitCompact(
  server: FastifyInstance,
  submission: CompactSubmission,
  sponsorAddress: string,
  sponsorSignature: string
): Promise<{ hash: string; signature: string; nonce: string }> {
  try {
    // Start a transaction
    await server.db.query('BEGIN');

    // Validate sponsor address format
    const normalizedSponsorAddress = getAddress(sponsorAddress);

    // Validate sponsor matches the compact
    if (getAddress(submission.compact.sponsor) !== normalizedSponsorAddress) {
      throw new Error('Sponsor address does not match compact');
    }

    // Ensure nonce is provided
    if (submission.compact.nonce === null) {
      throw new Error(
        'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.'
      );
    }

    // Validate the compact (including nonce validation)
    const validationResult = await validateCompact(
      submission.compact,
      submission.chainId,
      server.db
    );
    if (!validationResult.isValid || !validationResult.validatedCompact) {
      throw new Error(validationResult.error || 'Invalid compact');
    }

    // Get the validated compact with proper types
    const validatedCompact = validationResult.validatedCompact;

    // Convert to StoredCompactMessage for crypto operations
    const storedCompact = toStoredCompact(validatedCompact);

    // Verify sponsor signature
    let isSignatureValid = false;
    let isOnchainRegistration = false;

    if (sponsorSignature && sponsorSignature.startsWith('0x')) {
      try {
        // Generate claim hash
        const claimHash = await generateClaimHash(storedCompact);

        // Generate domain hash for the specific chain
        const domainHash = generateDomainHash(BigInt(submission.chainId));

        // Generate the digest that was signed
        const digest = generateDigest(claimHash, domainHash);

        // Convert compact signature to full signature for recovery
        const parsedCompactSig = parseCompactSignature(
          sponsorSignature as `0x${string}`
        );
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover the signer address
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });

        // Check if the recovered address matches the sponsor
        isSignatureValid =
          recoveredAddress.toLowerCase() ===
          normalizedSponsorAddress.toLowerCase();
      } catch (error) {
        // Only log errors in non-test environments
        if (process.env.NODE_ENV !== 'test') {
          if (error instanceof Error) {
            // Log a simplified error message
            console.error(
              'Signature verification failed:',
              error.name === 'Error'
                ? error.message
                : `${error.name}: ${error.message}`
            );
          } else {
            console.error(
              'Signature verification failed with unknown error type'
            );
          }
        }

        // Set signature as invalid and continue to onchain verification
        isSignatureValid = false;
      }
    }

    // If signature is invalid or missing, check for onchain registration
    if (!isSignatureValid) {
      // Generate claim hash for onchain registration check
      const claimHash = await generateClaimHash(storedCompact);

      // Check if the compact is registered onchain
      const onchainResult = await checkOnchainRegistration(
        claimHash,
        submission.chainId
      );

      // Only consider the compact valid if it's in ACTIVE state
      if (onchainResult.status === OnchainRegistrationStatus.ACTIVE) {
        // Verify that the sponsor address matches
        if (
          onchainResult.registeredCompact &&
          onchainResult.registeredCompact.sponsor.address.toLowerCase() ===
            normalizedSponsorAddress.toLowerCase()
        ) {
          isOnchainRegistration = true;
        } else {
          throw new Error(
            'Onchain registration sponsor does not match the provided sponsor'
          );
        }
      } else {
        // Provide detailed error message based on the status
        switch (onchainResult.status) {
          case OnchainRegistrationStatus.NOT_FOUND:
            throw new Error(
              'Invalid sponsor signature and compact not found onchain'
            );
          case OnchainRegistrationStatus.PENDING:
            throw new Error(
              `Onchain registration is pending finalization (${onchainResult.timeUntilFinalized} seconds remaining)`
            );
          case OnchainRegistrationStatus.EXPIRED:
            throw new Error('Onchain registration has expired');
          case OnchainRegistrationStatus.CLAIM_PENDING:
            throw new Error(
              `Onchain registration has a pending claim (${onchainResult.timeUntilClaimFinalized} seconds remaining)`
            );
          case OnchainRegistrationStatus.CLAIMED:
            throw new Error('Onchain registration has been claimed');
          default:
            throw new Error(
              `Invalid sponsor signature and onchain registration status: ${onchainResult.status}`
            );
        }
      }
    }

    // If neither signature is valid nor onchain registration is active, reject
    if (!isSignatureValid && !isOnchainRegistration) {
      throw new Error(
        'Invalid sponsor signature and no valid onchain registration found'
      );
    }

    // Sign the compact and get claim hash
    const { hash, signature: signaturePromise } = await signCompact(
      storedCompact,
      BigInt(submission.chainId)
    );
    const signature = await signaturePromise;

    // Store the compact first
    await storeCompact(
      server.db,
      storedCompact,
      submission.chainId,
      hash,
      signature
    );

    // Store the nonce as used (within the same transaction)
    await storeNonce(storedCompact.nonce, submission.chainId, server.db);

    // Commit the transaction
    await server.db.query('COMMIT');

    return {
      hash,
      signature,
      nonce: '0x' + storedCompact.nonce.toString(16).padStart(64, '0'),
    };
  } catch (error) {
    // Rollback on any error
    await server.db.query('ROLLBACK');
    throw error;
  }
}

export async function getCompactsByAddress(
  server: FastifyInstance,
  address: string
): Promise<CompactRecord[]> {
  const result = await server.db.query<{
    chainId: string;
    arbiter: Uint8Array;
    sponsor: Uint8Array;
    nonce: Uint8Array;
    expires: string;
    amount: Uint8Array;
    lock_id: Uint8Array;
    hash: Uint8Array;
    signature: Uint8Array;
    createdAt: string;
  }>(
    `SELECT 
      chain_id as "chainId",
      arbiter,
      sponsor,
      nonce,
      expires,
      amount,
      lock_id,
      claim_hash as hash,
      signature,
      created_at as "createdAt"
    FROM compacts 
    WHERE sponsor = $1 
    ORDER BY created_at DESC`,
    [addressToBytes(address)]
  );

  return result.rows.map((row) => ({
    chainId: row.chainId,
    compact: {
      id: BigInt(bufferToHex(row.lock_id)),
      arbiter: byteaToAddress(row.arbiter),
      sponsor: byteaToAddress(row.sponsor),
      nonce: BigInt(bufferToHex(row.nonce)),
      expires: BigInt(row.expires),
      amount: bytesToAmount(row.amount),
      witnessTypeString: null,
      witnessHash: null,
    },
    hash: bufferToHex(row.hash),
    signature: bufferToHex(row.signature),
    createdAt: row.createdAt,
  }));
}

export async function getCompactByHash(
  server: FastifyInstance,
  chainId: string,
  claimHash: string
): Promise<CompactRecord | null> {
  const result = await server.db.query<{
    chainId: string;
    arbiter: Uint8Array;
    sponsor: Uint8Array;
    nonce: Uint8Array;
    expires: string;
    amount: Uint8Array;
    lock_id: Uint8Array;
    hash: Uint8Array;
    signature: Uint8Array;
    createdAt: string;
  }>(
    `SELECT 
      chain_id as "chainId",
      arbiter,
      sponsor,
      nonce,
      expires,
      amount,
      lock_id,
      claim_hash as hash,
      signature,
      created_at as "createdAt"
    FROM compacts 
    WHERE chain_id = $1 AND claim_hash = $2`,
    [chainId, hexToBuffer(claimHash)]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    chainId: row.chainId,
    compact: {
      id: BigInt(bufferToHex(row.lock_id)),
      arbiter: byteaToAddress(row.arbiter),
      sponsor: byteaToAddress(row.sponsor),
      nonce: BigInt(bufferToHex(row.nonce)),
      expires: BigInt(row.expires),
      amount: bytesToAmount(row.amount),
      witnessTypeString: null,
      witnessHash: null,
    },
    hash: bufferToHex(row.hash),
    signature: bufferToHex(row.signature),
    createdAt: row.createdAt,
  };
}

async function storeCompact(
  db: PGlite,
  compact: StoredCompactMessage,
  chainId: string,
  hash: Hex,
  signature: Hex
): Promise<void> {
  const id = randomUUID();

  // Convert nonce to hex string preserving all 32 bytes
  const nonceHex = compact.nonce.toString(16).padStart(64, '0');
  const nonceBytes = hexToBuffer(nonceHex);

  await db.query(
    `INSERT INTO compacts (
      id,
      chain_id,
      claim_hash,
      arbiter,
      sponsor,
      nonce,
      expires,
      lock_id,
      amount,
      signature,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
    [
      id,
      chainId,
      hexToBuffer(hash),
      addressToBytes(compact.arbiter),
      addressToBytes(compact.sponsor),
      nonceBytes,
      compact.expires.toString(),
      hexToBuffer(numberToHex(compact.id, { size: 32 })),
      amountToBytes(compact.amount),
      hexToBuffer(signature),
    ]
  );
}
