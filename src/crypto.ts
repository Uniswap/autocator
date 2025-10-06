import {
  type Hex,
  serializeCompactSignature,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  concat,
  getAddress,
  signatureToCompactSignature,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
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
