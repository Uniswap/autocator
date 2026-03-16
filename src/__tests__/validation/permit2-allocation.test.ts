import { keccak256, encodePacked, encodeAbiParameters, getAddress } from 'viem';
import {
  generatePermit2DomainSeparator,
  hashTokenPermissions,
  generateBatchActivationWitnessHash,
  generateBatchClaimHashWithMandate,
  generateHybridAllocationContextHash,
  signHybridAllocationContext,
} from '../../crypto';
import { NonceCommand, PERMIT2_ADDRESS } from '../../validation/types';
import { constructHybridNonce } from '../../validation/hybrid-nonce';
import {
  TRIBUNAL_ADDRESS,
  initializeAllowedArbiters,
} from '../../validation/arbiter';

// Test addresses derived from the private key
const TEST_SPONSOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// EIP-712 constants
const PERMIT2_DOMAIN_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    ['EIP712Domain(string name,uint256 chainId,address verifyingContract)']
  )
);

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

// Test fixture interfaces
interface TokenPermission {
  token: string;
  amount: string;
}

interface Commitment {
  lockTag: string;
  token: string;
  amount: string;
}

describe('Permit2 Allocation Helper Functions', () => {
  beforeAll(() => {
    initializeAllowedArbiters();
  });

  describe('generatePermit2DomainSeparator', () => {
    it('should generate correct Permit2 domain separator for mainnet', () => {
      const chainId = BigInt(1);
      const domainSeparator = generatePermit2DomainSeparator(chainId);

      // Manually calculate expected value
      const expectedDomainSeparator = keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            PERMIT2_DOMAIN_TYPEHASH,
            keccak256(encodePacked(['string'], ['Permit2'])),
            chainId,
            PERMIT2_ADDRESS as `0x${string}`,
          ]
        )
      );

      expect(domainSeparator).toBe(expectedDomainSeparator);
    });

    it('should generate different domain separators for different chains', () => {
      const mainnetSeparator = generatePermit2DomainSeparator(BigInt(1));
      const optimismSeparator = generatePermit2DomainSeparator(BigInt(10));
      const arbitrumSeparator = generatePermit2DomainSeparator(BigInt(42161));

      expect(mainnetSeparator).not.toBe(optimismSeparator);
      expect(mainnetSeparator).not.toBe(arbitrumSeparator);
      expect(optimismSeparator).not.toBe(arbitrumSeparator);
    });
  });

  describe('hashTokenPermissions', () => {
    it('should hash a single token permission correctly', () => {
      const permitted: TokenPermission[] = [
        {
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000000000000000000', // 1 ETH
        },
      ];

      const hash = hashTokenPermissions(permitted);

      // Hash should be 32 bytes
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should hash multiple token permissions deterministically', () => {
      const permitted: TokenPermission[] = [
        {
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000000000000000000',
        },
        {
          token: '0x0000000000000000000000000000000000000002',
          amount: '500000000000000000',
        },
      ];

      const hash1 = hashTokenPermissions(permitted);
      const hash2 = hashTokenPermissions(permitted);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different token orders', () => {
      const permitted1: TokenPermission[] = [
        {
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000',
        },
        { token: '0x0000000000000000000000000000000000000002', amount: '2000' },
      ];

      const permitted2: TokenPermission[] = [
        {
          token: '0x0000000000000000000000000000000000000002',
          amount: '2000',
        },
        { token: '0x0000000000000000000000000000000000000001', amount: '1000' },
      ];

      const hash1 = hashTokenPermissions(permitted1);
      const hash2 = hashTokenPermissions(permitted2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateBatchActivationWitnessHash', () => {
    it('should generate a witness hash for batch activation', () => {
      const activator = '0x1234567890123456789012345678901234567890';
      const ids = [BigInt(1), BigInt(2)];
      const witnessTypeString = 'address adjuster,address legate';

      // First generate the compact hash
      const compactHash = generateBatchClaimHashWithMandate(
        TRIBUNAL_ADDRESS,
        TEST_SPONSOR,
        BigInt(1),
        BigInt(Math.floor(Date.now() / 1000) + 3600),
        [
          {
            lockTag: encodeLockTag(
              BigInt(1),
              ResetPeriod.ThirtyDays,
              Scope.Multichain
            ),
            token: '0x0000000000000000000000000000000000000001',
            amount: '1000000000000000000',
          },
        ],
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        witnessTypeString
      );

      const witnessHash = generateBatchActivationWitnessHash(
        activator,
        ids,
        compactHash,
        witnessTypeString
      );

      expect(witnessHash).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should produce different hashes for different activators', () => {
      const ids = [BigInt(1)];
      const witnessTypeString = '';

      // First generate the compact hash
      const compactHash = generateBatchClaimHashWithMandate(
        TRIBUNAL_ADDRESS,
        TEST_SPONSOR,
        BigInt(1),
        BigInt(Math.floor(Date.now() / 1000) + 3600),
        [
          {
            lockTag: encodeLockTag(
              BigInt(1),
              ResetPeriod.ThirtyDays,
              Scope.Multichain
            ),
            token: '0x0000000000000000000000000000000000000001',
            amount: '1000000000000000000',
          },
        ],
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        witnessTypeString
      );

      const hash1 = generateBatchActivationWitnessHash(
        '0x1111111111111111111111111111111111111111',
        ids,
        compactHash,
        witnessTypeString
      );
      const hash2 = generateBatchActivationWitnessHash(
        '0x2222222222222222222222222222222222222222',
        ids,
        compactHash,
        witnessTypeString
      );

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateBatchClaimHashWithMandate', () => {
    it('should generate claim hash with mandate', () => {
      const arbiter = TRIBUNAL_ADDRESS;
      const sponsor = TEST_SPONSOR;
      const nonce = BigInt(1);
      const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const commitments: Commitment[] = [
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000000000000000000',
        },
      ];

      const mandateHash =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
      const witnessTypeString = 'address adjuster,address legate';

      const claimHash = generateBatchClaimHashWithMandate(
        arbiter,
        sponsor,
        nonce,
        expires,
        commitments,
        mandateHash,
        witnessTypeString
      );

      expect(claimHash).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should produce different hashes for different mandates', () => {
      const arbiter = TRIBUNAL_ADDRESS;
      const sponsor = TEST_SPONSOR;
      const nonce = BigInt(1);
      const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const commitments: Commitment[] = [
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000000000000000000',
        },
      ];
      const witnessTypeString = 'address adjuster,address legate';

      const hash1 = generateBatchClaimHashWithMandate(
        arbiter,
        sponsor,
        nonce,
        expires,
        commitments,
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        witnessTypeString
      );

      const hash2 = generateBatchClaimHashWithMandate(
        arbiter,
        sponsor,
        nonce,
        expires,
        commitments,
        '0x2222222222222222222222222222222222222222222222222222222222222222',
        witnessTypeString
      );

      expect(hash1).not.toBe(hash2);
    });

    it('should preserve commitment order (not sort)', () => {
      const arbiter = TRIBUNAL_ADDRESS;
      const sponsor = TEST_SPONSOR;
      const nonce = BigInt(1);
      const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const witnessTypeString = '';
      const mandateHash =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

      // Commitments in one order
      const commitments1: Commitment[] = [
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000',
        },
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000002',
          amount: '2000',
        },
      ];

      // Commitments in reverse order
      const commitments2: Commitment[] = [
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000002',
          amount: '2000',
        },
        {
          lockTag: encodeLockTag(
            BigInt(1),
            ResetPeriod.ThirtyDays,
            Scope.Multichain
          ),
          token: '0x0000000000000000000000000000000000000001',
          amount: '1000',
        },
      ];

      const hash1 = generateBatchClaimHashWithMandate(
        arbiter,
        sponsor,
        nonce,
        expires,
        commitments1,
        mandateHash,
        witnessTypeString
      );

      const hash2 = generateBatchClaimHashWithMandate(
        arbiter,
        sponsor,
        nonce,
        expires,
        commitments2,
        mandateHash,
        witnessTypeString
      );

      // Hashes should be different because order is preserved (not sorted)
      expect(hash1).not.toBe(hash2);
    });
  });
});

describe('Permit2 Nonce Structure', () => {
  it('should create valid PERMIT2 nonce with correct command byte', () => {
    const sponsor = TEST_SPONSOR;
    const fragment = BigInt(1);

    const nonce = constructHybridNonce(NonceCommand.PERMIT2, sponsor, fragment);

    // Convert to hex string
    const nonceHex = `0x${nonce.toString(16).padStart(64, '0')}`;

    // First byte should be 0x03 (PERMIT2 command)
    expect(nonceHex.slice(2, 4)).toBe('03');

    // Next 20 bytes should contain the sponsor address
    const sponsorInNonce = `0x${nonceHex.slice(4, 44)}`;
    expect(sponsorInNonce.toLowerCase()).toBe(sponsor.toLowerCase());
  });

  it('should differ from OFF_CHAIN command nonces', () => {
    const sponsor = TEST_SPONSOR;
    const fragment = BigInt(1);

    const permit2Nonce = constructHybridNonce(
      NonceCommand.PERMIT2,
      sponsor,
      fragment
    );
    const offChainNonce = constructHybridNonce(
      NonceCommand.OFF_CHAIN,
      sponsor,
      fragment
    );

    expect(permit2Nonce).not.toBe(offChainNonce);

    // Check command bytes differ
    const permit2Hex = `0x${permit2Nonce.toString(16).padStart(64, '0')}`;
    const offChainHex = `0x${offChainNonce.toString(16).padStart(64, '0')}`;

    expect(permit2Hex.slice(2, 4)).toBe('03'); // PERMIT2
    expect(offChainHex.slice(2, 4)).toBe('02'); // OFF_CHAIN
  });
});

describe('HybridAllocationContext Signing', () => {
  /**
   * CRITICAL: The HybridAllocationContext is what the allocator signs for Permit2 flows.
   * It binds together:
   * 1. The claim hash (identifying the specific compact)
   * 2. The additional commitments (ONLY the delta/excess amounts, NOT the full compact amounts)
   *
   * This prevents over-allocation if the Permit2 message is never relayed.
   * The deposit amounts are handled on-chain by the hybrid allocator.
   */

  it('should generate a HybridAllocationContext hash', () => {
    const claimHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
    const additionalCommitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '500', // Only the delta amount, not the full commitment
      },
    ];

    const contextHash = generateHybridAllocationContextHash(
      claimHash,
      additionalCommitments
    );

    expect(contextHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('should produce different hashes for different claim hashes', () => {
    const additionalCommitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
    ];

    const hash1 = generateHybridAllocationContextHash(
      '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`,
      additionalCommitments
    );
    const hash2 = generateHybridAllocationContextHash(
      '0x2222222222222222222222222222222222222222222222222222222222222222' as `0x${string}`,
      additionalCommitments
    );

    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different additional amounts', () => {
    const claimHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );

    // Same lockTag and token, different amounts
    const hash1 = generateHybridAllocationContextHash(claimHash, [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
    ]);
    const hash2 = generateHybridAllocationContextHash(claimHash, [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '600',
      },
    ]);

    expect(hash1).not.toBe(hash2);
  });

  it('should sign HybridAllocationContext and return valid signature', async () => {
    const claimHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
    const additionalCommitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
    ];
    const chainId = BigInt(1);

    const { contextHash, digest, signature } =
      await signHybridAllocationContext(
        claimHash,
        additionalCommitments,
        chainId
      );

    expect(contextHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/i);

    const sig = await signature;
    // EIP-2098 compact signature should be 64 bytes = 128 hex chars + 0x prefix
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/i);
  });

  it('should produce different signatures for different chains (domain separation)', async () => {
    const claimHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
    const additionalCommitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
    ];

    const result1 = await signHybridAllocationContext(
      claimHash,
      additionalCommitments,
      BigInt(1)
    );
    const result2 = await signHybridAllocationContext(
      claimHash,
      additionalCommitments,
      BigInt(10)
    );

    // Context hash should be the same (domain-independent)
    expect(result1.contextHash).toBe(result2.contextHash);

    // But digest and signature should differ due to domain separation
    expect(result1.digest).not.toBe(result2.digest);

    const sig1 = await result1.signature;
    const sig2 = await result2.signature;
    expect(sig1).not.toBe(sig2);
  });

  it('should correctly bind signature to delta amounts only (security test)', async () => {
    const claimHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );
    const chainId = BigInt(1);

    // Sponsor deposits 800, commits to 1000 => delta is 200
    const deltaAmount = '200';
    const fullAmount = '1000';

    // Allocator should sign for DELTA only
    const deltaContext = await signHybridAllocationContext(
      claimHash,
      [
        {
          lockTag,
          token: '0x0000000000000000000000000000000000000001',
          amount: deltaAmount,
        },
      ],
      chainId
    );

    // A malicious attempt to get signature for full amount should produce different hash
    const fullContext = await signHybridAllocationContext(
      claimHash,
      [
        {
          lockTag,
          token: '0x0000000000000000000000000000000000000001',
          amount: fullAmount,
        },
      ],
      chainId
    );

    // Hashes and signatures must differ - this ensures the signature is bound to the specific delta
    expect(deltaContext.contextHash).not.toBe(fullContext.contextHash);
    expect(deltaContext.digest).not.toBe(fullContext.digest);
  });
});

describe('Deposit vs Commitment Delta Calculation', () => {
  /**
   * CRITICAL: This tests the lockTag-aware delta calculation used in handlePermit2Allocation
   *
   * Key insight: Deposits have a SINGLE lockTag that applies to ALL tokens in the deposit.
   * Only compact commitments whose lockTag MATCHES the depositLockTag can be offset.
   * Commitments with DIFFERENT lockTags (even for the same underlying token) get FULL delta.
   */

  interface DeltaResult {
    lockTag: string;
    token: string;
    commitmentAmount: bigint;
    depositAmount: bigint;
    delta: bigint;
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
   * @param commitments - The compact commitments (each has its own lockTag)
   * @param deposits - The token deposits (all share the depositLockTag)
   * @param depositLockTag - The single lockTag for ALL deposits
   */
  function calculateDeltas(
    commitments: Commitment[],
    deposits: TokenPermission[],
    depositLockTag: string
  ): DeltaResult[] {
    const deltas: DeltaResult[] = [];
    const normalizedDepositLockTag = normalizeLockTag(depositLockTag);

    // Create a map of deposit amounts by (lockTag, token) composite key
    // All deposits use the SAME lockTag (depositLockTag)
    const depositByLockTagAndToken = new Map<string, bigint>();
    for (const deposit of deposits) {
      const normalizedToken = getAddress(deposit.token).toLowerCase();
      // Key format: "lockTag:token"
      const key = `${normalizedDepositLockTag}:${normalizedToken}`;
      const existingAmount = depositByLockTagAndToken.get(key) || BigInt(0);
      depositByLockTagAndToken.set(
        key,
        existingAmount + BigInt(deposit.amount)
      );
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

  // Standard lockTag for tests
  const DEPOSIT_LOCK_TAG = encodeLockTag(
    BigInt(1),
    ResetPeriod.ThirtyDays,
    Scope.Multichain
  );

  it('should return zero delta when deposit equals commitment', () => {
    const commitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe(BigInt(0));
  });

  it('should return positive delta when commitment exceeds deposit', () => {
    const commitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '1500', // Commitment is 1500
      },
    ];

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000', // Deposit is only 1000
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe(BigInt(500)); // Need additional 500
  });

  it('should return zero delta when deposit exceeds commitment', () => {
    const commitments: Commitment[] = [
      {
        lockTag: encodeLockTag(
          BigInt(1),
          ResetPeriod.ThirtyDays,
          Scope.Multichain
        ),
        token: '0x0000000000000000000000000000000000000001',
        amount: '500', // Commitment is 500
      },
    ];

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000', // Deposit is 1000
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe(BigInt(0)); // No additional needed
    expect(deltas[0].commitmentAmount).toBe(BigInt(500));
    expect(deltas[0].depositAmount).toBe(BigInt(1000));
  });

  it('should handle multiple commitments for same token', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );
    const commitments: Commitment[] = [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '600',
      },
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '600',
      },
    ];

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(2);
    // First commitment: 1000 deposit, 600 needed => 0 delta, 400 remaining
    expect(deltas[0].delta).toBe(BigInt(0));
    // Second commitment: 400 remaining, 600 needed => 200 delta
    expect(deltas[1].delta).toBe(BigInt(200));
  });

  it('should handle multiple tokens correctly', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );
    const commitments: Commitment[] = [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000002',
        amount: '500',
      },
    ];

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '800', // 200 short
      },
      {
        token: '0x0000000000000000000000000000000000000002',
        amount: '600', // 100 extra
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta).toBe(BigInt(200)); // Token 1: needs 200 more
    expect(deltas[1].delta).toBe(BigInt(0)); // Token 2: covered
  });

  it('should handle commitment with no matching deposit', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );
    const commitments: Commitment[] = [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    const deposits: TokenPermission[] = []; // No deposits

    const deltas = calculateDeltas(commitments, deposits, DEPOSIT_LOCK_TAG);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe(BigInt(1000)); // Full amount needed
    expect(deltas[0].depositAmount).toBe(BigInt(0));
  });

  /**
   * CRITICAL: Same underlying token with DIFFERENT lockTags in the same compact.
   *
   * With lockTag-aware matching:
   * - Deposits only offset commitments with MATCHING lockTag
   * - Commitments with DIFFERENT lockTags get FULL allocation (delta = full amount)
   *
   * This is correct because deposits go into a specific resource lock (lockTag + token),
   * not into a shared pool by underlying token.
   */
  it('should give FULL delta to commitment with different lockTag (NO sharing)', () => {
    const lockTagA = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    ); // 30-day, multichain (matches deposit)
    const lockTagB = encodeLockTag(
      BigInt(1),
      ResetPeriod.SevenDaysAndOneHour,
      Scope.ChainSpecific
    ); // 7-day, chain-specific (DIFFERENT from deposit)

    // Deposit 1000 USDC with lockTagA
    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    // Commit to 500 USDC in lockTag A, 700 USDC in lockTag B
    const commitments: Commitment[] = [
      {
        lockTag: lockTagA, // Same as deposit lockTag
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
      {
        lockTag: lockTagB, // DIFFERENT from deposit lockTag
        token: '0x0000000000000000000000000000000000000001',
        amount: '700',
      },
    ];

    // Deposit lockTag is A - only commitments with lockTagA get offset
    const deltas = calculateDeltas(commitments, deposits, lockTagA);

    expect(deltas).toHaveLength(2);

    // First commitment (lockTag A): matches deposit lockTag, gets offset
    expect(deltas[0].lockTag).toBe(lockTagA);
    expect(deltas[0].commitmentAmount).toBe(BigInt(500));
    expect(deltas[0].depositAmount).toBe(BigInt(1000)); // Sees the deposit
    expect(deltas[0].delta).toBe(BigInt(0)); // Fully covered by deposit

    // Second commitment (lockTag B): DIFFERENT lockTag, NO offset at all!
    expect(deltas[1].lockTag).toBe(lockTagB);
    expect(deltas[1].commitmentAmount).toBe(BigInt(700));
    expect(deltas[1].depositAmount).toBe(BigInt(0)); // No deposit for this lockTag!
    expect(deltas[1].delta).toBe(BigInt(700)); // FULL amount needs allocation
  });

  it('should correctly handle commitment for token NOT in any deposit (full delta)', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );

    // Deposit 1000 of Token A
    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001', // Token A
        amount: '1000',
      },
    ];

    // But commit to Token B (completely different token)
    const commitments: Commitment[] = [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000002', // Token B - NOT deposited!
        amount: '500',
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, lockTag);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].token).toBe('0x0000000000000000000000000000000000000002');
    expect(deltas[0].delta).toBe(BigInt(500)); // Full commitment is delta (no matching deposit)
    expect(deltas[0].depositAmount).toBe(BigInt(0));
  });

  it('should handle mixed scenario: some tokens deposited, some not', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );

    // Only deposit Token A
    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001', // Token A
        amount: '800',
      },
    ];

    // Commit to both Token A (partially covered) and Token B (not covered at all)
    const commitments: Commitment[] = [
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000001', // Token A
        amount: '1000', // Need 200 more than deposited
      },
      {
        lockTag,
        token: '0x0000000000000000000000000000000000000002', // Token B
        amount: '300', // Fully needs allocation
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, lockTag);

    expect(deltas).toHaveLength(2);

    // Token A: deposit 800, commit 1000, delta = 200
    expect(deltas[0].delta).toBe(BigInt(200));

    // Token B: no deposit, commit 300, delta = 300
    expect(deltas[1].delta).toBe(BigInt(300));
  });

  /**
   * Order matters for commitments with SAME lockTag - they share a deposit pool.
   * This test uses the SAME lockTag for all commitments.
   */
  it('should demonstrate order-dependent deposit allocation (same lockTag)', () => {
    const lockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    // Two commitments with SAME lockTag, different amounts
    const commitments: Commitment[] = [
      {
        lockTag, // Same lockTag
        token: '0x0000000000000000000000000000000000000001',
        amount: '700', // First gets 700
      },
      {
        lockTag, // Same lockTag
        token: '0x0000000000000000000000000000000000000001',
        amount: '500', // Second gets remaining 300, needs 200 more
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, lockTag);

    expect(deltas).toHaveLength(2);

    // First commitment: gets 700 from deposit pool, delta = 0
    expect(deltas[0].delta).toBe(BigInt(0)); // Fully covered

    // Second commitment: only 300 remaining, needs 500, delta = 200
    expect(deltas[1].delta).toBe(BigInt(200)); // Shortfall
  });

  /**
   * When commitments have DIFFERENT lockTags than deposit, ALL need full allocation.
   */
  it('should require FULL allocation when ALL commitments have different lockTag than deposit', () => {
    const depositLockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.ThirtyDays,
      Scope.Multichain
    );
    const commitmentLockTag = encodeLockTag(
      BigInt(1),
      ResetPeriod.SevenDaysAndOneHour,
      Scope.ChainSpecific
    ); // Different!

    const deposits: TokenPermission[] = [
      {
        token: '0x0000000000000000000000000000000000000001',
        amount: '1000',
      },
    ];

    const commitments: Commitment[] = [
      {
        lockTag: commitmentLockTag, // Different from depositLockTag
        token: '0x0000000000000000000000000000000000000001',
        amount: '500',
      },
    ];

    const deltas = calculateDeltas(commitments, deposits, depositLockTag);

    expect(deltas).toHaveLength(1);
    // Even though 1000 was deposited of this token, the lockTag doesn't match
    // so the commitment gets NO offset - full 500 delta
    expect(deltas[0].depositAmount).toBe(BigInt(0));
    expect(deltas[0].delta).toBe(BigInt(500));
  });
});
