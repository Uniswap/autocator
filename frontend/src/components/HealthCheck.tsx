import React, { useEffect, useState } from 'react';
import { useAllocatorConfig } from '../hooks/useAllocatorConfig';

interface HealthCheckProps {
  onHealthStatusChange?: (isHealthy: boolean) => void;
}

const HealthCheck: React.FC<HealthCheckProps> = ({ onHealthStatusChange }) => {
  const { allocatorAddress, signingAddress, isHealthy, isLoading } =
    useAllocatorConfig();
  const [timestamp, setTimestamp] = useState<string>(new Date().toISOString());

  // Update timestamp every second for display
  useEffect(() => {
    const intervalId = setInterval(() => {
      setTimestamp(new Date().toISOString());
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  // Notify parent of health status changes
  useEffect(() => {
    onHealthStatusChange?.(isHealthy);
  }, [isHealthy, onHealthStatusChange]);

  if (!isHealthy && !isLoading) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-700/30 rounded-lg">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg
              className="h-5 w-5 text-red-400"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              Allocator server unavailable
            </h3>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !allocatorAddress) {
    return (
      <div className="flex justify-center items-center py-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#00ff00]"></div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Allocator Address and Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Allocator:</span>
          <span className="text-lg font-mono text-[#00ff00]">
            {allocatorAddress}
          </span>
        </div>
        <div className="flex items-center gap-2 w-[180px] justify-end">
          <span className="text-gray-400 text-sm pr-2">Status:</span>
          <span
            className={`px-2 py-0.5 text-xs rounded ${
              isHealthy
                ? 'bg-[#00ff00]/10 text-[#00ff00]'
                : 'bg-red-500/10 text-red-500'
            }`}
          >
            {isHealthy ? 'Healthy' : 'Unhealthy'}
          </span>
        </div>
      </div>

      {/* Signer and Last Checked */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Signer:</span>
          <span className="font-mono text-[#00ff00]">{signingAddress}</span>
        </div>
        <div className="flex items-center gap-2 w-[180px] justify-end whitespace-nowrap">
          <span className="text-gray-400">Last Checked:</span>
          <span className="font-mono text-[#00ff00]">
            {new Date(timestamp).toLocaleTimeString(undefined, {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        </div>
      </div>
    </div>
  );
};

export default HealthCheck;
