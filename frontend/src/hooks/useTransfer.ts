import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import {
  parseUnits,
  isAddress,
  signatureToCompactSignature,
  serializeCompactSignature,
  parseSignature,
} from 'viem';
import { useNotification } from '../hooks/useNotification';
import { useAllocatedTransfer } from '../hooks/useAllocatedTransfer';
import { useAllocatedWithdrawal } from '../hooks/useAllocatedWithdrawal';
import { useConsumedNonce } from '../hooks/useConsumedNonce';
import { useAllocatorAPI } from '../hooks/useAllocatorAPI';
import { COMPACT_ADDRESS } from '../constants/contracts';
import { getChainName } from '../utils/chains';
import {
  encodeWithdrawalClaimant,
  encodeTransferClaimant,
} from '../utils/claimant';

interface FormData {
  expires: string;
  recipient: string;
  amount: string;
  allocatorSignature?: string;
  nonce?: string;
  hash?: string;
}

interface WalletError extends Error {
  code: number;
}

interface EthereumProvider {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
}

interface FieldErrors {
  [key: string]: string | undefined;
}

// Constants for time limits
const TWO_HOURS_SECONDS = 7200; // 2 hours in seconds

export function useTransfer(
  targetChainId: string,
  resourceLockBalance: string,
  lockId: bigint,
  decimals: number,
  _tokenName: {
    resourceLockName: string;
    resourceLockSymbol: string;
    tokenName: string;
  },
  tokenSymbol: string,
  _withdrawalStatus: number,
  onForceWithdraw: () => void,
  onDisableForceWithdraw: () => void,
  balanceAvailableToAllocate: string,
  resetPeriod: number
) {
  const { address } = useAccount();
  const currentChainId = useChainId();
  const [isOpen, setIsOpen] = useState(false);
  const [isWithdrawal, setIsWithdrawal] = useState(false);
  const [isWithdrawalLoading, setIsWithdrawalLoading] = useState(false);
  const [isRequestingAllocation, setIsRequestingAllocation] = useState(false);
  const [hasAllocation, setHasAllocation] = useState(false);
  const [formData, setFormData] = useState<FormData>({
    expires: '',
    recipient: '',
    amount: '',
  });

  const { allocatedTransfer, isConfirming: isTransferLoading } =
    useAllocatedTransfer();
  const { allocatedWithdrawal, isConfirming: isWithdrawalConfirming } =
    useAllocatedWithdrawal();
  const { showNotification } = useNotification();
  const { signTypedDataAsync } = useSignTypedData();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const [customExpiry, setCustomExpiry] = useState(false);
  const [expiryOption, setExpiryOption] = useState('10min');

  // Get allocator address for nonce checking
  const { allocatorAddress } = useAllocatorAPI();

  // Check if nonce has been consumed using indexer
  const { isConsumed: isNonceConsumed } = useConsumedNonce(
    allocatorAddress || undefined,
    targetChainId,
    formData.nonce
  );

  // Reset form state
  const resetForm = useCallback(() => {
    setFormData({
      expires: '',
      recipient: '',
      amount: '',
    });
    setHasAllocation(false);
    setCustomExpiry(false);
    setExpiryOption('10min');
    setFieldErrors({});
    setIsOpen(false);
  }, []);

  // Initialize default expiry on mount
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    setFormData((prev: FormData) => ({
      ...prev,
      expires: (now + 600).toString(),
    })); // 10 minutes default
  }, []);

  // Validation functions
  const validateAmount = useCallback(() => {
    if (!formData.amount || hasAllocation) return null;

    try {
      // Check if amount is zero or negative
      const numAmount = parseFloat(formData.amount);
      if (numAmount <= 0) {
        return { type: 'error', message: 'Amount must be greater than zero.' };
      }

      // Check decimal places
      const decimalParts = formData.amount.split('.');
      if (decimalParts.length > 1 && decimalParts[1].length > decimals) {
        return {
          type: 'error',
          message: `Invalid amount (greater than ${decimals} decimals).`,
        };
      }

      // Parse amounts for comparison
      const parsedAmount = parseUnits(formData.amount, decimals);
      const balanceBigInt = BigInt(resourceLockBalance || '0');
      const availableToAllocateBigInt = BigInt(
        balanceAvailableToAllocate || '0'
      );

      // First check if amount exceeds total balance
      if (parsedAmount > balanceBigInt) {
        return { type: 'error', message: 'Amount exceeds available balance.' };
      }

      // Then check if amount exceeds available to allocate
      if (parsedAmount > availableToAllocateBigInt) {
        return {
          type: 'error',
          message:
            'Amount exceeds balance currently available to allocate. Wait for pending allocations to clear or initiate a forced withdrawal.',
        };
      }

      return null;
    } catch {
      return { type: 'error', message: 'Invalid amount format.' };
    }
  }, [
    formData.amount,
    decimals,
    resourceLockBalance,
    balanceAvailableToAllocate,
    hasAllocation,
  ]);

  const validateRecipient = useCallback(() => {
    if (!formData.recipient || hasAllocation) return null;
    if (!isAddress(formData.recipient)) {
      return { type: 'error', message: 'Invalid address format.' };
    }
    return null;
  }, [formData.recipient, hasAllocation]);

  const validateExpiry = useCallback(
    (value: string) => {
      if (!value || hasAllocation) return null;

      const expiryTime = parseInt(value);
      const now = Math.floor(Date.now() / 1000);

      if (isNaN(expiryTime)) {
        return { type: 'error', message: 'Invalid expiry time.' };
      }

      if (expiryTime <= now) {
        return { type: 'error', message: 'Expiry time must be in the future.' };
      }

      const duration = expiryTime - now;

      // Check if duration exceeds 2 hours
      if (duration > TWO_HOURS_SECONDS) {
        return {
          type: 'error',
          message: 'Expiry cannot be more than 2 hours in the future.',
        };
      }

      // Check if expiry would exceed when tokens could be withdrawn
      // Ensure expiry is within reset period
      const resetPeriodSeconds = resetPeriod
        ? parseInt(String(resetPeriod))
        : undefined;
      const maxExpiryTime = resetPeriodSeconds
        ? Math.min(now + resetPeriodSeconds, now + TWO_HOURS_SECONDS)
        : now + TWO_HOURS_SECONDS;

      if (expiryTime > maxExpiryTime) {
        const timeLimit = resetPeriodSeconds
          ? Math.min(resetPeriodSeconds, TWO_HOURS_SECONDS)
          : TWO_HOURS_SECONDS;
        return {
          type: 'error',
          message: `Expiry cannot exceed ${Math.floor(timeLimit / 60)} minutes from now.`,
        };
      }

      return null;
    },
    [resetPeriod, hasAllocation]
  );

  // Update field errors when recipient changes
  useEffect(() => {
    if (!hasAllocation) {
      const recipientValidation = validateRecipient();
      setFieldErrors((prev: FieldErrors) => ({
        ...prev,
        recipient: recipientValidation?.message,
      }));
    }
  }, [formData.recipient, validateRecipient, hasAllocation]);

  // Update error message when nonce consumption status changes
  const nonceError = useMemo(() => {
    if (!formData.nonce) return undefined;
    if (isNonceConsumed) {
      return 'This nonce has already been consumed.';
    }
    return undefined;
  }, [isNonceConsumed, formData.nonce]);

  // Update field errors when nonce error changes
  useEffect(() => {
    setFieldErrors((prev: FieldErrors) => ({
      ...prev,
      nonce: nonceError,
    }));
  }, [nonceError]);

  // Update field errors when expiry changes
  useEffect(() => {
    if (!hasAllocation) {
      const expiryValidation = validateExpiry(formData.expires);
      setFieldErrors((prev: FieldErrors) => ({
        ...prev,
        expires: expiryValidation?.message,
      }));
    }
  }, [formData.expires, validateExpiry, hasAllocation]);

  const isFormValid = useMemo(() => {
    if (hasAllocation) return true;

    // Basic form validation
    if (!formData.expires || !formData.recipient || !formData.amount) {
      return false;
    }

    // Check for any field errors
    if (Object.values(fieldErrors).some((error) => error !== undefined)) {
      return false;
    }

    // Check amount validation
    const amountValidation = validateAmount();
    if (amountValidation?.type === 'error') {
      return false;
    }

    return true;
  }, [formData, fieldErrors, validateAmount, hasAllocation]);

  const handleAction = async (
    action: 'transfer' | 'withdraw' | 'force' | 'disable'
  ) => {
    // Check if we need to switch networks
    const targetChainIdNumber = parseInt(targetChainId);
    if (targetChainIdNumber !== currentChainId) {
      const tempTxId = `network-switch-${Date.now()}`;
      try {
        showNotification({
          type: 'info',
          title: 'Switching Network',
          message: `Please confirm the network switch in your wallet...`,
          txHash: tempTxId,
          chainId: targetChainIdNumber,
          autoHide: false,
        });

        // Request network switch through the wallet
        const ethereum = window.ethereum as EthereumProvider | undefined;
        if (!ethereum) {
          throw new Error('No wallet detected');
        }

        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${targetChainIdNumber.toString(16)}` }],
        });

        // Wait a bit for the network switch to complete
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Replace the switching notification with switched
        showNotification({
          type: 'success',
          title: 'Network Switched',
          message: `Successfully switched to ${getChainName(targetChainId)}`,
          txHash: tempTxId,
          chainId: targetChainIdNumber,
          autoHide: true,
        });
      } catch (switchError) {
        // This error code indicates that the chain has not been added to MetaMask
        if ((switchError as WalletError).code === 4902) {
          showNotification({
            type: 'error',
            title: 'Network Not Found',
            message: 'Please add this network to your wallet first.',
            txHash: tempTxId,
            chainId: targetChainIdNumber,
            autoHide: true,
          });
        } else {
          console.error('Error switching network:', switchError);
          showNotification({
            type: 'error',
            title: 'Network Switch Failed',
            message:
              switchError instanceof Error
                ? switchError.message
                : 'Failed to switch network. Please switch manually.',
            txHash: tempTxId,
            chainId: targetChainIdNumber,
            autoHide: true,
          });
        }
        return;
      }
    }

    // Check if we have a valid address before proceeding
    if (!address) {
      showNotification({
        type: 'error',
        title: 'Error',
        message: 'Please connect your wallet first',
      });
      return;
    }

    if (action === 'force') {
      onForceWithdraw();
    } else if (action === 'disable') {
      setIsWithdrawalLoading(true);
      onDisableForceWithdraw();
      setIsWithdrawalLoading(false);
    } else {
      setIsWithdrawal(action === 'withdraw');
      setIsOpen(true);
    }
  };

  const handleRequestAllocation = async () => {
    if (!isFormValid || !address) {
      if (!address) {
        showNotification({
          type: 'error',
          title: 'Wallet Required',
          message: 'Please connect your wallet first',
        });
      }
      return;
    }

    try {
      setIsRequestingAllocation(true);

      // Step 1: Request nonce from the server
      const nonceResponse = await fetch(
        `/suggested-nonce/${targetChainId}/${address}`
      );
      if (!nonceResponse.ok) {
        throw new Error('Failed to get nonce from server');
      }
      const { nonce } = await nonceResponse.json();

      console.log(`got nonce: ${nonce}`);

      // Step 2: Build the compact payload
      const compact = {
        arbiter: address as `0x${string}`,
        sponsor: address as `0x${string}`,
        nonce,
        expires: formData.expires,
        id: lockId.toString(),
        amount: parseUnits(formData.amount, decimals).toString(),
        witnessTypeString: null,
        witnessHash: null,
      };

      // Step 3: Get user signature
      // Create the EIP-712 payload
      const domain = {
        name: 'The Compact',
        version: '0',
        chainId: BigInt(targetChainId),
        verifyingContract: COMPACT_ADDRESS as `0x${string}`,
      };

      console.log('Domain for signing:', {
        ...domain,
        chainId: domain.chainId.toString(),
        verifyingContract: domain.verifyingContract,
      });

      // Define the types for EIP-712 signing
      const types = {
        Compact: [
          { name: 'arbiter', type: 'address' },
          { name: 'sponsor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expires', type: 'uint256' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
      };

      // Prepare the message for signing
      const message = {
        arbiter: compact.arbiter,
        sponsor: compact.sponsor,
        nonce: BigInt(compact.nonce),
        expires: BigInt(compact.expires),
        id: BigInt(compact.id),
        amount: BigInt(compact.amount),
      };

      console.log('prepared message for sponsor signature:', {
        arbiter: message.arbiter,
        sponsor: message.sponsor,
        nonce: message.nonce.toString(),
        expires: message.expires.toString(),
        id: message.id.toString(),
        amount: message.amount.toString(),
      });

      // Sign the message using wagmi's signTypedDataAsync
      const userSignature = await signTypedDataAsync({
        domain,
        message,
        primaryType: 'Compact',
        types,
      });

      console.log('Original user signature:', userSignature);
      // Convert to compact signature if needed
      let compactUserSignature = userSignature;
      if (userSignature.length === 132) {
        console.log('Converting signature to compact format...');
        const parsedSig = parseSignature(userSignature);
        const compactSig = signatureToCompactSignature(parsedSig);
        compactUserSignature = serializeCompactSignature(compactSig);
        console.log('Serialized compact signature:', compactUserSignature);
      }

      // Step 4: Submit the payload to the server to get the server signature
      const payload = {
        chainId: targetChainId,
        compact: {
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          id: compact.id,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        sponsorSignature: compactUserSignature,
      };

      console.log('Sending payload to server:', payload);

      const serverResponse = await fetch('/compact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!serverResponse.ok) {
        const errorData = await serverResponse
          .json()
          .catch(() => ({ error: 'Unknown error' }));
        throw new Error(
          errorData.error || `Server error: ${serverResponse.statusText}`
        );
      }

      const response = await serverResponse.json();
      console.log('Server response:', response);

      setFormData((prev: FormData) => ({
        ...prev,
        allocatorSignature: response.signature,
        nonce: response.nonce,
        hash: response.hash,
      }));

      setHasAllocation(true);
      showNotification({
        type: 'success',
        title: isWithdrawal ? 'Withdrawal Authorized' : 'Transfer Authorized',
        message: `Successfully authorized ${isWithdrawal ? 'withdrawal' : 'transfer'}. You can now submit the transaction.`,
      });
    } catch (error) {
      console.error('Error authorizing operation:', error);
      showNotification({
        type: 'error',
        title: isWithdrawal
          ? 'Withdrawal Authorization Failed'
          : 'Transfer Authorization Failed',
        message:
          error instanceof Error
            ? error.message
            : `Failed to authorize ${isWithdrawal ? 'withdrawal' : 'transfer'}`,
      });
    } finally {
      setIsRequestingAllocation(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || !formData.allocatorSignature || !formData.nonce) return;

    try {
      // Validate recipient
      if (!formData.recipient?.startsWith('0x')) {
        throw new Error('Recipient must be a valid address starting with 0x');
      }

      try {
        // Prepare the AllocatedTransfer struct with the new format
        const amount = parseUnits(formData.amount, decimals);
        const recipient = formData.recipient as `0x${string}`;

        // For withdrawals, use bytes12(0) as the lockTag
        // For transfers, extract the lockTag from the resource lock id
        let claimant: bigint;
        if (isWithdrawal) {
          claimant = encodeWithdrawalClaimant(recipient);
        } else {
          // Extract lockTag from the resource lock id (first 12 bytes of the id)
          // The id is constructed as: keccak256(abi.encodePacked(token, lockTag))
          // For now, we'll use a simple approach - you may need to adjust based on your exact needs
          const lockTagHex = ('0x' +
            lockId
              .toString(16)
              .padStart(64, '0')
              .slice(0, 24)) as `0x${string}`;
          claimant = encodeTransferClaimant(lockTagHex, recipient);
        }

        const transfer = {
          allocatorData: formData.allocatorSignature as `0x${string}`,
          nonce: BigInt(formData.nonce!),
          expires: BigInt(formData.expires),
          id: lockId,
          recipients: [
            {
              claimant,
              amount,
            },
          ],
        };

        // Pass token information along with the transfer
        const tokenInfo = {
          decimals,
          symbol: tokenSymbol,
        };

        // Log inputs for debugging
        console.log('Transaction inputs before submission:', {
          currentChainId,
          targetChainId,
          transfer: {
            ...transfer,
            nonce: transfer.nonce.toString(),
            expires: transfer.expires.toString(),
            id: transfer.id.toString(),
            recipients: transfer.recipients.map((r) => ({
              claimant: r.claimant.toString(),
              amount: r.amount.toString(),
            })),
          },
          tokenInfo,
        });

        // Submit transfer or withdrawal (both use allocatedTransfer now)
        if (isWithdrawal) {
          const hash = await allocatedWithdrawal(transfer, tokenInfo);
          if (hash) {
            showNotification({
              type: 'success',
              title: 'Withdrawal Submitted',
              message: 'Your withdrawal has been submitted successfully.',
              txHash: hash,
              chainId: currentChainId,
              autoHide: true,
            });
            resetForm(); // Reset form immediately after getting transaction hash
          }
        } else {
          const hash = await allocatedTransfer(transfer, tokenInfo);
          if (hash) {
            showNotification({
              type: 'success',
              title: 'Transfer Submitted',
              message: 'Your transfer has been submitted successfully.',
              txHash: hash,
              chainId: currentChainId,
              autoHide: true,
            });
            resetForm(); // Reset form immediately after getting transaction hash
          }
        }
      } catch (conversionError) {
        console.error('Error converting values:', conversionError);
        throw new Error(
          'Failed to convert input values. Please check all fields are valid.'
        );
      }
    } catch (error) {
      console.error('Error submitting transfer:', error);
      showNotification({
        type: 'error',
        title: isWithdrawal ? 'Withdrawal Failed' : 'Transfer Failed',
        message:
          error instanceof Error
            ? error.message
            : `Failed to submit ${isWithdrawal ? 'withdrawal' : 'transfer'}`,
      });
    }
  };

  const handleExpiryChange = (value: string) => {
    setExpiryOption(value);
    const now = Math.floor(Date.now() / 1000);
    let newExpiry: string = '';

    if (value === 'custom') {
      setCustomExpiry(true);
      return;
    }

    setCustomExpiry(false);
    switch (value) {
      case '1min':
        newExpiry = (now + 60).toString();
        break;
      case '5min':
        newExpiry = (now + 300).toString();
        break;
      case '10min':
        newExpiry = (now + 600).toString();
        break;
      case '1hour':
        newExpiry = (now + 3600).toString();
        break;
    }

    if (newExpiry) {
      setFormData((prev: FormData) => ({ ...prev, expires: newExpiry }));
      setFieldErrors((prev: FieldErrors) => ({ ...prev, expires: undefined }));
    }
  };

  const handleExpiryInputChange = (value: string) => {
    const validation = validateExpiry(value);
    setFieldErrors((prev: FieldErrors) => ({
      ...prev,
      expires: validation?.message,
    }));
    setFormData((prev: FormData) => ({
      ...prev,
      expires: value,
    }));
  };

  const handleRecipientChange = (value: string) => {
    setFormData((prev: FormData) => ({
      ...prev,
      recipient: value,
    }));
  };

  const handleAmountChange = (value: string) => {
    setFormData((prev: FormData) => ({
      ...prev,
      amount: value,
    }));
  };

  return {
    isOpen,
    setIsOpen,
    isWithdrawal,
    isWithdrawalLoading,
    isRequestingAllocation,
    hasAllocation,
    formData,
    fieldErrors,
    customExpiry,
    expiryOption,
    isTransferLoading,
    isWithdrawalConfirming,
    isFormValid,
    validateAmount,
    handleAction,
    handleRequestAllocation,
    handleSubmit,
    handleExpiryChange,
    handleExpiryInputChange,
    handleRecipientChange,
    handleAmountChange,
  };
}
