import { http } from 'wagmi';
import {
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
  Chain,
} from 'viem/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

// Define Unichain configuration
export const unichain = {
  id: 130,
  name: 'Unichain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://mainnet.unichain.org'],
    },
    public: {
      http: ['https://mainnet.unichain.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Uniscan',
      url: 'https://uniscan.xyz',
    },
  },
} as const satisfies Chain;

// Define Unichain Sepolia configuration
export const unichainSepolia = {
  id: 1301,
  name: 'Unichain Sepolia',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://sepolia.unichain.org'],
    },
    public: {
      http: ['https://sepolia.unichain.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Uniscan',
      url: 'https://sepolia.uniscan.xyz',
    },
  },
  testnet: true,
} as const satisfies Chain;

// Configure supported chains - Get project ID from environment
const projectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID';

export const chains = [
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
  unichain,
  unichainSepolia,
] as const;

// Create wagmi config using RainbowKit's getDefaultConfig
export const config = getDefaultConfig({
  appName: 'Autocator',
  projectId,
  chains,
  transports: {
    // Use a single transport configuration for all chains
    ...Object.fromEntries(
      chains.map((chain) => [chain.id, http(chain.rpcUrls.default.http[0])])
    ),
  },
});

// Export chain IDs for type safety
export const CHAIN_IDS = {
  MAINNET: mainnet.id,
  OPTIMISM: optimism.id,
  OPTIMISM_SEPOLIA: optimismSepolia.id,
  SEPOLIA: sepolia.id,
  BASE: base.id,
  BASE_SEPOLIA: baseSepolia.id,
  ARBITRUM: arbitrum.id,
  ARBITRUM_SEPOLIA: arbitrumSepolia.id,
  UNICHAIN: unichain.id,
  UNICHAIN_SEPOLIA: unichainSepolia.id,
} as const;
