import {
  useReadContract,
  useChainId,
  useWriteContract,
  useAccount,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { useState, useCallback, useMemo } from 'react';
import { HYBRID_ALLOCATOR_ABI } from '../constants/contracts';
import { useAllocatorConfig } from './useAllocatorConfig';

/**
 * Hook to read the HybridAllocator's allocator ID for the current chain
 */
export function useHybridAllocatorId() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();

  const { data, isLoading, error, refetch } = useReadContract({
    address: allocatorAddress ?? undefined,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'ALLOCATOR_ID',
    chainId,
    query: {
      enabled: !!allocatorAddress,
    },
  });

  return {
    allocatorId: data as bigint | undefined,
    isLoading: isLoading || !allocatorAddress,
    error,
    refetch,
  };
}

/**
 * Hook to check if an address is an authorized signer on the HybridAllocator
 */
export function useIsSigner(signerAddress?: `0x${string}`) {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();

  const { data, isLoading, error, refetch } = useReadContract({
    address: allocatorAddress ?? undefined,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'signers',
    args: signerAddress ? [signerAddress] : undefined,
    chainId,
    query: {
      enabled: !!signerAddress && !!allocatorAddress,
    },
  });

  return {
    isSigner: data as boolean | undefined,
    isLoading: isLoading || !allocatorAddress,
    error,
    refetch,
  };
}

/**
 * Hook to check attestation status for a given attestation hash
 */
export function useAttestation(attestationHash?: `0x${string}`) {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();

  const { data, isLoading, error, refetch } = useReadContract({
    address: allocatorAddress ?? undefined,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'attestations',
    args: attestationHash ? [attestationHash] : undefined,
    chainId,
    query: {
      enabled: !!attestationHash && !!allocatorAddress,
    },
  });

  return {
    expires: data as bigint | undefined,
    isValid: data ? (data as bigint) > 0n : false,
    isLoading: isLoading || !allocatorAddress,
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

/**
 * Hook to read the HybridAllocator's owner
 */
export function useHybridAllocatorOwner() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();

  const { data, isLoading, error, refetch } = useReadContract({
    address: allocatorAddress ?? undefined,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'owner',
    chainId,
    query: {
      enabled: !!allocatorAddress,
    },
  });

  return {
    owner: data as `0x${string}` | undefined,
    isLoading: isLoading || !allocatorAddress,
    error,
    refetch,
  };
}

/**
 * Hook to check if the HybridAllocator is deployed on the current chain
 */
export function useHybridAllocatorDeployed() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();

  const { data, isLoading, error } = useReadContract({
    address: allocatorAddress ?? undefined,
    abi: HYBRID_ALLOCATOR_ABI,
    functionName: 'ALLOCATOR_ID',
    chainId,
    query: {
      enabled: !!allocatorAddress,
    },
  });

  // If we can read the ALLOCATOR_ID, the contract is deployed
  const isDeployed = !error && data !== undefined;

  return {
    isDeployed,
    isLoading: isLoading || !allocatorAddress,
    error,
    allocatorId: data as bigint | undefined,
  };
}

/**
 * Hook to check if the connected account is the owner of the HybridAllocator
 */
export function useIsOwner() {
  const { address } = useAccount();
  const { owner, isLoading: ownerLoading, error } = useHybridAllocatorOwner();

  const isOwner = useMemo(() => {
    if (!address || !owner) return false;
    return address.toLowerCase() === owner.toLowerCase();
  }, [address, owner]);

  return {
    isOwner,
    owner,
    connectedAddress: address,
    isLoading: ownerLoading,
    error,
  };
}

/**
 * Hook to add a signer to the HybridAllocator (owner only)
 */
export function useAddSigner() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId,
  });

  const addSigner = useCallback(
    async (signerAddress: `0x${string}`) => {
      if (!allocatorAddress) {
        throw new Error('Allocator address not available');
      }
      try {
        const result = await writeContractAsync({
          address: allocatorAddress,
          abi: HYBRID_ALLOCATOR_ABI,
          functionName: 'addSigner',
          args: [signerAddress],
          chainId,
        });
        setTxHash(result);
        return result;
      } catch (err) {
        console.error('Failed to add signer:', err);
        throw err;
      }
    },
    [writeContractAsync, chainId, allocatorAddress]
  );

  return {
    addSigner,
    isWritePending,
    isConfirming,
    isSuccess,
    error: writeError,
    txHash,
    reset: useCallback(() => {
      reset();
      setTxHash(undefined);
    }, [reset]),
  };
}

/**
 * Hook to remove a signer from the HybridAllocator (owner only)
 */
export function useRemoveSigner() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId,
  });

  const removeSigner = useCallback(
    async (signerAddress: `0x${string}`) => {
      if (!allocatorAddress) {
        throw new Error('Allocator address not available');
      }
      try {
        const result = await writeContractAsync({
          address: allocatorAddress,
          abi: HYBRID_ALLOCATOR_ABI,
          functionName: 'removeSigner',
          args: [signerAddress],
          chainId,
        });
        setTxHash(result);
        return result;
      } catch (err) {
        console.error('Failed to remove signer:', err);
        throw err;
      }
    },
    [writeContractAsync, chainId, allocatorAddress]
  );

  return {
    removeSigner,
    isWritePending,
    isConfirming,
    isSuccess,
    error: writeError,
    txHash,
    reset: useCallback(() => {
      reset();
      setTxHash(undefined);
    }, [reset]),
  };
}

/**
 * Hook to replace a signer on the HybridAllocator (owner only)
 */
export function useReplaceSigner() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId,
  });

  const replaceSigner = useCallback(
    async (oldSigner: `0x${string}`, newSigner: `0x${string}`) => {
      if (!allocatorAddress) {
        throw new Error('Allocator address not available');
      }
      try {
        const result = await writeContractAsync({
          address: allocatorAddress,
          abi: HYBRID_ALLOCATOR_ABI,
          functionName: 'replaceSigner',
          args: [oldSigner, newSigner],
          chainId,
        });
        setTxHash(result);
        return result;
      } catch (err) {
        console.error('Failed to replace signer:', err);
        throw err;
      }
    },
    [writeContractAsync, chainId, allocatorAddress]
  );

  return {
    replaceSigner,
    isWritePending,
    isConfirming,
    isSuccess,
    error: writeError,
    txHash,
    reset: useCallback(() => {
      reset();
      setTxHash(undefined);
    }, [reset]),
  };
}

/**
 * Hook to propose a new owner for the HybridAllocator (owner only)
 */
export function useProposeOwner() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId,
  });

  const proposeOwner = useCallback(
    async (newOwner: `0x${string}`) => {
      if (!allocatorAddress) {
        throw new Error('Allocator address not available');
      }
      try {
        const result = await writeContractAsync({
          address: allocatorAddress,
          abi: HYBRID_ALLOCATOR_ABI,
          functionName: 'proposeOwnerReplacement',
          args: [newOwner],
          chainId,
        });
        setTxHash(result);
        return result;
      } catch (err) {
        console.error('Failed to propose owner:', err);
        throw err;
      }
    },
    [writeContractAsync, chainId, allocatorAddress]
  );

  return {
    proposeOwner,
    isWritePending,
    isConfirming,
    isSuccess,
    error: writeError,
    txHash,
    reset: useCallback(() => {
      reset();
      setTxHash(undefined);
    }, [reset]),
  };
}

/**
 * Hook to accept owner replacement on the HybridAllocator
 */
export function useAcceptOwnership() {
  const chainId = useChainId();
  const { allocatorAddress } = useAllocatorConfig();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId,
  });

  const acceptOwnership = useCallback(async () => {
    if (!allocatorAddress) {
      throw new Error('Allocator address not available');
    }
    try {
      const result = await writeContractAsync({
        address: allocatorAddress,
        abi: HYBRID_ALLOCATOR_ABI,
        functionName: 'acceptOwnerReplacement',
        args: [],
        chainId,
      });
      setTxHash(result);
      return result;
    } catch (err) {
      console.error('Failed to accept ownership:', err);
      throw err;
    }
  }, [writeContractAsync, chainId, allocatorAddress]);

  return {
    acceptOwnership,
    isWritePending,
    isConfirming,
    isSuccess,
    error: writeError,
    txHash,
    reset: useCallback(() => {
      reset();
      setTxHash(undefined);
    }, [reset]),
  };
}
