import React, { useEffect, useState, useCallback } from 'react';
import {
  AllocatorConfigContext,
  AllocatorConfigContextType,
} from './allocator-config-context';

interface HealthResponse {
  status: string;
  allocatorAddress: string;
  signingAddress: string;
  timestamp: string;
  supportedChains: Array<{
    chainId: string;
    allocatorId: string;
    finalizationThresholdSeconds: number;
  }>;
}

interface AllocatorConfigProviderProps {
  children: React.ReactNode;
}

export const AllocatorConfigProvider: React.FC<
  AllocatorConfigProviderProps
> = ({ children }) => {
  const [config, setConfig] = useState<AllocatorConfigContextType>({
    allocatorAddress: null,
    signingAddress: null,
    isHealthy: false,
    isLoading: true,
  });

  const fetchHealthData = useCallback(async () => {
    try {
      const response = await fetch('/health');
      if (!response.ok) {
        setConfig((prev) => ({
          ...prev,
          isHealthy: false,
          isLoading: false,
        }));
        return;
      }
      const data: HealthResponse = await response.json();
      setConfig({
        allocatorAddress: data.allocatorAddress as `0x${string}`,
        signingAddress: data.signingAddress,
        isHealthy: data.status === 'healthy',
        isLoading: false,
      });
    } catch (error) {
      console.error('Error fetching health status:', error);
      setConfig((prev) => ({
        ...prev,
        isHealthy: false,
        isLoading: false,
      }));
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchHealthData();

    // Refresh every 10 seconds (less frequent than display updates)
    const intervalId = setInterval(fetchHealthData, 10000);

    return () => clearInterval(intervalId);
  }, [fetchHealthData]);

  return (
    <AllocatorConfigContext.Provider value={config}>
      {children}
    </AllocatorConfigContext.Provider>
  );
};

// Re-export the context type for convenience
export type { AllocatorConfigContextType };
export { AllocatorConfigContext };
