import {
  mainnet,
  optimism,
  optimismGoerli,
  sepolia,
  goerli,
  base,
  baseSepolia,
} from 'viem/chains';
import { unichain } from '../config/wagmi';

// The Compact V1 is deployed at the same address on all networks
export const COMPACT_ADDRESS =
  '0x00000000000000171ede64904551eeDF3C6C9788' as const;

// HybridAllocator is deployed at the same address on all networks
export const HYBRID_ALLOCATOR_ADDRESS =
  '0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B' as const;

// Tribunal arbiter is deployed at the same address on all networks
export const TRIBUNAL_ADDRESS =
  '0x000000000000790009689f43bAedb61D67D45bB8' as const;

// Known arbiters that users can select from
export interface ArbiterOption {
  address: `0x${string}`;
  name: string;
  description: string;
  isCustom?: boolean;
}

export const KNOWN_ARBITERS: ArbiterOption[] = [
  {
    address: TRIBUNAL_ADDRESS,
    name: 'Tribunal',
    description: 'Standard arbiter for cross-chain swaps',
  },
];

// Special option for custom arbiter input
export const CUSTOM_ARBITER_OPTION: ArbiterOption = {
  address: '0x0000000000000000000000000000000000000000',
  name: 'Custom',
  description: 'Enter a custom arbiter address',
  isCustom: true,
};

// Helper to get arbiter by address
export function getArbiterByAddress(
  address: string
): ArbiterOption | undefined {
  const normalizedAddress = address.toLowerCase();
  return KNOWN_ARBITERS.find(
    (arbiter) => arbiter.address.toLowerCase() === normalizedAddress
  );
}

// Helper to check if address is a known arbiter
export function isKnownArbiter(address: string): boolean {
  return getArbiterByAddress(address) !== undefined;
}

// Chain configurations
export const SUPPORTED_CHAINS = {
  [mainnet.id]: {
    name: 'Ethereum',
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://etherscan.io',
  },
  [optimism.id]: {
    name: 'Optimism',
    rpcUrl: 'https://opt-mainnet.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://optimistic.etherscan.io',
  },
  [optimismGoerli.id]: {
    name: 'Optimism Goerli',
    rpcUrl: 'https://opt-goerli.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://goerli-optimism.etherscan.io',
  },
  [sepolia.id]: {
    name: 'Sepolia',
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://sepolia.etherscan.io',
  },
  [goerli.id]: {
    name: 'Goerli',
    rpcUrl: 'https://eth-goerli.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://goerli.etherscan.io',
  },
  [base.id]: {
    name: 'Base',
    rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://basescan.org',
  },
  [baseSepolia.id]: {
    name: 'Base Sepolia',
    rpcUrl: 'https://base-sepolia.g.alchemy.com/v2/',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://sepolia.basescan.org',
  },
  [unichain.id]: {
    name: 'Unichain',
    rpcUrl: 'https://mainnet.unichain.org',
    compactAddress: COMPACT_ADDRESS as `0x${string}`,
    blockExplorer: 'https://uniscan.xyz',
  },
} as const;

export const COMPACT_ABI = [
  // Native ETH deposit
  {
    inputs: [
      { name: 'lockTag', type: 'bytes12' },
      { name: 'recipient', type: 'address' },
    ],
    name: 'depositNative',
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
  // ERC20 deposit
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'lockTag', type: 'bytes12' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    name: 'depositERC20',
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Forced withdrawal functions
  {
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'enableForcedWithdrawal',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'disableForcedWithdrawal',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'forcedWithdrawal',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Nonce consumption check
  {
    inputs: [
      { name: 'nonce', type: 'uint256' },
      { name: 'allocator', type: 'address' },
    ],
    name: 'hasConsumedAllocatorNonce',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Allocated Transfer
  {
    inputs: [
      {
        components: [
          {
            internalType: 'bytes',
            name: 'allocatorData',
            type: 'bytes',
          },
          {
            internalType: 'uint256',
            name: 'nonce',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expires',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'id',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'claimant',
                type: 'uint256',
              },
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256',
              },
            ],
            internalType: 'struct Component[]',
            name: 'recipients',
            type: 'tuple[]',
          },
        ],
        internalType: 'struct AllocatedTransfer',
        name: 'transfer',
        type: 'tuple',
      },
    ],
    name: 'allocatedTransfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const ERC20_ABI = [
  {
    constant: true,
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
  },
] as const;

// HybridAllocator ABI (key functions)
export const HYBRID_ALLOCATOR_ABI = [
  // View allocator ID (immutable per chain)
  {
    inputs: [],
    name: 'ALLOCATOR_ID',
    outputs: [{ name: '', type: 'uint96' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Check if an address is an authorized signer
  {
    inputs: [{ name: 'signer', type: 'address' }],
    name: 'signers',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Allocate and register (on-chain allocation)
  {
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'idsAndAmounts', type: 'uint256[2][]' },
      { name: 'arbiter', type: 'address' },
      { name: 'expires', type: 'uint256' },
      { name: 'typehash', type: 'bytes32' },
      { name: 'witness', type: 'bytes32' },
    ],
    name: 'allocateAndRegister',
    outputs: [
      { name: 'claimHash', type: 'bytes32' },
      { name: 'ids', type: 'uint256[]' },
      { name: 'nonce', type: 'uint256' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  // Authorize attestation for transfers
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'expires', type: 'uint256' },
      { name: 'idsAndAmounts', type: 'uint256[2][]' },
    ],
    name: 'authorizeAttestation',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Check attested transfer
  {
    inputs: [{ name: 'attestationHash', type: 'bytes32' }],
    name: 'attestations',
    outputs: [{ name: 'expires', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Helper function to get chain configuration
export function getChainConfig(chainId: number) {
  return SUPPORTED_CHAINS[chainId as keyof typeof SUPPORTED_CHAINS];
}

// Helper function to check if chain is supported
export function isSupportedChain(chainId: number): boolean {
  return chainId in SUPPORTED_CHAINS;
}

// Type for deposit function arguments
export type NativeDepositArgs = readonly [`0x${string}`, `0x${string}`];
export type TokenDepositArgs = readonly [
  `0x${string}`,
  `0x${string}`,
  bigint,
  `0x${string}`,
];

// Component type for transfer recipients
export interface Component {
  claimant: bigint; // uint256 encoding lockTag (12 bytes) + address (20 bytes)
  amount: bigint;
}

// Type for transfer payload
export interface AllocatedTransfer {
  allocatorData: `0x${string}`;
  nonce: bigint;
  expires: bigint;
  id: bigint;
  recipients: Component[];
}
