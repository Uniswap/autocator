import { createContext } from 'react';

export interface AllocatorConfigContextType {
  allocatorAddress: `0x${string}` | null;
  signingAddress: string | null;
  isHealthy: boolean;
  isLoading: boolean;
}

export const AllocatorConfigContext = createContext<AllocatorConfigContextType>(
  {
    allocatorAddress: null,
    signingAddress: null,
    isHealthy: false,
    isLoading: true,
  }
);
