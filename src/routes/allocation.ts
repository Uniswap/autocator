import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  type Hex,
  recoverAddress,
  parseCompactSignature,
  compactSignatureToSignature,
  serializeSignature,
  getAddress,
  hexToBytes,
  numberToHex,
} from 'viem';
import {
  validateBatchCompact,
  validateArbiter,
  validateHybridNonce,
  constructHybridNonce,
  NonceCommand,
  type BatchCompactMessage,
  type ValidatedBatchCompactMessage,
  type Lock,
} from '../validation';
import { ensureIndexersHealthy, getHybridAllocation } from '../graphql';
import {
  generateBatchClaimHash,
  signBatchCompact,
  generateDomainHash,
  generateDigest,
} from '../crypto';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

// ============================================================
// Types
// ============================================================

/**
 * Request Type 1: Standard (Signed BatchCompact) - Full Off-chain Allocation
 * Sponsor has already deposited tokens, signs a BatchCompact, requests full off-chain allocation
 */
interface StandardAllocationRequest {
  type: 'standard';
  chainId: string;
  compact: BatchCompactMessage;
  sponsorSignature: Hex;
}

/**
 * Request Type 2: Permit2-based (Pre-execution Hybrid)
 * Sponsor deposits tokens AND registers a compact in a single Permit2 transaction
 * If compact commits more than deposited, additional off-chain allocation is needed
 */
interface Permit2AllocationRequest {
  type: 'permit2';
  chainId: string;
  permit2Message: unknown; // Full Permit2 message with embedded compact witness
  signature: Hex;
  compact: BatchCompactMessage; // The compact pre-image for verification
}

/**
 * Request Type 3: Transaction-based (Post-execution Hybrid)
 * Sponsor has already executed a deposit+register transaction
 * Submit the tx hash to get any additional allocation
 */
interface TransactionAllocationRequest {
  type: 'transaction';
  chainId: string;
  transactionHash: Hex;
  compact: BatchCompactMessage; // The compact pre-image for verification
}

// Union type for all allocation request types
type AllocationRequest =
  | StandardAllocationRequest
  | Permit2AllocationRequest
  | TransactionAllocationRequest;

// Response for allocation endpoint
interface AllocationResponse {
  claimHash: Hex;
  // For standard: this is the full allocation signature
  // For permit2/tx: this is only for amounts exceeding deposit (null if fully covered)
  allocation: {
    commitments: Lock[];
    nonce: Hex;
    signature: Hex;
  } | null;
  message: string;
}

// ============================================================
// Helper Functions
// ============================================================

// Helper to convert hex string to buffer
function hexToBuffer(hex: string): Uint8Array {
  return hexToBytes((hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`);
}

// Helper to convert address to bytes
function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address as `0x${string}`);
}

/**
 * Verify sponsor signature on a BatchCompact
 */
async function verifySponsorSignature(
  compact: ValidatedBatchCompactMessage,
  chainId: string,
  sponsorSignature: Hex,
  expectedSponsor: string
): Promise<boolean> {
  try {
    // Generate claim hash
    const claimHash = await generateBatchClaimHash(compact);

    // Generate domain hash for the specific chain
    const domainHash = generateDomainHash(BigInt(chainId));

    // Generate the digest that was signed
    const digest = generateDigest(claimHash, domainHash);

    // Convert compact signature to full signature for recovery
    const parsedCompactSig = parseCompactSignature(sponsorSignature);
    const signature = compactSignatureToSignature(parsedCompactSig);
    const fullSignature = serializeSignature(signature);

    // Recover the signer address
    const recoveredAddress = await recoverAddress({
      hash: digest,
      signature: fullSignature,
    });

    // Check if the recovered address matches the sponsor
    return (
      recoveredAddress.toLowerCase() ===
      getAddress(expectedSponsor).toLowerCase()
    );
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('Signature verification failed:', error);
    }
    return false;
  }
}

/**
 * Store the allocation in the database
 */
async function storeAllocation(
  db: PGlite,
  compact: ValidatedBatchCompactMessage,
  chainId: string,
  claimHash: Hex,
  signature: Hex
): Promise<void> {
  const compactId = randomUUID();
  const elementId = randomUUID();

  // Convert nonce to hex string preserving all 32 bytes
  const nonceHex = compact.nonce.toString(16).padStart(64, '0');
  const nonceBytes = hexToBuffer(nonceHex);

  // Start transaction
  await db.query('BEGIN');

  try {
    // Insert into compacts table (compact_type = 1 for BatchCompact)
    await db.query(
      `INSERT INTO compacts (
        id,
        chain_id,
        claim_hash,
        compact_type,
        sponsor,
        nonce,
        expires,
        signature,
        witness_type_string,
        witness_hash,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
      [
        compactId,
        chainId,
        hexToBuffer(claimHash),
        1, // BatchCompact
        addressToBytes(compact.sponsor),
        nonceBytes,
        compact.expires.toString(),
        hexToBuffer(signature),
        compact.witnessTypeString,
        compact.witnessHash ? hexToBuffer(compact.witnessHash) : null,
      ]
    );

    // Insert element for this BatchCompact
    await db.query(
      `INSERT INTO compact_elements (
        id,
        compact_id,
        element_index,
        arbiter,
        chain_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        elementId,
        compactId,
        0, // Single element for BatchCompact
        addressToBytes(compact.arbiter),
        chainId,
      ]
    );

    // Insert commitments
    for (const commitment of compact.commitments) {
      const commitmentId = randomUUID();
      // Convert lockTag to proper format (12 bytes)
      const lockTagHex = commitment.lockTag.startsWith('0x')
        ? commitment.lockTag.slice(2)
        : commitment.lockTag;
      const lockTagBytes = hexToBuffer(lockTagHex.padStart(24, '0'));

      await db.query(
        `INSERT INTO compact_commitments (
          id,
          element_id,
          lock_tag,
          token,
          amount,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          commitmentId,
          elementId,
          lockTagBytes,
          addressToBytes(commitment.token),
          hexToBuffer(numberToHex(BigInt(commitment.amount), { size: 32 })),
        ]
      );
    }

    // Store the nonce as used
    const nonceHigh = compact.nonce >> BigInt(32);
    const nonceLow = Number(compact.nonce & BigInt(0xffffffff));

    // Extract command from nonce for nonce_command column
    const nonceCommand = Number((compact.nonce >> BigInt(248)) & BigInt(0xff));

    await db.query(
      `INSERT INTO nonces (
        id,
        chain_id,
        sponsor,
        nonce_high,
        nonce_low,
        nonce_command,
        consumed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (chain_id, sponsor, nonce_high, nonce_low) DO NOTHING`,
      [
        randomUUID(),
        chainId,
        addressToBytes(compact.sponsor),
        nonceHigh.toString(),
        nonceLow,
        nonceCommand > 0 && nonceCommand <= 3 ? nonceCommand : null,
      ]
    );

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

// ============================================================
// Request Handlers
// ============================================================

/**
 * Handle standard (signed BatchCompact) allocation request
 */
async function handleStandardAllocation(
  request: StandardAllocationRequest,
  db: PGlite
): Promise<AllocationResponse> {
  const { chainId, compact, sponsorSignature } = request;

  // Validate arbiter
  const arbiterValidation = validateArbiter(compact.arbiter);
  if (!arbiterValidation.isValid) {
    throw new Error(arbiterValidation.error || 'Invalid arbiter');
  }

  // Validate the BatchCompact structure and allocation
  const validationResult = await validateBatchCompact(compact, chainId, db);
  if (!validationResult.isValid || !validationResult.validatedCompact) {
    throw new Error(validationResult.error || 'Invalid BatchCompact');
  }

  const validatedCompact =
    validationResult.validatedCompact as ValidatedBatchCompactMessage;

  // Validate hybrid nonce structure (must be OFF_CHAIN command for standard allocation)
  const nonceValidation = validateHybridNonce(
    validatedCompact.nonce,
    validatedCompact.sponsor,
    NonceCommand.OFF_CHAIN
  );
  if (!nonceValidation.isValid) {
    throw new Error(nonceValidation.error || 'Invalid nonce structure');
  }

  // Verify sponsor signature
  const isSignatureValid = await verifySponsorSignature(
    validatedCompact,
    chainId,
    sponsorSignature,
    compact.sponsor
  );
  if (!isSignatureValid) {
    throw new Error('Invalid sponsor signature');
  }

  // Generate claim hash and sign
  const { hash: claimHash, signature: signaturePromise } =
    await signBatchCompact(validatedCompact, BigInt(chainId));
  const signature = await signaturePromise;

  // Store the allocation
  await storeAllocation(db, validatedCompact, chainId, claimHash, signature);

  return {
    claimHash,
    allocation: {
      commitments: validatedCompact.commitments.map((c) => ({
        lockTag: c.lockTag,
        token: c.token,
        amount: c.amount,
      })),
      nonce:
        `0x${validatedCompact.nonce.toString(16).padStart(64, '0')}` as Hex,
      signature,
    },
    message: 'Off-chain allocation successful',
  };
}

/**
 * Handle Permit2-based allocation request
 * TODO: Implement full Permit2 verification
 */
async function handlePermit2Allocation(
  _request: Permit2AllocationRequest,
  _db: PGlite
): Promise<AllocationResponse> {
  // For now, throw not implemented
  throw new Error(
    'Permit2-based allocation not yet implemented. ' +
      'Use type "standard" for full off-chain allocation.'
  );
}

/**
 * Handle transaction-based allocation request
 * TODO: Implement transaction lookup and verification
 */
async function handleTransactionAllocation(
  _request: TransactionAllocationRequest,
  _db: PGlite
): Promise<AllocationResponse> {
  // For now, throw not implemented
  throw new Error(
    'Transaction-based allocation not yet implemented. ' +
      'Use type "standard" for full off-chain allocation.'
  );
}

// ============================================================
// Route Setup
// ============================================================

export async function setupAllocationRoutes(
  server: FastifyInstance
): Promise<void> {
  /**
   * POST /allocation
   *
   * Unified allocation endpoint supporting three request types:
   * 1. Standard (signed BatchCompact) - Full off-chain allocation
   * 2. Permit2 - Pre-execution hybrid allocation
   * 3. Transaction - Post-execution hybrid allocation
   */
  server.post<{
    Body: AllocationRequest;
  }>(
    '/allocation',
    async (
      request: FastifyRequest<{ Body: AllocationRequest }>,
      reply: FastifyReply
    ) => {
      try {
        // Fail-closed: Ensure both indexers are healthy before processing
        await ensureIndexersHealthy();

        const allocationRequest = request.body;

        // Validate request type
        if (!allocationRequest.type) {
          reply.code(400);
          return {
            error:
              'Request type is required (standard, permit2, or transaction)',
          };
        }

        let result: AllocationResponse;

        switch (allocationRequest.type) {
          case 'standard':
            result = await handleStandardAllocation(
              allocationRequest as StandardAllocationRequest,
              server.db
            );
            break;

          case 'permit2':
            result = await handlePermit2Allocation(
              allocationRequest as Permit2AllocationRequest,
              server.db
            );
            break;

          case 'transaction':
            result = await handleTransactionAllocation(
              allocationRequest as TransactionAllocationRequest,
              server.db
            );
            break;

          default:
            reply.code(400);
            return {
              error: `Unknown request type. Valid types: standard, permit2, transaction`,
            };
        }

        return result;
      } catch (error) {
        // Handle specific error types
        if (
          error instanceof Error &&
          error.message.includes('Service temporarily unavailable')
        ) {
          reply.code(503);
          return { error: error.message };
        }

        if (
          error instanceof Error &&
          error.message.includes('not yet implemented')
        ) {
          reply.code(501);
          return { error: error.message };
        }

        if (
          error instanceof Error &&
          (error.message.includes('Invalid') ||
            error.message.includes('Insufficient'))
        ) {
          reply.code(400);
          return { error: error.message };
        }

        reply.code(500);
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to process allocation request',
        };
      }
    }
  );

  /**
   * GET /allocation/:chainId/:claimHash
   *
   * Check if an allocation exists for a given claim hash
   */
  server.get<{
    Params: { chainId: string; claimHash: string };
  }>(
    '/allocation/:chainId/:claimHash',
    async (
      request: FastifyRequest<{
        Params: { chainId: string; claimHash: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { chainId, claimHash } = request.params;

        // Check hybrid allocator indexer for this allocation
        const hybridAllocation = await getHybridAllocation(claimHash, chainId);

        if (hybridAllocation) {
          return {
            exists: true,
            source: 'hybrid-allocator',
            allocation: {
              claimHash: hybridAllocation.claimHash,
              sponsor: hybridAllocation.sponsorAddress,
              nonce: hybridAllocation.nonce,
              expires: hybridAllocation.expires,
              commitments: JSON.parse(hybridAllocation.commitments),
              timestamp: hybridAllocation.timestamp,
            },
          };
        }

        // Check local database
        const localResult = await server.db.query<{
          claim_hash: Uint8Array;
          sponsor: Uint8Array;
          nonce: Uint8Array;
          expires: string;
          created_at: string;
        }>(
          `SELECT claim_hash, sponsor, nonce, expires, created_at
           FROM compacts
           WHERE chain_id = $1 AND claim_hash = $2`,
          [chainId, hexToBuffer(claimHash)]
        );

        if (localResult.rows.length > 0) {
          const row = localResult.rows[0];
          return {
            exists: true,
            source: 'local',
            allocation: {
              claimHash,
              sponsor: getAddress(
                '0x' + Buffer.from(row.sponsor).toString('hex')
              ),
              nonce: '0x' + Buffer.from(row.nonce).toString('hex'),
              expires: row.expires,
              timestamp: row.created_at,
            },
          };
        }

        reply.code(404);
        return { exists: false, error: 'Allocation not found' };
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to check allocation',
        };
      }
    }
  );

  /**
   * POST /allocation/suggested-nonce
   *
   * Generate a suggested hybrid nonce for off-chain allocation
   */
  server.post<{
    Body: { chainId: string; sponsor: string };
  }>(
    '/allocation/suggested-nonce',
    async (
      request: FastifyRequest<{
        Body: { chainId: string; sponsor: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { chainId, sponsor } = request.body;

        if (!chainId || !sponsor) {
          reply.code(400);
          return { error: 'chainId and sponsor are required' };
        }

        // Normalize sponsor address
        const normalizedSponsor = getAddress(sponsor);

        // Get the highest nonce fragment used by this sponsor on this chain
        const result = await server.db.query<{ max_low: number | null }>(
          `SELECT MAX(nonce_low) as max_low
           FROM nonces
           WHERE chain_id = $1 AND sponsor = $2`,
          [chainId, addressToBytes(normalizedSponsor)]
        );

        // Generate next fragment (start from 1 if none exists)
        const nextFragment = BigInt((result.rows[0]?.max_low ?? 0) + 1);

        // Construct hybrid nonce with OFF_CHAIN command
        const nonce = constructHybridNonce(
          NonceCommand.OFF_CHAIN,
          normalizedSponsor,
          nextFragment
        );

        return {
          nonce: `0x${nonce.toString(16).padStart(64, '0')}`,
          command: 'OFF_CHAIN',
          sponsor: normalizedSponsor,
          fragment: nextFragment.toString(),
        };
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to generate suggested nonce',
        };
      }
    }
  );
}
