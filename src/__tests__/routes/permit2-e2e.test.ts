/**
 * End-to-End Permit2 Allocation Integration Tests
 *
 * These tests verify the complete Permit2 allocation flow:
 * 1. Create a valid Permit2 message with embedded BatchCompact
 * 2. Generate a real EIP-712 signature
 * 3. Submit to the /allocation endpoint with type: 'permit2'
 * 4. Validate the response including delta calculation
 */

import { FastifyInstance } from 'fastify';
import { createTestServer, cleanupTestServer } from '../utils/test-server';
import { setupGraphQLMocks, setMockToFail } from '../utils/graphql-mock';
import { resetIndexerHealthCache } from '../../graphql';
import { fetchAndCacheSupportedChains } from '../../graphql';
import { sign } from 'viem/accounts';
import {
  getAddress,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  concat,
  signatureToCompactSignature,
  serializeCompactSignature,
  type Hex,
} from 'viem';
import { constructHybridNonce } from '../../validation/hybrid-nonce';
import {
  NonceCommand,
  type Permit2Message,
  type BatchCompactMessage,
} from '../../validation/types';
import {
  TRIBUNAL_ADDRESS,
  getAllocatorAddress,
  initializeAllowedArbiters,
} from '../../validation/arbiter';
import {
  generatePermit2DomainSeparator,
  hashTokenPermissions,
  generateBatchActivationWitnessHash,
  generateBatchClaimHashWithMandate,
} from '../../crypto';

// Test private key (do not use in production)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

// Test sponsor address (derived from TEST_PRIVATE_KEY)
const TEST_SPONSOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// The Compact address (spender for Permit2)
const THE_COMPACT_ADDRESS = '0x00000000000000171ede64904551eeDF3C6C9788';

// Helper to encode lockTag
function encodeLockTag(
  allocatorId: bigint,
  resetPeriod: number,
  scope: number
): `0x${string}` {
  const packed =
    (allocatorId & ((BigInt(1) << BigInt(92)) - BigInt(1))) |
    (BigInt(resetPeriod) << BigInt(92)) |
    (BigInt(scope) << BigInt(95));
  const hex = packed.toString(16).padStart(24, '0');
  return `0x${hex}` as `0x${string}`;
}

// Reset period and scope enums
const ResetPeriod = {
  OneSecond: 0,
  FifteenSeconds: 1,
  OneMinute: 2,
  TenMinutes: 3,
  OneHourAndFiveMinutes: 4,
  OneDay: 5,
  SevenDaysAndOneHour: 6,
  ThirtyDays: 7,
} as const;

const Scope = {
  Multichain: 0,
  ChainSpecific: 1,
} as const;

// Counter for unique nonces
let permit2Counter = BigInt(0);

/**
 * Generate a valid Permit2 EIP-712 signature
 *
 * This matches the signature format expected by verifyPermit2Signature() in crypto.ts
 */
async function generatePermit2Signature(
  permit2Message: Permit2Message,
  chainId: string,
  witnessTypeString: string,
  mandateHash: Hex
): Promise<Hex> {
  const chainIdBigInt = BigInt(chainId);

  // Generate domain separator for Permit2 contract
  const domainSeparator = generatePermit2DomainSeparator(chainIdBigInt);

  // Hash token permissions
  const tokenPermissionsHash = hashTokenPermissions(permit2Message.permitted);

  // Generate compact hash with mandate
  const compact = permit2Message.witness.compact;
  const compactHash = generateBatchClaimHashWithMandate(
    compact.arbiter,
    compact.sponsor,
    BigInt(compact.nonce!),
    BigInt(compact.expires),
    compact.commitments,
    mandateHash,
    witnessTypeString
  );

  // Compute resource lock IDs from commitments
  const ids = compact.commitments.map((c) => {
    const lockTagBigInt = BigInt(c.lockTag);
    const tokenBigInt = BigInt(c.token);
    return (lockTagBigInt << BigInt(160)) | tokenBigInt;
  });

  // Generate witness hash (BatchActivation)
  const witnessHash = generateBatchActivationWitnessHash(
    permit2Message.witness.activator,
    ids,
    compactHash,
    witnessTypeString
  );

  // Generate the permit typehash with witness
  const PERMIT_TYPEHASH = keccak256(
    encodePacked(
      ['string'],
      [
        'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,BatchActivation witness)BatchActivation(address activator,uint256[] ids,BatchCompact compact)BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
          witnessTypeString +
          ')TokenPermissions(address token,uint256 amount)',
      ]
    )
  );

  // Generate the struct hash
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'tokenPermissionsHash', type: 'bytes32' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witnessHash', type: 'bytes32' },
      ],
      [
        PERMIT_TYPEHASH,
        tokenPermissionsHash,
        getAddress(permit2Message.spender),
        BigInt(permit2Message.nonce),
        BigInt(permit2Message.deadline),
        witnessHash,
      ]
    )
  );

  // Generate the final digest
  const digest = keccak256(concat(['0x1901', domainSeparator, structHash]));

  // Sign the digest
  const signResult = await sign({
    hash: digest,
    privateKey: TEST_PRIVATE_KEY,
  });

  // Convert to EIP2098 compact signature format
  const compactSig = signatureToCompactSignature(signResult);
  return serializeCompactSignature(compactSig);
}

/**
 * Create a fresh Permit2 allocation request for testing
 */
function createFreshPermit2Request(options: {
  depositAmount: string;
  commitmentAmount: string;
  witnessTypeString?: string;
}): {
  permit2Message: Permit2Message;
  mandateHash: Hex;
  witnessTypeString: string;
} {
  const counter = permit2Counter++;
  const witnessTypeString =
    options.witnessTypeString || 'address adjuster,address legate';

  // Create hybrid nonce with PERMIT2 command
  const nonce = constructHybridNonce(
    NonceCommand.PERMIT2,
    TEST_SPONSOR,
    counter
  );
  const nonceHex = `0x${nonce.toString(16).padStart(64, '0')}` as Hex;

  // Create the lockTag (same for deposit and commitment in this test)
  const lockTag = encodeLockTag(
    BigInt(1),
    ResetPeriod.ThirtyDays,
    Scope.Multichain
  );

  // Test token address
  const testToken = '0x0000000000000000000000000000000000000001';

  // Create the BatchCompact message
  const compact: BatchCompactMessage = {
    arbiter: TRIBUNAL_ADDRESS,
    sponsor: TEST_SPONSOR,
    nonce: nonceHex,
    expires: (Math.floor(Date.now() / 1000) + 3600).toString(), // 1 hour from now
    commitments: [
      {
        lockTag,
        token: testToken,
        amount: options.commitmentAmount,
      },
    ],
    witnessTypeString: witnessTypeString,
    witnessHash: null, // Will use mandateHash
  };

  // Compute resource lock IDs
  const ids = compact.commitments.map((c) => {
    const lockTagBigInt = BigInt(c.lockTag);
    const tokenBigInt = BigInt(c.token);
    return `0x${((lockTagBigInt << BigInt(160)) | tokenBigInt).toString(16).padStart(64, '0')}`;
  });

  // Create the Permit2 message
  const permit2Message: Permit2Message = {
    permitted: [
      {
        token: testToken,
        amount: options.depositAmount,
      },
    ],
    spender: THE_COMPACT_ADDRESS,
    nonce: counter.toString(), // Permit2 nonce (different from compact nonce)
    deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
    witness: {
      activator: getAllocatorAddress(),
      ids,
      compact,
    },
    depositLockTag: lockTag,
  };

  // Generate a deterministic mandate hash for testing
  const mandateHash = keccak256(
    encodePacked(['string', 'uint256'], ['test-mandate', counter])
  ) as Hex;

  return {
    permit2Message,
    mandateHash,
    witnessTypeString,
  };
}

describe('Permit2 End-to-End Allocation Tests', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    // Setup GraphQL mocks
    setupGraphQLMocks();

    // Initialize allowed arbiters
    initializeAllowedArbiters();

    server = await createTestServer();

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);
  });

  afterEach(async () => {
    setMockToFail(false);
    resetIndexerHealthCache();
    await cleanupTestServer();
  });

  describe('Full Permit2 allocation flow', () => {
    it('should process Permit2 allocation where deposit equals commitment (no delta)', async () => {
      // Create request where deposit = commitment
      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '1000000000000000000', // 1 token deposited
          commitmentAmount: '1000000000000000000', // 1 token committed
        });

      // Generate the Permit2 signature
      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      // Submit to allocation endpoint
      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should succeed
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Should have a claim hash
      expect(result).toHaveProperty('claimHash');
      expect(result.claimHash).toMatch(/^0x[0-9a-f]{64}$/i);

      // When deposit equals commitment, no additional allocation is needed
      expect(result.allocation).toBeNull();
      expect(result.message).toContain('no additional allocation needed');
    });

    it('should process Permit2 allocation where commitment exceeds deposit (positive delta)', async () => {
      // Create request where commitment > deposit
      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '500000000000000000', // 0.5 tokens deposited
          commitmentAmount: '1000000000000000000', // 1 token committed
        });

      // Generate the Permit2 signature
      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      // Submit to allocation endpoint
      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should succeed
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Should have a claim hash
      expect(result).toHaveProperty('claimHash');
      expect(result.claimHash).toMatch(/^0x[0-9a-f]{64}$/i);

      // Should have an allocation for the delta
      expect(result.allocation).not.toBeNull();
      expect(result.allocation).toHaveProperty('commitments');
      expect(result.allocation).toHaveProperty('nonce');
      expect(result.allocation).toHaveProperty('signature');

      // Allocation should be for the delta amount (0.5 tokens = 500000000000000000)
      expect(result.allocation.commitments).toHaveLength(1);
      expect(result.allocation.commitments[0].amount).toBe(
        '500000000000000000'
      );

      // Message should indicate partial allocation
      expect(result.message).toContain('Permit2 allocation successful');
    });

    it('should process Permit2 allocation where deposit exceeds commitment (no delta)', async () => {
      // Create request where deposit > commitment
      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '2000000000000000000', // 2 tokens deposited
          commitmentAmount: '1000000000000000000', // 1 token committed
        });

      // Generate the Permit2 signature
      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      // Submit to allocation endpoint
      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should succeed
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Should have a claim hash
      expect(result).toHaveProperty('claimHash');

      // No additional allocation needed
      expect(result.allocation).toBeNull();
      expect(result.message).toContain('no additional allocation needed');
    });

    it('should reject Permit2 allocation with signature from wrong address', async () => {
      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '1000000000000000000',
          commitmentAmount: '1000000000000000000',
        });

      // Generate a valid signature but from a DIFFERENT private key
      // This will recover to a different address than the sponsor
      const WRONG_PRIVATE_KEY =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

      // Generate the same digest as generatePermit2Signature but sign with wrong key
      const chainIdBigInt = BigInt('1');
      const domainSeparator = generatePermit2DomainSeparator(chainIdBigInt);
      const tokenPermissionsHash = hashTokenPermissions(
        permit2Message.permitted
      );

      const compact = permit2Message.witness.compact;
      const compactHash = generateBatchClaimHashWithMandate(
        compact.arbiter,
        compact.sponsor,
        BigInt(compact.nonce!),
        BigInt(compact.expires),
        compact.commitments,
        mandateHash,
        witnessTypeString
      );

      const ids = compact.commitments.map((c) => {
        const lockTagBigInt = BigInt(c.lockTag);
        const tokenBigInt = BigInt(c.token);
        return (lockTagBigInt << BigInt(160)) | tokenBigInt;
      });

      const witnessHash = generateBatchActivationWitnessHash(
        permit2Message.witness.activator,
        ids,
        compactHash,
        witnessTypeString
      );

      const PERMIT_TYPEHASH = keccak256(
        encodePacked(
          ['string'],
          [
            'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,BatchActivation witness)BatchActivation(address activator,uint256[] ids,BatchCompact compact)BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
              witnessTypeString +
              ')TokenPermissions(address token,uint256 amount)',
          ]
        )
      );

      const structHash = keccak256(
        encodeAbiParameters(
          [
            { name: 'typeHash', type: 'bytes32' },
            { name: 'tokenPermissionsHash', type: 'bytes32' },
            { name: 'spender', type: 'address' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'witnessHash', type: 'bytes32' },
          ],
          [
            PERMIT_TYPEHASH,
            tokenPermissionsHash,
            getAddress(permit2Message.spender),
            BigInt(permit2Message.nonce),
            BigInt(permit2Message.deadline),
            witnessHash,
          ]
        )
      );

      const digest = keccak256(concat(['0x1901', domainSeparator, structHash]));

      // Sign with the WRONG private key (recovers to different address)
      const signResult = await sign({
        hash: digest,
        privateKey: WRONG_PRIVATE_KEY,
      });

      const compactSig = signatureToCompactSignature(signResult);
      const wrongSignature = serializeCompactSignature(compactSig);

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature: wrongSignature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should fail with 400 because recovered signer doesn't match sponsor
      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('mismatch');
    });

    it('should reject Permit2 allocation with wrong sponsor in signature', async () => {
      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '1000000000000000000',
          commitmentAmount: '1000000000000000000',
        });

      // Change the sponsor to a different address after creating the request
      permit2Message.witness.compact.sponsor =
        '0x0000000000000000000000000000000000000002';

      // Generate signature (will be for TEST_SPONSOR but compact says different sponsor)
      const signature = await generatePermit2Signature(
        {
          ...permit2Message,
          witness: {
            ...permit2Message.witness,
            compact: {
              ...permit2Message.witness.compact,
              sponsor: TEST_SPONSOR, // Sign with original sponsor
            },
          },
        },
        '1',
        witnessTypeString,
        mandateHash
      );

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should fail because recovered signer doesn't match compact sponsor
      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('mismatch');
    });

    it('should return 503 when indexer is unhealthy', async () => {
      // Make the indexer fail
      setMockToFail(true);

      const { permit2Message, mandateHash, witnessTypeString } =
        createFreshPermit2Request({
          depositAmount: '1000000000000000000',
          commitmentAmount: '1000000000000000000',
        });

      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should fail with 503 (service unavailable)
      expect(response.statusCode).toBe(503);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('Service temporarily unavailable');
    });
  });

  describe('Permit2 with different lockTags', () => {
    it('should require full allocation when commitment lockTag differs from deposit lockTag', async () => {
      const counter = permit2Counter++;

      // Create hybrid nonce with PERMIT2 command
      const nonce = constructHybridNonce(
        NonceCommand.PERMIT2,
        TEST_SPONSOR,
        counter
      );
      const nonceHex = `0x${nonce.toString(16).padStart(64, '0')}` as Hex;

      // DIFFERENT lockTags for deposit vs commitment
      const depositLockTag = encodeLockTag(
        BigInt(1),
        ResetPeriod.ThirtyDays,
        Scope.Multichain
      );
      const commitmentLockTag = encodeLockTag(
        BigInt(1),
        ResetPeriod.SevenDaysAndOneHour,
        Scope.ChainSpecific
      );

      const testToken = '0x0000000000000000000000000000000000000001';
      const witnessTypeString = 'address adjuster,address legate';

      // Compact uses commitmentLockTag (different from deposit)
      const compact: BatchCompactMessage = {
        arbiter: TRIBUNAL_ADDRESS,
        sponsor: TEST_SPONSOR,
        nonce: nonceHex,
        expires: (Math.floor(Date.now() / 1000) + 3600).toString(),
        commitments: [
          {
            lockTag: commitmentLockTag, // Different from depositLockTag!
            token: testToken,
            amount: '1000000000000000000',
          },
        ],
        witnessTypeString,
        witnessHash: null,
      };

      const ids = compact.commitments.map((c) => {
        const lockTagBigInt = BigInt(c.lockTag);
        const tokenBigInt = BigInt(c.token);
        return `0x${((lockTagBigInt << BigInt(160)) | tokenBigInt).toString(16).padStart(64, '0')}`;
      });

      // Permit2 message uses depositLockTag for deposits
      const permit2Message: Permit2Message = {
        permitted: [
          {
            token: testToken,
            amount: '1000000000000000000', // Full amount deposited
          },
        ],
        spender: THE_COMPACT_ADDRESS,
        nonce: counter.toString(),
        deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
        witness: {
          activator: getAllocatorAddress(),
          ids,
          compact,
        },
        depositLockTag, // Deposit uses different lockTag!
      };

      const mandateHash = keccak256(
        encodePacked(
          ['string', 'uint256'],
          ['test-mandate-different-lock', counter]
        )
      ) as Hex;

      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      // Should succeed
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Because lockTags don't match, commitment gets NO offset from deposit
      // Full amount needs additional allocation
      expect(result.allocation).not.toBeNull();
      expect(result.allocation.commitments).toHaveLength(1);
      // Delta should be FULL commitment amount since lockTags don't match
      expect(result.allocation.commitments[0].amount).toBe(
        '1000000000000000000'
      );
    });
  });

  describe('Permit2 with multiple commitments', () => {
    it('should handle multiple commitments with correct delta calculation', async () => {
      const counter = permit2Counter++;

      const nonce = constructHybridNonce(
        NonceCommand.PERMIT2,
        TEST_SPONSOR,
        counter
      );
      const nonceHex = `0x${nonce.toString(16).padStart(64, '0')}` as Hex;

      const lockTag = encodeLockTag(
        BigInt(1),
        ResetPeriod.ThirtyDays,
        Scope.Multichain
      );

      const tokenA = '0x0000000000000000000000000000000000000001';
      const tokenB = '0x0000000000000000000000000000000000000002';
      const witnessTypeString = 'address adjuster,address legate';

      // Multiple commitments
      const compact: BatchCompactMessage = {
        arbiter: TRIBUNAL_ADDRESS,
        sponsor: TEST_SPONSOR,
        nonce: nonceHex,
        expires: (Math.floor(Date.now() / 1000) + 3600).toString(),
        commitments: [
          {
            lockTag,
            token: tokenA,
            amount: '1000000000000000000', // 1 token A
          },
          {
            lockTag,
            token: tokenB,
            amount: '500000000000000000', // 0.5 token B
          },
        ],
        witnessTypeString,
        witnessHash: null,
      };

      const ids = compact.commitments.map((c) => {
        const lockTagBigInt = BigInt(c.lockTag);
        const tokenBigInt = BigInt(c.token);
        return `0x${((lockTagBigInt << BigInt(160)) | tokenBigInt).toString(16).padStart(64, '0')}`;
      });

      // Deposit only token A (partial), no token B
      const permit2Message: Permit2Message = {
        permitted: [
          {
            token: tokenA,
            amount: '600000000000000000', // 0.6 token A (400000000000000000 short)
          },
          // No token B deposit
        ],
        spender: THE_COMPACT_ADDRESS,
        nonce: counter.toString(),
        deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
        witness: {
          activator: getAllocatorAddress(),
          ids,
          compact,
        },
        depositLockTag: lockTag,
      };

      const mandateHash = keccak256(
        encodePacked(['string', 'uint256'], ['test-mandate-multi', counter])
      ) as Hex;

      const signature = await generatePermit2Signature(
        permit2Message,
        '1',
        witnessTypeString,
        mandateHash
      );

      const response = await server.inject({
        method: 'POST',
        url: '/allocation',
        payload: {
          type: 'permit2',
          chainId: '1',
          permit2Message,
          signature,
          mandateHash,
          witnessTypeString,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Should have allocation for the deltas
      expect(result.allocation).not.toBeNull();
      expect(result.allocation.commitments).toHaveLength(2);

      // Check that both tokens have correct delta
      const tokenAAllocation = result.allocation.commitments.find(
        (c: { token: string }) => c.token.toLowerCase() === tokenA.toLowerCase()
      );
      const tokenBAllocation = result.allocation.commitments.find(
        (c: { token: string }) => c.token.toLowerCase() === tokenB.toLowerCase()
      );

      // Token A: commitment 1.0, deposit 0.6, delta = 0.4
      expect(tokenAAllocation.amount).toBe('400000000000000000');

      // Token B: commitment 0.5, deposit 0, delta = 0.5
      expect(tokenBAllocation.amount).toBe('500000000000000000');
    });
  });
});
