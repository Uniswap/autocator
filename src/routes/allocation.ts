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
  parseHybridNonce,
  constructHybridNonce,
  NonceCommand,
  type BatchCompactMessage,
  type ValidatedBatchCompactMessage,
  type Lock,
  type Permit2Message,
  type DepositCommitmentDelta,
} from '../validation';
import {
  ensureIndexersHealthy,
  getHybridAllocation,
  getFinalizedRegisteredCompact,
} from '../graphql';
import {
  generateBatchClaimHash,
  signBatchCompact,
  generateDomainHash,
  generateDigest,
  generateBatchClaimHashWithMandate,
  verifyPermit2Signature,
  signHybridAllocationContext,
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
  permit2Message: Permit2Message; // Full Permit2 message with embedded compact witness
  signature: Hex;
  mandateHash: Hex; // The mandate hash (bytes32) - used as witness hash in compact
  witnessTypeString: string; // The full witness type string for claim hash derivation
}

/**
 * Request Type 3: On-chain Registration-based Allocation
 * Sponsor has already registered a compact on-chain (via deposit+register transaction)
 * Submit the compact pre-image to get the full allocation signature
 *
 * The compact must be registered AND finalized (past the finalization threshold)
 * to protect against reorgs.
 */
interface OnChainAllocationRequest {
  type: 'onchain';
  chainId: string;
  compact: BatchCompactMessage; // The compact pre-image
  mandateHash: Hex; // The mandate hash used as witness hash
  witnessTypeString: string; // The witness type string for claim hash derivation
}

// Union type for all allocation request types
type AllocationRequest =
  | StandardAllocationRequest
  | Permit2AllocationRequest
  | OnChainAllocationRequest;

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

    // Parse the hybrid nonce to extract components
    const parsedNonce = parseHybridNonce(compact.nonce);

    // Split fragment into high/low parts for database storage
    // Fragment is 88 bits (11 bytes), we store lower 32 bits in nonce_low, rest in nonce_high
    const nonceLowUnsigned = parsedNonce.fragment & BigInt(0xffffffff);
    const nonceHighUnsigned = parsedNonce.fragment >> BigInt(32);

    // Convert unsigned values to signed for PostgreSQL storage
    const nonceLow =
      nonceLowUnsigned >= BigInt(0x80000000)
        ? Number(nonceLowUnsigned - BigInt(0x100000000))
        : Number(nonceLowUnsigned);

    const nonceHigh =
      nonceHighUnsigned >= BigInt('0x8000000000000000')
        ? Number(nonceHighUnsigned - BigInt('0x10000000000000000'))
        : Number(nonceHighUnsigned);

    // Use the command from the parsed nonce
    const nonceCommand = parsedNonce.command;

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

/**
 * Store a Permit2 allocation in the database
 *
 * This stores the full Permit2 message payload and allocation details
 * so that the allocation can be retrieved if the caller loses the response.
 */
async function storePermit2Allocation(
  db: PGlite,
  chainId: string,
  claimHash: Hex,
  sponsor: string,
  nonce: bigint,
  expires: bigint,
  mandateHash: Hex,
  witnessTypeString: string,
  permit2Message: Permit2Message,
  permit2Signature: Hex,
  allocationSignature: Hex | null,
  additionalCommitments: Lock[] | null
): Promise<void> {
  const allocationId = randomUUID();

  // Convert nonce to hex string preserving all 32 bytes
  const nonceHex = nonce.toString(16).padStart(64, '0');
  const nonceBytes = hexToBuffer(nonceHex);

  // Get depositLockTag from permit2Message
  const depositLockTagHex = permit2Message.depositLockTag.startsWith('0x')
    ? permit2Message.depositLockTag.slice(2)
    : permit2Message.depositLockTag;
  const depositLockTagBytes = hexToBuffer(depositLockTagHex.padStart(24, '0'));

  // Start transaction
  await db.query('BEGIN');

  try {
    // Insert into permit2_allocations table
    await db.query(
      `INSERT INTO permit2_allocations (
        id,
        chain_id,
        claim_hash,
        sponsor,
        nonce,
        expires,
        mandate_hash,
        witness_type_string,
        permit2_message,
        permit2_signature,
        deposit_lock_tag,
        allocation_signature,
        additional_commitments,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
      [
        allocationId,
        chainId,
        hexToBuffer(claimHash),
        addressToBytes(sponsor),
        nonceBytes,
        expires.toString(),
        hexToBuffer(mandateHash),
        witnessTypeString,
        JSON.stringify(permit2Message),
        hexToBuffer(permit2Signature),
        depositLockTagBytes,
        allocationSignature ? hexToBuffer(allocationSignature) : null,
        additionalCommitments ? JSON.stringify(additionalCommitments) : null,
      ]
    );

    // Also store the nonce to prevent reuse
    const parsedNonce = parseHybridNonce(nonce);

    // Split fragment into high/low parts for database storage
    const nonceLowUnsigned = parsedNonce.fragment & BigInt(0xffffffff);
    const nonceHighUnsigned = parsedNonce.fragment >> BigInt(32);

    // Convert unsigned values to signed for PostgreSQL storage
    const nonceLow =
      nonceLowUnsigned >= BigInt(0x80000000)
        ? Number(nonceLowUnsigned - BigInt(0x100000000))
        : Number(nonceLowUnsigned);

    const nonceHigh =
      nonceHighUnsigned >= BigInt('0x8000000000000000')
        ? Number(nonceHighUnsigned - BigInt('0x10000000000000000'))
        : Number(nonceHighUnsigned);

    const nonceCommand = parsedNonce.command;

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
        addressToBytes(sponsor),
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

  // Validate the BatchCompact structure and allocation (with OFF_CHAIN nonce command)
  const validationResult = await validateBatchCompact(
    compact,
    chainId,
    db,
    NonceCommand.OFF_CHAIN
  );
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
 * Normalize a lockTag to lowercase hex string without 0x prefix for comparison
 */
function normalizeLockTag(lockTag: string): string {
  const stripped = lockTag.startsWith('0x') ? lockTag.slice(2) : lockTag;
  return stripped.toLowerCase().padStart(24, '0'); // 12 bytes = 24 hex chars
}

/**
 * Calculate delta between deposit amounts and commitment amounts
 *
 * CRITICAL: Matching is done by (lockTag, token) pair, NOT just by token!
 *
 * In a Permit2 deposit flow:
 * - All deposited tokens share a SINGLE lockTag (depositLockTag)
 * - Each compact commitment has its own lockTag
 * - Only commitments whose lockTag MATCHES the depositLockTag can be offset
 * - Commitments with different lockTags require FULL allocation (no offset)
 *
 * @param commitments - The compact commitments (each has its own lockTag)
 * @param deposits - The token deposits (all share the depositLockTag)
 * @param depositLockTag - The single lockTag for ALL deposits
 */
function calculateDepositCommitmentDeltas(
  commitments: Array<{ lockTag: string; token: string; amount: string }>,
  deposits: Array<{ token: string; amount: string }>,
  depositLockTag: string
): DepositCommitmentDelta[] {
  const deltas: DepositCommitmentDelta[] = [];
  const normalizedDepositLockTag = normalizeLockTag(depositLockTag);

  // Create a map of deposit amounts by (lockTag, token) composite key
  // All deposits use the SAME lockTag (depositLockTag)
  const depositByLockTagAndToken = new Map<string, bigint>();
  for (const deposit of deposits) {
    const normalizedToken = getAddress(deposit.token).toLowerCase();
    // Key format: "lockTag:token"
    const key = `${normalizedDepositLockTag}:${normalizedToken}`;
    const existingAmount = depositByLockTagAndToken.get(key) || BigInt(0);
    depositByLockTagAndToken.set(key, existingAmount + BigInt(deposit.amount));
  }

  // For each commitment, calculate the delta
  for (const commitment of commitments) {
    const normalizedCommitmentLockTag = normalizeLockTag(commitment.lockTag);
    const normalizedToken = getAddress(commitment.token).toLowerCase();
    const commitmentAmount = BigInt(commitment.amount);

    // Key for this commitment's (lockTag, token) pair
    const key = `${normalizedCommitmentLockTag}:${normalizedToken}`;

    // Only get deposit amount if the commitment's lockTag matches the deposit lockTag
    // If lockTags differ, there's NO matching deposit (even if same token!)
    const depositAmount = depositByLockTagAndToken.get(key) || BigInt(0);

    // Calculate delta (positive = needs allocation)
    const delta =
      commitmentAmount > depositAmount
        ? commitmentAmount - depositAmount
        : BigInt(0);

    deltas.push({
      lockTag: commitment.lockTag,
      token: commitment.token,
      commitmentAmount,
      depositAmount,
      delta,
    });

    // Reduce the deposit amount for this (lockTag, token) pair
    if (depositAmount > BigInt(0)) {
      const remaining =
        depositAmount > commitmentAmount
          ? depositAmount - commitmentAmount
          : BigInt(0);
      depositByLockTagAndToken.set(key, remaining);
    }
  }

  return deltas;
}

/**
 * Handle Permit2-based allocation request
 *
 * This flow handles hybrid allocations where:
 * 1. Sponsor signs a Permit2 message that deposits tokens AND registers a compact
 * 2. If compact commits more than deposited, additional off-chain allocation is needed
 * 3. The allocator signs for the delta (excess) amount only
 */
async function handlePermit2Allocation(
  request: Permit2AllocationRequest,
  db: PGlite
): Promise<AllocationResponse> {
  const { chainId, permit2Message, signature, mandateHash, witnessTypeString } =
    request;

  // Extract the compact from the Permit2 message witness
  const compact = permit2Message.witness.compact;

  // Validate basic request structure
  if (
    !compact ||
    !compact.arbiter ||
    !compact.sponsor ||
    !compact.commitments
  ) {
    throw new Error('Invalid Permit2 message: missing compact in witness');
  }

  if (
    !mandateHash ||
    !mandateHash.startsWith('0x') ||
    mandateHash.length !== 66
  ) {
    throw new Error('Invalid mandate hash: must be 32-byte hex string');
  }

  if (!witnessTypeString || witnessTypeString.length === 0) {
    throw new Error('Invalid witness type string: must not be empty');
  }

  // Validate depositLockTag
  if (
    !permit2Message.depositLockTag ||
    permit2Message.depositLockTag.length === 0
  ) {
    throw new Error('Invalid Permit2 message: depositLockTag is required');
  }

  // Validate arbiter
  const arbiterValidation = validateArbiter(compact.arbiter);
  if (!arbiterValidation.isValid) {
    throw new Error(arbiterValidation.error || 'Invalid arbiter');
  }

  // Verify the Permit2 signature
  // This proves the sponsor authorized this specific deposit+compact combination
  const recoveredSigner = await verifyPermit2Signature(
    permit2Message,
    signature,
    chainId,
    witnessTypeString,
    mandateHash
  );

  if (
    recoveredSigner.toLowerCase() !== getAddress(compact.sponsor).toLowerCase()
  ) {
    throw new Error(
      `Permit2 signature mismatch: recovered ${recoveredSigner}, expected ${compact.sponsor}`
    );
  }

  // Create a BatchCompactMessage with the mandate hash as witness
  const compactWithWitness: BatchCompactMessage = {
    arbiter: compact.arbiter,
    sponsor: compact.sponsor,
    nonce: compact.nonce,
    expires: compact.expires,
    commitments: compact.commitments,
    witnessTypeString: witnessTypeString,
    witnessHash: mandateHash,
  };

  // Validate the BatchCompact structure and allocation (with PERMIT2 nonce command)
  const validationResult = await validateBatchCompact(
    compactWithWitness,
    chainId,
    db,
    NonceCommand.PERMIT2
  );
  if (!validationResult.isValid || !validationResult.validatedCompact) {
    throw new Error(
      validationResult.error || 'Invalid BatchCompact in Permit2 message'
    );
  }

  const validatedCompact =
    validationResult.validatedCompact as ValidatedBatchCompactMessage;

  // Validate hybrid nonce structure (must be PERMIT2 command for Permit2-based allocation)
  const nonceValidation = validateHybridNonce(
    validatedCompact.nonce,
    validatedCompact.sponsor,
    NonceCommand.PERMIT2
  );
  if (!nonceValidation.isValid) {
    throw new Error(
      nonceValidation.error || 'Invalid nonce structure for Permit2 allocation'
    );
  }

  // Calculate deposit vs commitment deltas
  // CRITICAL: Match by (lockTag, token) pair - only commitments with matching lockTag get offset
  const deltas = calculateDepositCommitmentDeltas(
    validatedCompact.commitments,
    permit2Message.permitted,
    permit2Message.depositLockTag
  );

  // Check if any allocation is needed
  const totalDelta = deltas.reduce((sum, d) => sum + d.delta, BigInt(0));

  // Generate the claim hash with mandate
  const claimHash = generateBatchClaimHashWithMandate(
    validatedCompact.arbiter,
    validatedCompact.sponsor,
    validatedCompact.nonce,
    validatedCompact.expires,
    validatedCompact.commitments,
    mandateHash as Hex,
    witnessTypeString
  );

  if (totalDelta === BigInt(0)) {
    // Deposit fully covers all commitments - no additional allocation needed
    // NOTE: In this case, there's no need to call autocator at all.
    // The sponsor can use the fully on-chain flow via the hybrid allocator.
    return {
      claimHash,
      allocation: null,
      message:
        'Deposit covers all commitments - no additional allocation needed (use on-chain flow)',
    };
  }

  // Build the list of commitments that need additional allocation (delta > 0)
  // IMPORTANT: We only sign for the DELTA amounts, not the full compact amounts.
  // This prevents over-allocation if the Permit2 message is never relayed.
  const additionalCommitments = deltas
    .filter((d) => d.delta > BigInt(0))
    .map((d) => ({
      lockTag: d.lockTag,
      token: d.token,
      amount: d.delta.toString(), // Only the delta/excess amount
    }));

  // Sign the HybridAllocationContext - this authorizes ONLY the additional amounts
  // NOT the full compact. The deposit amounts are handled on-chain by the hybrid allocator.
  const { signature: signaturePromise } = await signHybridAllocationContext(
    claimHash,
    additionalCommitments,
    BigInt(chainId)
  );
  const allocationSignature = await signaturePromise;

  // Store the Permit2 allocation in the database
  // This ensures the allocation can be retrieved if the caller loses the response
  await storePermit2Allocation(
    db,
    chainId,
    claimHash,
    validatedCompact.sponsor,
    validatedCompact.nonce,
    validatedCompact.expires,
    mandateHash,
    witnessTypeString,
    permit2Message,
    signature,
    allocationSignature,
    additionalCommitments
  );

  return {
    claimHash,
    allocation: {
      commitments: additionalCommitments,
      nonce:
        `0x${validatedCompact.nonce.toString(16).padStart(64, '0')}` as Hex,
      signature: allocationSignature,
    },
    message: `Permit2 allocation successful - signed HybridAllocationContext for ${additionalCommitments.length} commitment(s) exceeding deposit`,
  };
}

/**
 * Handle on-chain registration-based allocation request
 *
 * This flow handles allocations where:
 * 1. Sponsor has already registered a compact on-chain (via deposit+register)
 * 2. We verify the registration is finalized (past finalization threshold)
 * 3. We verify the claim hash matches the provided compact pre-image
 * 4. We sign the full BatchCompact (same as standard allocation)
 */
async function handleOnChainAllocation(
  request: OnChainAllocationRequest,
  db: PGlite
): Promise<AllocationResponse> {
  const { chainId, compact, mandateHash, witnessTypeString } = request;

  // Validate basic request structure
  if (
    !mandateHash ||
    !mandateHash.startsWith('0x') ||
    mandateHash.length !== 66
  ) {
    throw new Error('Invalid mandate hash: must be 32-byte hex string');
  }

  if (!witnessTypeString || witnessTypeString.length === 0) {
    throw new Error('Invalid witness type string: must not be empty');
  }

  // Validate arbiter
  const arbiterValidation = validateArbiter(compact.arbiter);
  if (!arbiterValidation.isValid) {
    throw new Error(arbiterValidation.error || 'Invalid arbiter');
  }

  // Create a BatchCompactMessage with the mandate hash as witness
  const compactWithWitness: BatchCompactMessage = {
    arbiter: compact.arbiter,
    sponsor: compact.sponsor,
    nonce: compact.nonce,
    expires: compact.expires,
    commitments: compact.commitments,
    witnessTypeString: witnessTypeString,
    witnessHash: mandateHash,
  };

  // Validate the BatchCompact structure and allocation (with ON_CHAIN nonce command)
  const validationResult = await validateBatchCompact(
    compactWithWitness,
    chainId,
    db,
    NonceCommand.ON_CHAIN
  );
  if (!validationResult.isValid || !validationResult.validatedCompact) {
    throw new Error(validationResult.error || 'Invalid BatchCompact');
  }

  const validatedCompact =
    validationResult.validatedCompact as ValidatedBatchCompactMessage;

  // Validate hybrid nonce structure (must be ON_CHAIN command for on-chain allocation)
  const nonceValidation = validateHybridNonce(
    validatedCompact.nonce,
    validatedCompact.sponsor,
    NonceCommand.ON_CHAIN
  );
  if (!nonceValidation.isValid) {
    throw new Error(
      nonceValidation.error || 'Invalid nonce structure for on-chain allocation'
    );
  }

  // Generate the claim hash with mandate
  const claimHash = generateBatchClaimHashWithMandate(
    validatedCompact.arbiter,
    validatedCompact.sponsor,
    validatedCompact.nonce,
    validatedCompact.expires,
    validatedCompact.commitments,
    mandateHash as Hex,
    witnessTypeString
  );

  // Query the indexer for finalized registration
  // This only returns if the registration is past the finalization threshold
  const registration = await getFinalizedRegisteredCompact(claimHash, chainId);

  if (!registration) {
    throw new Error(
      `Compact not registered or not yet finalized on chain ${chainId}. ` +
        `Claim hash: ${claimHash}. ` +
        `Please wait for finalization threshold to pass before requesting allocation.`
    );
  }

  // Verify the sponsor matches the registration
  const registeredSponsor = getAddress(registration.sponsor);
  const requestedSponsor = getAddress(compact.sponsor);
  if (registeredSponsor.toLowerCase() !== requestedSponsor.toLowerCase()) {
    throw new Error(
      `Sponsor mismatch: registered sponsor is ${registeredSponsor}, ` +
        `but request specifies ${requestedSponsor}`
    );
  }

  // Sign the full BatchCompact (same as standard allocation)
  const { hash: derivedClaimHash, signature: signaturePromise } =
    await signBatchCompact(validatedCompact, BigInt(chainId));
  const signature = await signaturePromise;

  // Sanity check: verify derived claim hash matches the one we looked up
  if (derivedClaimHash.toLowerCase() !== claimHash.toLowerCase()) {
    throw new Error(
      `Claim hash mismatch: derived ${derivedClaimHash}, expected ${claimHash}. ` +
        `This indicates a bug in claim hash derivation.`
    );
  }

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
    message:
      'On-chain allocation successful - signed full BatchCompact for finalized registration',
  };
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
   * 3. OnChain - Post-execution allocation for registered compacts
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
            error: 'Request type is required (standard, permit2, or onchain)',
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

          case 'onchain':
            result = await handleOnChainAllocation(
              allocationRequest as OnChainAllocationRequest,
              server.db
            );
            break;

          default:
            reply.code(400);
            return {
              error: `Unknown request type. Valid types: standard, permit2, onchain`,
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
            error.message.includes('Insufficient') ||
            error.message.includes('mismatch') ||
            error.message.includes('not in the allowed list') ||
            error.message.includes('not registered') ||
            error.message.includes('Sponsor mismatch') ||
            error.message.includes('Nonce') ||
            error.message.includes('nonce'))
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

        // Check local compacts table (standard and on-chain allocations)
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

        // Check local permit2_allocations table (Permit2-type allocations)
        const permit2Result = await server.db.query<{
          claim_hash: Uint8Array;
          sponsor: Uint8Array;
          nonce: Uint8Array;
          expires: string;
          mandate_hash: Uint8Array;
          witness_type_string: string;
          permit2_message: string;
          permit2_signature: Uint8Array;
          allocation_signature: Uint8Array | null;
          additional_commitments: string | null;
          created_at: string;
        }>(
          `SELECT claim_hash, sponsor, nonce, expires, mandate_hash, witness_type_string,
                  permit2_message, permit2_signature, allocation_signature, 
                  additional_commitments, created_at
           FROM permit2_allocations
           WHERE chain_id = $1 AND claim_hash = $2`,
          [chainId, hexToBuffer(claimHash)]
        );

        if (permit2Result.rows.length > 0) {
          const row = permit2Result.rows[0];
          // PGlite returns JSONB as objects, not strings
          const permit2Message =
            typeof row.permit2_message === 'string'
              ? JSON.parse(row.permit2_message)
              : row.permit2_message;
          const additionalCommitments = row.additional_commitments
            ? typeof row.additional_commitments === 'string'
              ? JSON.parse(row.additional_commitments)
              : row.additional_commitments
            : null;

          return {
            exists: true,
            source: 'local-permit2',
            allocation: {
              claimHash,
              sponsor: getAddress(
                '0x' + Buffer.from(row.sponsor).toString('hex')
              ),
              nonce: '0x' + Buffer.from(row.nonce).toString('hex'),
              expires: row.expires,
              mandateHash: '0x' + Buffer.from(row.mandate_hash).toString('hex'),
              witnessTypeString: row.witness_type_string,
              permit2Message,
              permit2Signature:
                '0x' + Buffer.from(row.permit2_signature).toString('hex'),
              allocationSignature: row.allocation_signature
                ? '0x' + Buffer.from(row.allocation_signature).toString('hex')
                : null,
              additionalCommitments,
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
   * GET /allocations/:sponsor
   *
   * Get all allocations for a sponsor address
   * Returns allocations from both compacts table and permit2_allocations table
   */
  server.get<{
    Params: { sponsor: string };
  }>(
    '/allocations/:sponsor',
    async (
      request: FastifyRequest<{
        Params: { sponsor: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { sponsor } = request.params;

        // Normalize the sponsor address
        let normalizedSponsor: string;
        try {
          normalizedSponsor = getAddress(sponsor);
        } catch {
          reply.code(400);
          return { error: 'Invalid sponsor address format' };
        }

        const sponsorBytes = addressToBytes(normalizedSponsor);

        // Get standard/on-chain allocations from compacts table
        const compactsResult = await server.db.query<{
          chain_id: string;
          claim_hash: Uint8Array;
          sponsor: Uint8Array;
          nonce: Uint8Array;
          expires: string;
          signature: Uint8Array;
          witness_type_string: string | null;
          witness_hash: Uint8Array | null;
          created_at: string;
        }>(
          `SELECT chain_id, claim_hash, sponsor, nonce, expires, signature,
                  witness_type_string, witness_hash, created_at
           FROM compacts
           WHERE sponsor = $1
           ORDER BY created_at DESC`,
          [sponsorBytes]
        );

        // Get permit2 allocations from permit2_allocations table
        const permit2Result = await server.db.query<{
          chain_id: string;
          claim_hash: Uint8Array;
          sponsor: Uint8Array;
          nonce: Uint8Array;
          expires: string;
          mandate_hash: Uint8Array;
          witness_type_string: string;
          allocation_signature: Uint8Array | null;
          additional_commitments: string | null;
          created_at: string;
        }>(
          `SELECT chain_id, claim_hash, sponsor, nonce, expires, mandate_hash,
                  witness_type_string, allocation_signature, additional_commitments, created_at
           FROM permit2_allocations
           WHERE sponsor = $1
           ORDER BY created_at DESC`,
          [sponsorBytes]
        );

        // Format standard allocations
        const standardAllocations = compactsResult.rows.map((row) => ({
          type: 'standard' as const,
          chainId: row.chain_id,
          claimHash: '0x' + Buffer.from(row.claim_hash).toString('hex'),
          sponsor: getAddress('0x' + Buffer.from(row.sponsor).toString('hex')),
          nonce: '0x' + Buffer.from(row.nonce).toString('hex'),
          expires: row.expires,
          signature: '0x' + Buffer.from(row.signature).toString('hex'),
          witnessTypeString: row.witness_type_string,
          witnessHash: row.witness_hash
            ? '0x' + Buffer.from(row.witness_hash).toString('hex')
            : null,
          timestamp: row.created_at,
        }));

        // Format permit2 allocations
        const permit2Allocations = permit2Result.rows.map((row) => {
          // PGlite returns JSONB as objects, not strings
          const additionalCommitments = row.additional_commitments
            ? typeof row.additional_commitments === 'string'
              ? JSON.parse(row.additional_commitments)
              : row.additional_commitments
            : null;

          return {
            type: 'permit2' as const,
            chainId: row.chain_id,
            claimHash: '0x' + Buffer.from(row.claim_hash).toString('hex'),
            sponsor: getAddress(
              '0x' + Buffer.from(row.sponsor).toString('hex')
            ),
            nonce: '0x' + Buffer.from(row.nonce).toString('hex'),
            expires: row.expires,
            mandateHash: '0x' + Buffer.from(row.mandate_hash).toString('hex'),
            witnessTypeString: row.witness_type_string,
            allocationSignature: row.allocation_signature
              ? '0x' + Buffer.from(row.allocation_signature).toString('hex')
              : null,
            additionalCommitments,
            timestamp: row.created_at,
          };
        });

        // Combine and sort by timestamp (most recent first)
        const allAllocations = [
          ...standardAllocations,
          ...permit2Allocations,
        ].sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        return {
          sponsor: normalizedSponsor,
          count: allAllocations.length,
          allocations: allAllocations,
        };
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to get allocations for sponsor',
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
