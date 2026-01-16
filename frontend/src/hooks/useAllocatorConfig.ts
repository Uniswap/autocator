import { useContext } from 'react';
import { AllocatorConfigContext } from '../contexts/allocator-config-context';

/**
 * Hook to access the allocator configuration from the backend.
 *
 * This provides the allocator address and other config that is fetched
 * from the /health endpoint, avoiding hardcoded addresses in the frontend.
 *
 * @returns The allocator configuration including address, signing address, health status
 */
export function useAllocatorConfig() {
  const context = useContext(AllocatorConfigContext);

  if (!context) {
    throw new Error(
      'useAllocatorConfig must be used within an AllocatorConfigProvider'
    );
  }

  return context;
}
