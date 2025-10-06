import {
  useWriteContract,
  useChainId,
  usePublicClient,
  useWaitForTransactionReceipt,
  useAccount,
} from 'wagmi';
import { type Chain, formatUnits } from 'viem';
import {
  COMPACT_ABI,
  COMPACT_ADDRESS,
  isSupportedChain,
  type AllocatedTransfer,
} from '../constants/contracts';
import { useNotification } from './useNotification';
import {
  mainnet,
  optimism,
  optimismGoerli,
  sepolia,
  goerli,
  base,
  baseSepolia,
} from 'viem/chains';
import { unichain } from '../config/wagmi';
import { useState } from 'react';

const chains: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [optimism.id]: optimism,
  [optimismGoerli.id]: optimismGoerli,
  [sepolia.id]: sepolia,
  [goerli.id]: goerli,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [unichain.id]: unichain,
};

interface TokenInfo {
  decimals: number;
  symbol: string;
}

export function useAllocatedWithdrawal() {
  const chainId = useChainId();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const { writeContractAsync } = useWriteContract({
    mutation: {
      onError: (error) => {
        if (
          error instanceof Error &&
          !error.message.toLowerCase().includes('user rejected')
        ) {
          showNotification({
            type: 'error',
            title: 'Transaction Failed',
            message: error.message,
            autoHide: true,
          });
        }
      },
    },
  });
  const { showNotification } = useNotification();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash,
      onReplaced: (replacement) => {
        showNotification({
          type: 'info',
          title: 'Transaction Replaced',
          message: `Transaction was ${replacement.reason}. Waiting for new transaction...`,
          txHash: replacement.transaction.hash,
          chainId,
          autoHide: false,
        });
      },
    });

  const allocatedWithdrawal = async (
    transferPayload: AllocatedTransfer,
    tokenInfo?: TokenInfo
  ) => {
    if (!publicClient) throw new Error('Public client not available');
    if (!address) throw new Error('Wallet not connected');

    if (!isSupportedChain(chainId)) {
      throw new Error('Unsupported chain');
    }

    const chain = chains[chainId];
    if (!chain) {
      throw new Error('Chain configuration not found');
    }

    // Generate a temporary transaction ID for linking notifications
    const tempTxId = `pending-${Date.now()}`;

    // Calculate total amount from recipients
    const totalAmount = transferPayload.recipients.reduce(
      (sum, recipient) => sum + recipient.amount,
      BigInt(0)
    );

    // Format the amount using the token's decimals and symbol if provided, otherwise use a generic format
    const displayAmount = tokenInfo
      ? `${formatUnits(totalAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`
      : `${formatUnits(totalAmount, 18)} ETH`; // Default to ETH format

    try {
      // Submit the transaction with the server signature
      showNotification({
        type: 'info',
        title: 'Initiating Withdrawal',
        message: `Waiting for transaction submission of ${displayAmount}...`,
        stage: 'initiated',
        txHash: tempTxId,
        chainId,
        autoHide: false,
      });

      // For withdrawals, we need to encode the recipient with bytes12(0) as the lockTag
      // The transferPayload recipients should already have the claimant field properly encoded
      const newHash = await writeContractAsync({
        address: COMPACT_ADDRESS as `0x${string}`,
        abi: [COMPACT_ABI.find((x) => x.name === 'allocatedTransfer')] as const,
        functionName: 'allocatedTransfer',
        args: [transferPayload],
      });

      showNotification({
        type: 'success',
        title: 'Transaction Submitted',
        message: 'Waiting for confirmation...',
        stage: 'submitted',
        txHash: newHash,
        chainId,
        autoHide: true,
      });

      setHash(newHash);

      // Start watching for confirmation but don't wait for it
      void publicClient
        .waitForTransactionReceipt({
          hash: newHash,
        })
        .then((receipt) => {
          if (receipt.status === 'success') {
            showNotification({
              type: 'success',
              title: 'Withdrawal Confirmed',
              message: `Successfully withdrew ${displayAmount}`,
              stage: 'confirmed',
              txHash: newHash,
              chainId,
              autoHide: false,
            });
          }
        });

      // Return the hash immediately after submission
      return newHash;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes('user rejected')
      ) {
        showNotification({
          type: 'error',
          title: 'Transaction Rejected',
          message: 'You rejected the transaction',
          txHash: tempTxId,
          chainId,
          autoHide: true,
        });
      }
      throw error;
    }
  };

  return {
    allocatedWithdrawal,
    isConfirming,
    isConfirmed,
  };
}
