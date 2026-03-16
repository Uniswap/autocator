import { useState, useEffect, useCallback } from 'react';

interface ServerHealth {
  status: string;
  allocatorAddress: `0x${string}`;
  signingAddress: `0x${string}`;
  timestamp: string;
  supportedChains: Array<{
    chainId: string;
    allocatorId: string;
    finalizationThresholdSeconds: number;
  }>;
}

interface UseServerSignerResult {
  signingAddress: `0x${string}` | null;
  supportedChains: ServerHealth['supportedChains'];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch the server's configured signing address from the health endpoint
 */
export function useServerSigner(): UseServerSignerResult {
  const [signingAddress, setSigningAddress] = useState<`0x${string}` | null>(
    null
  );
  const [supportedChains, setSupportedChains] = useState<
    ServerHealth['supportedChains']
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchServerSigner = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/health');
      if (!response.ok) {
        throw new Error(`Failed to fetch health: ${response.statusText}`);
      }

      const data: ServerHealth = await response.json();
      setSigningAddress(data.signingAddress);
      setSupportedChains(data.supportedChains || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
      setSigningAddress(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServerSigner();
  }, [fetchServerSigner]);

  return {
    signingAddress,
    supportedChains,
    isLoading,
    error,
    refetch: fetchServerSigner,
  };
}
