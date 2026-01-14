import {
  type Hex,
  serializeCompactSignature,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  concat,
  getAddress,
  signatureToCompactSignature,
  recoverAddress,
  parseCompactSignature,
  compactSignatureToSignature,
  serializeSignature,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  PERMIT2_ADDRESS,
  type Permit2Message,
  type TokenPermission,
} from './validation/types';
import { type StoredCompactMessage } from './compact';
import {
  ValidatedBatchCompactMessage,
  ValidatedMultichainCompactMessage,
} from './validation/types';

// EIP-712 domain for The Compact V1
const DOMAIN = {
  name: 'The Compact',
  version: '1',
  verifyingContract: '0x00000000000000171ede64904551eeDF3C6C9788',
} as const;

// EIP-712 domain typehash (for witness case)
const EIP712_DOMAIN_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    [
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ]
  )
);

// Get the private key for signing operations
const privateKey = process.env.PRIVATE_KEY as Hex;
if (!privateKey) {
  throw new Error('PRIVATE_KEY environment variable is required');
}

const account = privateKeyToAccount(privateKey);

export async function generateClaimHash(
  compact: StoredCompactMessage
): Promise<Hex> {
  // Normalize addresses
  const normalizedArbiter = getAddress(compact.arbiter);
  const normalizedSponsor = getAddress(compact.sponsor);

  if (!compact.witnessTypeString || !compact.witnessHash) {
    // Generate type hash
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'Compact(address arbiter,address sponsor,uint256 nonce,uint256 expires,uint256 id,uint256 amount)',
        ]
      )
    );

    // Generate message hash
    return keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          compact.id,
          BigInt(compact.amount),
        ]
      )
    );
  } else {
    // Generate type hash with witness
    // The witness typestring is appended as Mandate(witnessTypeString)
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'Compact(address arbiter,address sponsor,uint256 nonce,uint256 expires,uint256 id,uint256 amount,Mandate mandate)Mandate(' +
            compact.witnessTypeString +
            ')',
        ]
      )
    );

    // Generate message hash
    return keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'witnessHash', type: 'bytes32' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          compact.id,
          BigInt(compact.amount),
          compact.witnessHash as Hex,
        ]
      )
    );
  }
}

export function generateDomainHash(chainId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'name', type: 'bytes32' },
        { name: 'version', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(encodePacked(['string'], [DOMAIN.name])),
        keccak256(encodePacked(['string'], [DOMAIN.version])),
        chainId,
        DOMAIN.verifyingContract,
      ]
    )
  );
}

export function generateDigest(claimHash: Hex, domainHash: Hex): Hex {
  return keccak256(concat(['0x1901', domainHash, claimHash]));
}

export async function signDigest(hash: Hex): Promise<Hex> {
  // Sign the hash directly using the private key
  const signature = await sign({
    hash,
    privateKey,
  });

  // Convert to EIP2098 compact signature format
  const compactSig = signatureToCompactSignature(signature);
  return serializeCompactSignature(compactSig);
}

export type CompactSignature = {
  hash: Hex;
  digest: Hex;
  signature: Promise<Hex>;
};

// Generate claim hash for BatchCompact
export async function generateBatchClaimHash(
  compact: ValidatedBatchCompactMessage
): Promise<Hex> {
  // Normalize addresses
  const normalizedArbiter = getAddress(compact.arbiter);
  const normalizedSponsor = getAddress(compact.sponsor);

  // Sort commitments by lock ID (lockTag + token)
  const sortedCommitments = [...compact.commitments].sort((a, b) => {
    const aId = (BigInt(a.lockTag) << BigInt(160)) | BigInt(a.token);
    const bId = (BigInt(b.lockTag) << BigInt(160)) | BigInt(b.token);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  // Encode commitments array
  const commitmentsHash = keccak256(
    encodeAbiParameters(
      [
        {
          name: 'commitments',
          type: 'tuple[]',
          components: [
            { name: 'lockTag', type: 'bytes12' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
        },
      ],
      [
        sortedCommitments.map((c) => ({
          lockTag: (c.lockTag.startsWith('0x')
            ? c.lockTag
            : `0x${c.lockTag}`) as `0x${string}`,
          token: getAddress(c.token),
          amount: BigInt(c.amount),
        })),
      ]
    )
  );

  if (!compact.witnessTypeString || !compact.witnessHash) {
    // Generate type hash without witness
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments)Lock(bytes12 lockTag,address token,uint256 amount)',
        ]
      )
    );

    // Generate message hash
    return keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'commitmentsHash', type: 'bytes32' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          commitmentsHash,
        ]
      )
    );
  } else {
    // Generate type hash with witness
    const typeHash = keccak256(
      encodePacked(
        ['string'],
        [
          'BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
            compact.witnessTypeString +
            ')',
        ]
      )
    );

    // Generate message hash
    return keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'commitmentsHash', type: 'bytes32' },
          { name: 'witnessHash', type: 'bytes32' },
        ],
        [
          typeHash,
          normalizedArbiter,
          normalizedSponsor,
          compact.nonce,
          compact.expires,
          commitmentsHash,
          compact.witnessHash as Hex,
        ]
      )
    );
  }
}

// Generate claim hash for MultichainCompact
export async function generateMultichainClaimHash(
  compact: ValidatedMultichainCompactMessage,
  notarizedChainId: bigint,
  witnessTypeString?: string // The witness typestring for all elements
): Promise<Hex> {
  // Normalize sponsor address
  const normalizedSponsor = getAddress(compact.sponsor);

  // Generate Element typehash (shared by all elements)
  const elementTypeHash = keccak256(
    encodePacked(
      ['string'],
      [
        'Element(address arbiter,uint256 chainId,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
          witnessTypeString +
          ')',
      ]
    )
  );

  // Encode elements array
  const elementsHashes = await Promise.all(
    compact.elements.map(async (element) => {
      // Sort commitments by lock ID
      const sortedCommitments = [...element.commitments].sort((a, b) => {
        const aId = (BigInt(a.lockTag) << BigInt(160)) | BigInt(a.token);
        const bId = (BigInt(b.lockTag) << BigInt(160)) | BigInt(b.token);
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      });

      // Encode commitments
      const commitmentsHash = keccak256(
        encodeAbiParameters(
          [
            {
              name: 'commitments',
              type: 'tuple[]',
              components: [
                { name: 'lockTag', type: 'bytes12' },
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
            },
          ],
          [
            sortedCommitments.map((c) => ({
              lockTag: c.lockTag as `0x${string}`,
              token: getAddress(c.token),
              amount: BigInt(c.amount),
            })),
          ]
        )
      );

      // Element always includes witnessHash for multichain compacts
      // The witnessHash is required and should be a 32-byte hex string
      const witnessHash = element.witnessHash as Hex;

      return keccak256(
        encodeAbiParameters(
          [
            { name: 'elementTypeHash', type: 'bytes32' },
            { name: 'arbiter', type: 'address' },
            { name: 'chainId', type: 'uint256' },
            { name: 'commitmentsHash', type: 'bytes32' },
            { name: 'witnessHash', type: 'bytes32' },
          ],
          [
            elementTypeHash,
            getAddress(element.arbiter),
            element.chainId,
            commitmentsHash,
            witnessHash,
          ]
        )
      );
    })
  );

  const elementsHash = keccak256(
    encodeAbiParameters(
      [{ name: 'elements', type: 'bytes32[]' }],
      [elementsHashes]
    )
  );

  // Generate type hash for multichain compact
  // All elements share the same typehash with the same witness typestring
  const typeHash = keccak256(
    encodePacked(
      ['string'],
      [
        'MultichainCompact(address sponsor,uint256 nonce,uint256 expires,Element[] elements)Element(address arbiter,uint256 chainId,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
          (witnessTypeString || 'bytes data') +
          ')',
      ]
    )
  );

  // Generate message hash
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'sponsor', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expires', type: 'uint256' },
        { name: 'elementsHash', type: 'bytes32' },
      ],
      [
        typeHash,
        normalizedSponsor,
        compact.nonce,
        compact.expires,
        elementsHash,
      ]
    )
  );
}

export async function signCompact(
  compact: StoredCompactMessage,
  chainId: bigint
): Promise<CompactSignature> {
  const hash = await generateClaimHash(compact);
  const domainHash = generateDomainHash(chainId);
  const digest = generateDigest(hash, domainHash);
  return {
    hash,
    digest,
    signature: signDigest(digest),
  };
}

export async function signBatchCompact(
  compact: ValidatedBatchCompactMessage,
  chainId: bigint
): Promise<CompactSignature> {
  const hash = await generateBatchClaimHash(compact);
  const domainHash = generateDomainHash(chainId);
  const digest = generateDigest(hash, domainHash);
  return {
    hash,
    digest,
    signature: signDigest(digest),
  };
}

export async function signMultichainCompact(
  compact: ValidatedMultichainCompactMessage,
  notarizedChainId: bigint,
  witnessTypeString?: string
): Promise<CompactSignature> {
  const hash = await generateMultichainClaimHash(
    compact,
    notarizedChainId,
    witnessTypeString
  );
  const domainHash = generateDomainHash(notarizedChainId);
  const digest = generateDigest(hash, domainHash);
  return {
    hash,
    digest,
    signature: signDigest(digest),
  };
}

export function getSigningAddress(): string {
  return account.address;
}

// Utility function to verify our signing address matches configuration
export function verifySigningAddress(configuredAddress: string): void {
  if (process.env.SKIP_SIGNING_VERIFICATION === 'true') {
    return;
  }

  if (!configuredAddress) {
    throw new Error('No signing address configured');
  }

  const normalizedConfigured = getAddress(configuredAddress).toLowerCase();
  const normalizedActual = getAddress(account.address).toLowerCase();

  if (normalizedConfigured !== normalizedActual) {
    throw new Error(
      `Configured signing address ${normalizedConfigured} does not match ` +
        `actual signing address ${normalizedActual}`
    );
  }
}

// ============================================================
// Permit2 Signature Verification
// ============================================================

// Permit2 EIP-712 domain typehash (different from The Compact)
const PERMIT2_EIP712_DOMAIN_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    ['EIP712Domain(string name,uint256 chainId,address verifyingContract)']
  )
);

// Token permissions typehash
const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
  encodePacked(['string'], ['TokenPermissions(address token,uint256 amount)'])
);

/**
 * Generate the Permit2 domain separator for a specific chain
 */
export function generatePermit2DomainSeparator(chainId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'name', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [
        PERMIT2_EIP712_DOMAIN_TYPEHASH,
        keccak256(encodePacked(['string'], ['Permit2'])),
        chainId,
        PERMIT2_ADDRESS,
      ]
    )
  );
}

/**
 * Hash an array of token permissions for Permit2
 */
export function hashTokenPermissions(permissions: TokenPermission[]): Hex {
  const encodedPermissions = permissions.map((p) =>
    keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        [TOKEN_PERMISSIONS_TYPEHASH, getAddress(p.token), BigInt(p.amount)]
      )
    )
  );
  return keccak256(
    encodePacked(
      encodedPermissions.map(() => 'bytes32'),
      encodedPermissions
    )
  );
}

/**
 * Generate the BatchActivation witness hash for Permit2
 * This is the witness that gets embedded in the Permit2 signature
 */
export function generateBatchActivationWitnessHash(
  activator: string,
  ids: bigint[],
  compactHash: Hex,
  witnessTypeString: string
): Hex {
  // BatchActivation typehash includes the full compact type string
  const batchActivationTypehash = keccak256(
    encodePacked(
      ['string'],
      [
        'BatchActivation(address activator,uint256[] ids,BatchCompact compact)BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
          witnessTypeString +
          ')',
      ]
    )
  );

  // Hash the ids array
  const idsHash = keccak256(
    encodeAbiParameters([{ name: 'ids', type: 'uint256[]' }], [ids])
  );

  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'activator', type: 'address' },
        { name: 'idsHash', type: 'bytes32' },
        { name: 'compactHash', type: 'bytes32' },
      ],
      [batchActivationTypehash, getAddress(activator), idsHash, compactHash]
    )
  );
}

/**
 * Generate the claim hash for a BatchCompact with mandate witness
 * Used when the compact has a mandate (witness) included
 */
export function generateBatchClaimHashWithMandate(
  arbiter: string,
  sponsor: string,
  nonce: bigint,
  expires: bigint,
  commitments: Array<{ lockTag: string; token: string; amount: string }>,
  mandateHash: Hex,
  witnessTypeString: string
): Hex {
  const normalizedArbiter = getAddress(arbiter);
  const normalizedSponsor = getAddress(sponsor);

  // Hash each lock and then hash the array (in original order, no sorting)
  const LOCK_TYPEHASH = keccak256(
    encodePacked(
      ['string'],
      ['Lock(bytes12 lockTag,address token,uint256 amount)']
    )
  );
  const lockHashes = commitments.map((c) =>
    keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'lockTag', type: 'bytes12' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        [
          LOCK_TYPEHASH,
          (c.lockTag.startsWith('0x')
            ? c.lockTag
            : `0x${c.lockTag}`) as `0x${string}`,
          getAddress(c.token),
          BigInt(c.amount),
        ]
      )
    )
  );
  const commitmentsHash = keccak256(
    encodePacked(
      lockHashes.map(() => 'bytes32'),
      lockHashes
    )
  );

  // Generate type hash with mandate
  const typeHash = keccak256(
    encodePacked(
      ['string'],
      [
        'BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(' +
          witnessTypeString +
          ')',
      ]
    )
  );

  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'arbiter', type: 'address' },
        { name: 'sponsor', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expires', type: 'uint256' },
        { name: 'commitmentsHash', type: 'bytes32' },
        { name: 'mandateHash', type: 'bytes32' },
      ],
      [
        typeHash,
        normalizedArbiter,
        normalizedSponsor,
        nonce,
        expires,
        commitmentsHash,
        mandateHash,
      ]
    )
  );
}

// HybridAllocationContext typehash
// keccak256('HybridAllocationContext(bytes32 claimHash,Lock[] additionalCommitments)Lock(bytes12 lockTag,address token,uint256 amount)')
const HYBRID_ALLOCATION_CONTEXT_TYPEHASH = keccak256(
  encodePacked(
    ['string'],
    [
      'HybridAllocationContext(bytes32 claimHash,Lock[] additionalCommitments)Lock(bytes12 lockTag,address token,uint256 amount)',
    ]
  )
);

/**
 * Generate the HybridAllocationContext hash
 * Used for signing additional allocation amounts in Permit2 flows
 */
export function generateHybridAllocationContextHash(
  claimHash: Hex,
  additionalCommitments: Array<{
    lockTag: string;
    token: string;
    amount: string;
  }>
): Hex {
  // Lock typehash for individual commitment hashing
  const LOCK_TYPEHASH_LOCAL = keccak256(
    encodePacked(
      ['string'],
      ['Lock(bytes12 lockTag,address token,uint256 amount)']
    )
  );

  // Hash each additional commitment
  const commitmentHashes = additionalCommitments.map((c) =>
    keccak256(
      encodeAbiParameters(
        [
          { name: 'typeHash', type: 'bytes32' },
          { name: 'lockTag', type: 'bytes12' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        [
          LOCK_TYPEHASH_LOCAL,
          (c.lockTag.startsWith('0x')
            ? c.lockTag
            : `0x${c.lockTag}`) as `0x${string}`,
          getAddress(c.token),
          BigInt(c.amount),
        ]
      )
    )
  );

  // Hash the array of commitment hashes
  const commitmentsArrayHash = keccak256(
    encodePacked(
      commitmentHashes.map(() => 'bytes32'),
      commitmentHashes
    )
  );

  // Generate the full context hash
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'typeHash', type: 'bytes32' },
        { name: 'claimHash', type: 'bytes32' },
        { name: 'additionalCommitmentsHash', type: 'bytes32' },
      ],
      [HYBRID_ALLOCATION_CONTEXT_TYPEHASH, claimHash, commitmentsArrayHash]
    )
  );
}

/**
 * Sign a HybridAllocationContext
 * Returns a signature authorizing additional allocation amounts for a Permit2 flow
 */
export async function signHybridAllocationContext(
  claimHash: Hex,
  additionalCommitments: Array<{
    lockTag: string;
    token: string;
    amount: string;
  }>,
  chainId: bigint
): Promise<{ contextHash: Hex; digest: Hex; signature: Promise<Hex> }> {
  const contextHash = generateHybridAllocationContextHash(
    claimHash,
    additionalCommitments
  );
  const domainHash = generateDomainHash(chainId);
  const digest = generateDigest(contextHash, domainHash);
  return {
    contextHash,
    digest,
    signature: signDigest(digest),
  };
}

/**
 * Verify a Permit2 signature
 * Returns the recovered signer address
 */
export async function verifyPermit2Signature(
  permit2Message: Permit2Message,
  signature: Hex,
  chainId: string,
  witnessTypeString: string,
  mandateHash: Hex
): Promise<string> {
  const chainIdBigInt = BigInt(chainId);

  // Generate domain separator
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

  // Generate witness hash
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

  // Recover signer from compact signature
  const parsedCompactSig = parseCompactSignature(signature);
  const fullSignature = compactSignatureToSignature(parsedCompactSig);
  const serializedSig = serializeSignature(fullSignature);

  const recoveredAddress = await recoverAddress({
    hash: digest,
    signature: serializedSig,
  });

  return recoveredAddress;
}
