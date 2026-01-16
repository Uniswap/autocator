import { useState, useEffect, useCallback } from 'react';
import { config } from '../config/api';

export interface IndexedSigner {
  address: `0x${string}`;
  isActive: boolean;
  addedAt: string;
  removedAt: string | null;
}

export interface SignerChange {
  id: string;
  chainId: string;
  signerAddress: `0x${string}`;
  changeType: 'added' | 'removed';
  blockNumber: string;
  timestamp: string;
  transactionHash: `0x${string}`;
}

interface UseIndexedSignersResult {
  signers: IndexedSigner[];
  signerChanges: SignerChange[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const SIGNERS_QUERY = `
  query GetSigners {
    signers(orderBy: "addedAt", orderDirection: "desc") {
      items {
        address
        isActive
        addedAt
        removedAt
      }
    }
  }
`;

const SIGNER_CHANGES_QUERY = `
  query GetSignerChanges($chainId: BigInt) {
    signerChanges(
      where: { chainId: $chainId }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: 100
    ) {
      items {
        id
        chainId
        signerAddress
        changeType
        blockNumber
        timestamp
        transactionHash
      }
    }
  }
`;

const ALL_SIGNER_CHANGES_QUERY = `
  query GetAllSignerChanges {
    signerChanges(
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: 500
    ) {
      items {
        id
        chainId
        signerAddress
        changeType
        blockNumber
        timestamp
        transactionHash
      }
    }
  }
`;

/**
 * Hook to fetch all signers from the hybrid allocator indexer
 */
export function useIndexedSigners(): UseIndexedSignersResult {
  const [signers, setSigners] = useState<IndexedSigner[]>([]);
  const [signerChanges, setSignerChanges] = useState<SignerChange[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSigners = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Fetch both signers and all signer changes from the unified indexer
      const [signersRes, changesRes] = await Promise.all([
        fetch(config.graphqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: SIGNERS_QUERY }),
        }),
        fetch(config.graphqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: ALL_SIGNER_CHANGES_QUERY }),
        }),
      ]);

      if (!signersRes.ok) {
        throw new Error(`Failed to fetch signers: ${signersRes.statusText}`);
      }
      if (!changesRes.ok) {
        throw new Error(
          `Failed to fetch signer changes: ${changesRes.statusText}`
        );
      }

      const signersData = await signersRes.json();
      const changesData = await changesRes.json();

      if (signersData.errors) {
        throw new Error(signersData.errors[0]?.message || 'GraphQL error');
      }
      if (changesData.errors) {
        throw new Error(changesData.errors[0]?.message || 'GraphQL error');
      }

      setSigners(signersData.data?.signers?.items || []);
      setSignerChanges(changesData.data?.signerChanges?.items || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSigners();
  }, [fetchSigners]);

  return {
    signers,
    signerChanges,
    isLoading,
    error,
    refetch: fetchSigners,
  };
}

/**
 * Hook to fetch signer changes for a specific chain
 */
export function useChainSignerChanges(chainId?: bigint): {
  signerChanges: SignerChange[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [signerChanges, setSignerChanges] = useState<SignerChange[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchChanges = useCallback(async () => {
    if (!chainId) {
      setSignerChanges([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(config.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: SIGNER_CHANGES_QUERY,
          variables: { chainId: chainId.toString() },
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch signer changes: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errors) {
        throw new Error(data.errors[0]?.message || 'GraphQL error');
      }

      setSignerChanges(data.data?.signerChanges?.items || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [chainId]);

  useEffect(() => {
    fetchChanges();
  }, [fetchChanges]);

  return {
    signerChanges,
    isLoading,
    error,
    refetch: fetchChanges,
  };
}

/**
 * Compute active signers for a specific chain based on signer change events
 */
export function computeActiveSignersForChain(
  signerChanges: SignerChange[],
  chainId: string
): `0x${string}`[] {
  const chainChanges = signerChanges.filter(
    (change) => change.chainId === chainId
  );

  // Sort by timestamp (oldest first)
  const sortedChanges = [...chainChanges].sort(
    (a, b) => parseInt(a.timestamp) - parseInt(b.timestamp)
  );

  // Build the current state
  const activeSigners = new Set<`0x${string}`>();

  for (const change of sortedChanges) {
    if (change.changeType === 'added') {
      activeSigners.add(change.signerAddress.toLowerCase() as `0x${string}`);
    } else if (change.changeType === 'removed') {
      activeSigners.delete(change.signerAddress.toLowerCase() as `0x${string}`);
    }
  }

  return Array.from(activeSigners);
}

/**
 * Get all chains that have signer events
 */
export function getChainsWithSigners(signerChanges: SignerChange[]): string[] {
  const chainIds = new Set<string>();
  for (const change of signerChanges) {
    chainIds.add(change.chainId);
  }
  return Array.from(chainIds);
}
