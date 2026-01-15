import { useReadContract, useChainId } from 'wagmi';
import {
  HYBRID_ALLOCATOR_ADDRESS,
  HYBRID_ALLOCATOR_ABI,
} from '../constants/contracts';

/**
 * Hook to read the HybridAllocator's allocator ID for the current chain
 */
export function useHybridAllocatorId() {
  const chainId = useChainId();

  const { data, isLoading, error, refetch } = useReadContract({
    address: HYBRID_ALLOCATOR_ADDRESS,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'ALLOCATOR_ID',
    chainId,
  });

  return {
    allocatorId: data as bigint | undefined,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook to check if an address is an authorized signer on the HybridAllocator
 */
export function useIsSigner(signerAddress?: `0x${string}`) {
  const chainId = useChainId();

  const { data, isLoading, error, refetch } = useReadContract({
    address: HYBRID_ALLOCATOR_ADDRESS,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'signers',
    args: signerAddress ? [signerAddress] : undefined,
    chainId,
    query: {
      enabled: !!signerAddress,
    },
  });

  return {
    isSigner: data as boolean | undefined,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook to check attestation status for a given attestation hash
 */
export function useAttestation(attestationHash?: `0x${string}`) {
  const chainId = useChainId();

  const { data, isLoading, error, refetch } = useReadContract({
    address: HYBRID_ALLOCATOR_ADDRESS,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'attestations',
    args: attestationHash ? [attestationHash] : undefined,
    chainId,
    query: {
      enabled: !!attestationHash,
    },
  });

  return {
    expires: data as bigint | undefined,
    isValid: data ? (data as bigint) > 0n : false,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Nonce command types for hybrid allocator nonces
 */
export enum NonceCommand {
  ON_CHAIN = 0x01,
  OFF_CHAIN = 0x02,
  PERMIT2 = 0x03,
}

/**
 * Construct a hybrid nonce with command byte, sponsor address, and fragment
 * Nonce structure: | Command (1 byte) | Sponsor (20 bytes) | Fragment (11 bytes) |
 */
export function constructHybridNonce(
  command: NonceCommand,
  sponsor: `0x${string}`,
  fragment: bigint
): bigint {
  // Validate fragment fits in 11 bytes (88 bits)
  const maxFragment = (1n << 88n) - 1n;
  if (fragment > maxFragment) {
    throw new Error('Fragment exceeds maximum value (11 bytes)');
  }

  // Remove 0x prefix and convert to BigInt
  const sponsorBigInt = BigInt(sponsor);

  // Construct nonce: command (top byte) | sponsor (20 bytes) | fragment (11 bytes)
  const nonce =
    (BigInt(command) << 248n) |
    (sponsorBigInt << 88n) |
    (fragment & maxFragment);

  return nonce;
}

/**
 * Parse a hybrid nonce into its components
 */
export function parseHybridNonce(nonce: bigint): {
  command: NonceCommand;
  sponsor: `0x${string}`;
  fragment: bigint;
} {
  // Extract command (top byte)
  const command = Number(nonce >> 248n) as NonceCommand;

  // Extract sponsor (middle 20 bytes)
  const sponsorMask = (1n << 160n) - 1n;
  const sponsorBigInt = (nonce >> 88n) & sponsorMask;
  const sponsor =
    `0x${sponsorBigInt.toString(16).padStart(40, '0')}` as `0x${string}`;

  // Extract fragment (bottom 11 bytes)
  const fragmentMask = (1n << 88n) - 1n;
  const fragment = nonce & fragmentMask;

  return { command, sponsor, fragment };
}

/**
 * Generate a random fragment for use in hybrid nonces
 */
export function generateRandomFragment(): bigint {
  // Generate 11 random bytes (88 bits)
  const randomBytes = new Uint8Array(11);
  crypto.getRandomValues(randomBytes);

  // Convert to BigInt
  let fragment = 0n;
  for (const byte of randomBytes) {
    fragment = (fragment << 8n) | BigInt(byte);
  }

  return fragment;
}

/**
 * Hook to generate hybrid nonces for the current user
 */
export function useHybridNonce(sponsor?: `0x${string}`) {
  const generateNonce = (
    command: NonceCommand = NonceCommand.OFF_CHAIN
  ): bigint | null => {
    if (!sponsor) return null;

    const fragment = generateRandomFragment();
    return constructHybridNonce(command, sponsor, fragment);
  };

  const generateNonceHex = (
    command: NonceCommand = NonceCommand.OFF_CHAIN
  ): `0x${string}` | null => {
    const nonce = generateNonce(command);
    if (!nonce) return null;
    return `0x${nonce.toString(16).padStart(64, '0')}` as `0x${string}`;
  };

  return {
    generateNonce,
    generateNonceHex,
  };
}
