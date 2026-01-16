import { useState, useEffect, useMemo } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import {
  useHybridAllocatorDeployed,
  useIsOwner,
  useIsSigner,
  useAddSigner,
  useRemoveSigner,
  useReplaceSigner,
} from '../hooks/useHybridAllocator';
import { SUPPORTED_CHAINS } from '../constants/contracts';
import { useAllocatorConfig } from '../hooks/useAllocatorConfig';
import {
  useIndexedSigners,
  computeActiveSignersForChain,
  getChainsWithSigners,
} from '../hooks/useIndexedSigners';
import { useServerSigner } from '../hooks/useServerSigner';

// Chain name mapping for display
const CHAIN_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '10': 'Optimism',
  '42161': 'Arbitrum One',
  '8453': 'Base',
  '130': 'Unichain',
  '11155111': 'Sepolia',
  '11155420': 'Optimism Sepolia',
  '421614': 'Arbitrum Sepolia',
  '84532': 'Base Sepolia',
  '1301': 'Unichain Sepolia',
};

function getChainName(chainId: string): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

function isValidAddress(address: string): address is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function AllocatorAdmin() {
  const { address: connectedAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const chainConfig =
    SUPPORTED_CHAINS[chainId as keyof typeof SUPPORTED_CHAINS];
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();

  // Get allocator address from backend config
  const { allocatorAddress, isLoading: configLoading } = useAllocatorConfig();

  // Contract status
  const {
    isDeployed,
    isLoading: deployedLoading,
    allocatorId,
  } = useHybridAllocatorDeployed();
  const { isOwner, owner, isLoading: ownerLoading } = useIsOwner();

  // Server's configured signing address
  const {
    signingAddress: serverSigningAddress,
    supportedChains: serverSupportedChains,
    isLoading: serverSignerLoading,
  } = useServerSigner();

  // Indexed signers from the indexer
  const {
    signerChanges,
    isLoading: indexerLoading,
    error: indexerError,
    refetch: refetchIndexer,
  } = useIndexedSigners();

  // Compute signers per chain from indexed data
  const signersPerChain = useMemo(() => {
    const chains = getChainsWithSigners(signerChanges);
    const result: Record<string, `0x${string}`[]> = {};
    for (const chain of chains) {
      result[chain] = computeActiveSignersForChain(signerChanges, chain);
    }
    return result;
  }, [signerChanges]);

  // Get signers for current chain
  const currentChainSigners = useMemo(() => {
    return signersPerChain[chainId.toString()] || [];
  }, [signersPerChain, chainId]);

  // Form states
  const [signerToCheck, setSignerToCheck] = useState('');
  const [newSignerAddress, setNewSignerAddress] = useState('');
  const [signerToRemove, setSignerToRemove] = useState('');
  const [oldSignerAddress, setOldSignerAddress] = useState('');
  const [replacementSignerAddress, setReplacementSignerAddress] = useState('');

  // Signer check
  const {
    isSigner,
    isLoading: signerLoading,
    refetch: refetchSigner,
  } = useIsSigner(isValidAddress(signerToCheck) ? signerToCheck : undefined);

  // Write hooks
  const {
    addSigner,
    isWritePending: addPending,
    isConfirming: addConfirming,
    isSuccess: addSuccess,
    error: addError,
    reset: resetAdd,
  } = useAddSigner();

  const {
    removeSigner,
    isWritePending: removePending,
    isConfirming: removeConfirming,
    isSuccess: removeSuccess,
    error: removeError,
    reset: resetRemove,
  } = useRemoveSigner();

  const {
    replaceSigner,
    isWritePending: replacePending,
    isConfirming: replaceConfirming,
    isSuccess: replaceSuccess,
    error: replaceError,
    reset: resetReplace,
  } = useReplaceSigner();

  // Reset forms on success
  useEffect(() => {
    if (addSuccess) {
      setNewSignerAddress('');
      setTimeout(() => resetAdd(), 3000);
    }
  }, [addSuccess, resetAdd]);

  useEffect(() => {
    if (removeSuccess) {
      setSignerToRemove('');
      setTimeout(() => resetRemove(), 3000);
    }
  }, [removeSuccess, resetRemove]);

  useEffect(() => {
    if (replaceSuccess) {
      setOldSignerAddress('');
      setReplacementSignerAddress('');
      setTimeout(() => resetReplace(), 3000);
    }
  }, [replaceSuccess, resetReplace]);

  // Handle form submissions
  const handleAddSigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidAddress(newSignerAddress)) return;
    try {
      await addSigner(newSignerAddress);
    } catch (err) {
      console.error('Error adding signer:', err);
    }
  };

  const handleRemoveSigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidAddress(signerToRemove)) return;
    try {
      await removeSigner(signerToRemove);
    } catch (err) {
      console.error('Error removing signer:', err);
    }
  };

  const handleReplaceSigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !isValidAddress(oldSignerAddress) ||
      !isValidAddress(replacementSignerAddress)
    )
      return;
    try {
      await replaceSigner(oldSignerAddress, replacementSignerAddress);
    } catch (err) {
      console.error('Error replacing signer:', err);
    }
  };

  // Loading state
  if (deployedLoading || ownerLoading || configLoading) {
    return (
      <div className="p-6 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
        <h2 className="text-xl font-bold text-white mb-4">
          🔧 HybridAllocator Admin
        </h2>
        <div className="flex items-center gap-2 text-gray-400">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#00ff00]"></div>
          Loading contract status...
        </div>
      </div>
    );
  }

  // Not connected
  if (!isConnected) {
    return (
      <div className="p-6 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
        <h2 className="text-xl font-bold text-white mb-4">
          🔧 HybridAllocator Admin
        </h2>
        <div className="p-4 bg-yellow-900/20 border border-yellow-600/30 rounded-lg">
          <p className="text-yellow-500">
            ⚠️ Please connect your wallet to access the admin panel.
          </p>
        </div>
      </div>
    );
  }

  // Contract not deployed
  if (!isDeployed || !allocatorAddress) {
    return (
      <div className="p-6 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
        <h2 className="text-xl font-bold text-white mb-4">
          🔧 HybridAllocator Admin
        </h2>
        <div className="p-4 bg-red-900/20 border border-red-600/30 rounded-lg">
          <p className="text-red-500">
            ❌ HybridAllocator is not deployed on{' '}
            {chainConfig?.name || `chain ${chainId}`}.
          </p>
          {allocatorAddress && (
            <p className="text-gray-400 text-sm mt-2">
              Contract address:{' '}
              <code className="text-gray-300">{allocatorAddress}</code>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
      <h2 className="text-xl font-bold text-white mb-4">
        🔧 HybridAllocator Admin
      </h2>

      {/* Contract Info */}
      <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">
          Contract Information
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Network:</span>
            <span className="text-white">
              {chainConfig?.name || `Chain ${chainId}`}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Contract:</span>
            <a
              href={`${chainConfig?.blockExplorer}/address/${allocatorAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#00ff00] hover:underline font-mono text-xs"
            >
              {allocatorAddress.slice(0, 6)}...
              {allocatorAddress.slice(-4)}
            </a>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Allocator ID:</span>
            <span className="text-white font-mono">
              {allocatorId?.toString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Owner:</span>
            <span className="text-white font-mono text-xs">
              {owner?.slice(0, 6)}...{owner?.slice(-4)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Connected:</span>
            <span className="text-white font-mono text-xs">
              {connectedAddress?.slice(0, 6)}...{connectedAddress?.slice(-4)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Server Signer:</span>
            {serverSignerLoading ? (
              <span className="text-gray-500 text-xs">Loading...</span>
            ) : serverSigningAddress ? (
              <span className="text-[#00ff00] font-mono text-xs">
                {serverSigningAddress.slice(0, 6)}...
                {serverSigningAddress.slice(-4)}
              </span>
            ) : (
              <span className="text-red-500 text-xs">Not configured</span>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions - Server Signer Setup */}
      {isOwner && serverSigningAddress && !serverSignerLoading && (
        <div className="mb-6 p-4 bg-blue-900/20 rounded-lg border border-blue-600/30">
          <h3 className="text-sm font-semibold text-blue-400 mb-3">
            ⚡ Quick Actions
          </h3>

          {/* Check if server signer is on current chain */}
          {(() => {
            const serverSignerLower =
              serverSigningAddress.toLowerCase() as `0x${string}`;
            const isServerSignerOnCurrentChain = currentChainSigners.some(
              (s) => s.toLowerCase() === serverSignerLower
            );
            const staleSigners = currentChainSigners.filter(
              (s) => s.toLowerCase() !== serverSignerLower
            );

            return (
              <div className="space-y-3">
                {/* Current chain status */}
                <div className="text-sm">
                  <span className="text-gray-400">
                    Current chain ({chainConfig?.name || `Chain ${chainId}`}):{' '}
                  </span>
                  {isServerSignerOnCurrentChain ? (
                    <span className="text-green-500">
                      ✓ Server signer registered
                    </span>
                  ) : (
                    <span className="text-yellow-500">
                      ⚠ Server signer NOT registered
                    </span>
                  )}
                </div>

                {/* Add server signer button if not registered */}
                {!isServerSignerOnCurrentChain && (
                  <button
                    onClick={() => {
                      setNewSignerAddress(serverSigningAddress);
                      addSigner(serverSigningAddress);
                    }}
                    disabled={addPending || addConfirming}
                    className="w-full px-4 py-2 bg-[#00ff00] hover:bg-[#00dd00] disabled:bg-gray-700 disabled:text-gray-500 text-black font-medium rounded-lg text-sm transition-colors"
                  >
                    {addPending
                      ? 'Confirm in Wallet...'
                      : addConfirming
                        ? 'Adding...'
                        : `➕ Add Server Signer on ${chainConfig?.name || `Chain ${chainId}`}`}
                  </button>
                )}

                {/* Remove stale signers */}
                {staleSigners.length > 0 && (
                  <div className="mt-3">
                    <p className="text-sm text-yellow-500 mb-2">
                      ⚠ {staleSigners.length} stale signer
                      {staleSigners.length !== 1 ? 's' : ''} found:
                    </p>
                    <div className="space-y-2">
                      {staleSigners.map((staleSigner, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between gap-2 p-2 bg-gray-800/50 rounded"
                        >
                          <span className="text-gray-300 font-mono text-xs">
                            {staleSigner.slice(0, 10)}...{staleSigner.slice(-8)}
                          </span>
                          <button
                            onClick={() => {
                              setSignerToRemove(staleSigner);
                              removeSigner(staleSigner);
                            }}
                            disabled={removePending || removeConfirming}
                            className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs rounded transition-colors"
                          >
                            {removePending || removeConfirming
                              ? '...'
                              : 'Remove'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Overview of all chains status */}
                {serverSupportedChains.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-blue-600/30">
                    <p className="text-sm text-gray-400 mb-2">
                      Server Supported Chains Status:
                    </p>
                    <div className="space-y-1">
                      {serverSupportedChains.map((chain) => {
                        const chainSigners =
                          signersPerChain[chain.chainId] || [];
                        const hasServerSigner = chainSigners.some(
                          (s) => s.toLowerCase() === serverSignerLower
                        );
                        const staleCount = chainSigners.filter(
                          (s) => s.toLowerCase() !== serverSignerLower
                        ).length;
                        const isCurrentChain =
                          chain.chainId === chainId.toString();

                        return (
                          <div
                            key={chain.chainId}
                            className="flex items-center justify-between text-xs"
                          >
                            <span
                              className={
                                isCurrentChain
                                  ? 'text-[#00ff00]'
                                  : 'text-gray-400'
                              }
                            >
                              {getChainName(chain.chainId)}
                              {isCurrentChain && ' (current)'}
                            </span>
                            <div className="flex items-center gap-2">
                              {hasServerSigner ? (
                                <span className="text-green-500">✓</span>
                              ) : (
                                <span className="text-yellow-500">✗</span>
                              )}
                              {staleCount > 0 && (
                                <span className="text-yellow-500">
                                  ({staleCount} stale)
                                </span>
                              )}
                              {!isCurrentChain && !hasServerSigner && (
                                <button
                                  onClick={() =>
                                    switchChain({
                                      chainId: parseInt(chain.chainId),
                                    })
                                  }
                                  disabled={isSwitchingChain}
                                  className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded text-xs"
                                >
                                  Switch
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Current Chain Signers */}
      <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-semibold text-gray-400">
            Registered Signers on {chainConfig?.name || `Chain ${chainId}`}
          </h3>
          <button
            onClick={refetchIndexer}
            disabled={indexerLoading}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white rounded transition-colors"
          >
            {indexerLoading ? '...' : '↻'}
          </button>
        </div>
        {indexerLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-[#00ff00]"></div>
            Loading from indexer...
          </div>
        ) : indexerError ? (
          <div className="text-red-400 text-sm">
            Failed to load signers: {indexerError.message}
          </div>
        ) : currentChainSigners.length === 0 ? (
          <p className="text-gray-500 text-sm italic">
            No signers registered on this chain yet.
          </p>
        ) : (
          <div className="space-y-2">
            {currentChainSigners.map((signer, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 bg-gray-800/50 rounded border border-gray-700"
              >
                <span className="text-white font-mono text-xs break-all">
                  {signer}
                </span>
                <span className="text-green-500 text-xs ml-2">✓ Active</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* All Chains Signers Overview */}
      <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">
          Signers Across All Chains
        </h3>
        {indexerLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-[#00ff00]"></div>
            Loading...
          </div>
        ) : Object.keys(signersPerChain).length === 0 ? (
          <p className="text-gray-500 text-sm italic">
            No signer data available from indexer.
          </p>
        ) : (
          <div className="space-y-3">
            {Object.entries(signersPerChain)
              .sort(([a], [b]) => parseInt(a) - parseInt(b))
              .map(([chain, signers]) => (
                <div
                  key={chain}
                  className="border-b border-gray-700 pb-2 last:border-0"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-white text-sm font-medium">
                      {getChainName(chain)}
                      {chain === chainId.toString() && (
                        <span className="ml-2 text-xs text-[#00ff00]">
                          (current)
                        </span>
                      )}
                    </span>
                    <span className="text-gray-400 text-xs">
                      {signers.length} signer{signers.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {signers.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {signers.map((signer, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 bg-gray-800 rounded text-xs font-mono text-gray-300"
                          title={signer}
                        >
                          {signer.slice(0, 6)}...{signer.slice(-4)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-gray-500 text-xs italic">
                      No active signers
                    </span>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Not Owner Warning */}
      {!isOwner && (
        <div className="mb-6 p-4 bg-yellow-900/20 border border-yellow-600/30 rounded-lg">
          <p className="text-yellow-500 font-medium">
            ⚠️ Owner Account Not Connected
          </p>
          <p className="text-gray-400 text-sm mt-1">
            Only the owner can manage signers. Please connect with the owner
            account:
          </p>
          <p className="text-gray-300 font-mono text-xs mt-2 break-all">
            {owner}
          </p>
        </div>
      )}

      {/* Check Signer Section - Always visible */}
      <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">
          Check Signer Status
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={signerToCheck}
            onChange={(e) => setSignerToCheck(e.target.value)}
            placeholder="Enter address to check (0x...)"
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-[#00ff00]"
          />
          <button
            onClick={() => refetchSigner()}
            disabled={!isValidAddress(signerToCheck) || signerLoading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-lg text-sm transition-colors"
          >
            Check
          </button>
        </div>
        {isValidAddress(signerToCheck) &&
          !signerLoading &&
          isSigner !== undefined && (
            <div
              className={`mt-3 p-2 rounded ${isSigner ? 'bg-green-900/30 border border-green-600/30' : 'bg-red-900/30 border border-red-600/30'}`}
            >
              <span className={isSigner ? 'text-green-500' : 'text-red-500'}>
                {isSigner
                  ? '✓ This address IS a signer'
                  : '✗ This address is NOT a signer'}
              </span>
            </div>
          )}
      </div>

      {/* Owner-only sections */}
      {isOwner && (
        <>
          {/* Add Signer */}
          <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">
              Add Signer
            </h3>
            <form onSubmit={handleAddSigner} className="space-y-3">
              <input
                type="text"
                value={newSignerAddress}
                onChange={(e) => setNewSignerAddress(e.target.value)}
                placeholder="New signer address (0x...)"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-[#00ff00]"
              />
              <button
                type="submit"
                disabled={
                  !isValidAddress(newSignerAddress) ||
                  addPending ||
                  addConfirming
                }
                className="w-full px-4 py-2 bg-[#00ff00] hover:bg-[#00dd00] disabled:bg-gray-700 disabled:text-gray-500 text-black font-medium rounded-lg text-sm transition-colors"
              >
                {addPending
                  ? 'Confirm in Wallet...'
                  : addConfirming
                    ? 'Adding...'
                    : 'Add Signer'}
              </button>
              {addSuccess && (
                <p className="text-green-500 text-sm">
                  ✓ Signer added successfully!
                </p>
              )}
              {addError && (
                <p className="text-red-500 text-sm">
                  ✗ Error: {addError.message}
                </p>
              )}
            </form>
          </div>

          {/* Remove Signer */}
          <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">
              Remove Signer
            </h3>
            <form onSubmit={handleRemoveSigner} className="space-y-3">
              <input
                type="text"
                value={signerToRemove}
                onChange={(e) => setSignerToRemove(e.target.value)}
                placeholder="Signer address to remove (0x...)"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-[#00ff00]"
              />
              <button
                type="submit"
                disabled={
                  !isValidAddress(signerToRemove) ||
                  removePending ||
                  removeConfirming
                }
                className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                {removePending
                  ? 'Confirm in Wallet...'
                  : removeConfirming
                    ? 'Removing...'
                    : 'Remove Signer'}
              </button>
              {removeSuccess && (
                <p className="text-green-500 text-sm">
                  ✓ Signer removed successfully!
                </p>
              )}
              {removeError && (
                <p className="text-red-500 text-sm">
                  ✗ Error: {removeError.message}
                </p>
              )}
            </form>
          </div>

          {/* Replace Signer */}
          <div className="p-4 bg-gray-900/50 rounded-lg border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">
              Replace Signer
            </h3>
            <form onSubmit={handleReplaceSigner} className="space-y-3">
              <input
                type="text"
                value={oldSignerAddress}
                onChange={(e) => setOldSignerAddress(e.target.value)}
                placeholder="Old signer address (0x...)"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-[#00ff00]"
              />
              <input
                type="text"
                value={replacementSignerAddress}
                onChange={(e) => setReplacementSignerAddress(e.target.value)}
                placeholder="New signer address (0x...)"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-[#00ff00]"
              />
              <button
                type="submit"
                disabled={
                  !isValidAddress(oldSignerAddress) ||
                  !isValidAddress(replacementSignerAddress) ||
                  replacePending ||
                  replaceConfirming
                }
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                {replacePending
                  ? 'Confirm in Wallet...'
                  : replaceConfirming
                    ? 'Replacing...'
                    : 'Replace Signer'}
              </button>
              {replaceSuccess && (
                <p className="text-green-500 text-sm">
                  ✓ Signer replaced successfully!
                </p>
              )}
              {replaceError && (
                <p className="text-red-500 text-sm">
                  ✗ Error: {replaceError.message}
                </p>
              )}
            </form>
          </div>
        </>
      )}
    </div>
  );
}

export default AllocatorAdmin;
