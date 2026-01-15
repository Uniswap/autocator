import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useBalances } from './useBalances';
import { useNotification } from './useNotification';
import { useAllocatorAPI } from './useAllocatorAPI';
import { parseUnits } from 'viem';
import {
  KNOWN_ARBITERS,
  CUSTOM_ARBITER_OPTION,
  TRIBUNAL_ADDRESS,
  type ArbiterOption,
} from '../constants/contracts';
import {
  NonceCommand,
  constructHybridNonce,
  generateRandomFragment,
} from './useHybridAllocator';

interface Token {
  tokenAddress: string;
  name: string;
  symbol: string;
  decimals: number;
}

interface ResourceLock {
  resetPeriod: number;
  isMultichain: boolean;
}

interface Balance {
  chainId: string;
  lockId: string;
  allocatableBalance: string;
  allocatedBalance: string;
  balanceAvailableToAllocate: string;
  withdrawalStatus: number;
  withdrawableAt: string;
  balance: string;
  tokenName: string;
  token?: Token;
  resourceLock?: ResourceLock;
  formattedAllocatableBalance?: string;
  decimals: number;
  symbol: string;
}

export const EXPIRY_OPTIONS = [
  { label: '1 minute', value: '1min', seconds: 60 },
  { label: '10 minutes', value: '10min', seconds: 600 },
  { label: '1 hour', value: '1hour', seconds: 3600 },
  { label: 'Custom', value: 'custom', seconds: 0 },
];

export function useCreateAllocation() {
  const { address, isConnected } = useAccount();
  const { balances, isLoading: isLoadingBalances } = useBalances();
  const { showNotification } = useNotification();
  const { createAllocation, getResourceLockDecimals } = useAllocatorAPI();

  const [formData, setFormData] = useState({
    lockId: '',
    amount: '',
    arbiterAddress: TRIBUNAL_ADDRESS as string, // Default to Tribunal
    nonce: '',
    expiration: '',
    witnessHash: '',
    witnessTypestring: '',
  });

  const [errors, setErrors] = useState({
    lockId: '',
    amount: '',
    arbiterAddress: '',
    nonce: '',
    expiration: '',
  });

  const [showWitnessFields, setShowWitnessFields] = useState(false);
  const [selectedLock, setSelectedLock] = useState<Balance | null>(null);
  const [lockDecimals, setLockDecimals] = useState<number>(18);
  const [expiryOption, setExpiryOption] = useState('10min');
  const [customExpiry, setCustomExpiry] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Arbiter selection state
  const [selectedArbiter, setSelectedArbiter] = useState<ArbiterOption>(
    KNOWN_ARBITERS[0] // Default to Tribunal
  );
  const [showCustomArbiter, setShowCustomArbiter] = useState(false);
  const [customArbiterAddress, setCustomArbiterAddress] = useState('');

  // All available arbiter options including custom
  const arbiterOptions: ArbiterOption[] = [
    ...KNOWN_ARBITERS,
    CUSTOM_ARBITER_OPTION,
  ];

  // Generate a hybrid nonce with OFF_CHAIN command byte
  const generateNewNonce = useCallback(() => {
    if (address) {
      try {
        const fragment = generateRandomFragment();
        const nonce = constructHybridNonce(
          NonceCommand.OFF_CHAIN,
          address as `0x${string}`,
          fragment
        );
        const nonceHex = `0x${nonce.toString(16).padStart(64, '0')}`;
        setFormData((prev) => ({ ...prev, nonce: nonceHex }));
      } catch (error) {
        console.error('Error generating nonce:', error);
        // Fallback to simple random nonce if hybrid construction fails
        const addressBytes = address.slice(2);
        const randomBytes = Array.from({ length: 24 }, () =>
          Math.floor(Math.random() * 16).toString(16)
        ).join('');
        const nonce = `0x${addressBytes}${randomBytes}`;
        setFormData((prev) => ({ ...prev, nonce }));
      }
    }
  }, [address]);

  useEffect(() => {
    if (address) {
      generateNewNonce();
    }
  }, [address, generateNewNonce]);

  useEffect(() => {
    if (selectedLock) {
      getResourceLockDecimals(selectedLock.chainId, selectedLock.lockId)
        .then((decimals) => setLockDecimals(decimals))
        .catch(console.error);
    }
  }, [selectedLock, getResourceLockDecimals]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));

    if (name === 'lockId') {
      const lock = balances.find((b) => b.lockId === value);
      if (lock) {
        setSelectedLock({
          ...lock,
          balance: lock.allocatableBalance,
          tokenName: lock.token?.name || '',
          decimals: lock.token?.decimals || 18,
          symbol: lock.token?.symbol || '',
        });
      } else {
        setSelectedLock(null);
      }
    }
  };

  const handleExpiryChange = (value: string) => {
    setExpiryOption(value);

    if (value === 'custom') {
      setCustomExpiry(true);
      return;
    }

    setCustomExpiry(false);
    // For non-custom options, we'll calculate the expiration at submission time
    setFormData((prev) => ({
      ...prev,
      expiration: '', // Clear any custom expiration
    }));
    setErrors((prev) => ({ ...prev, expiration: '' }));
  };

  // Handle arbiter selection from dropdown
  const handleArbiterChange = (arbiterAddress: string) => {
    // Check if this is a known arbiter or custom option
    const knownArbiter = arbiterOptions.find(
      (a) => a.address.toLowerCase() === arbiterAddress.toLowerCase()
    );

    if (knownArbiter && !knownArbiter.isCustom) {
      // Selected a known arbiter
      setSelectedArbiter(knownArbiter);
      setShowCustomArbiter(false);
      setFormData((prev) => ({
        ...prev,
        arbiterAddress: knownArbiter.address,
      }));
      setErrors((prev) => ({ ...prev, arbiterAddress: '' }));
    } else if (arbiterAddress === 'custom') {
      // Selected custom option
      setSelectedArbiter(CUSTOM_ARBITER_OPTION);
      setShowCustomArbiter(true);
      setFormData((prev) => ({
        ...prev,
        arbiterAddress: customArbiterAddress,
      }));
    } else {
      // Direct address input (for custom arbiter)
      setCustomArbiterAddress(arbiterAddress);
      setFormData((prev) => ({ ...prev, arbiterAddress }));
      setErrors((prev) => ({ ...prev, arbiterAddress: '' }));
    }
  };

  // Handle custom arbiter address input
  const handleCustomArbiterChange = (address: string) => {
    setCustomArbiterAddress(address);
    setFormData((prev) => ({ ...prev, arbiterAddress: address }));
    setErrors((prev) => ({ ...prev, arbiterAddress: '' }));
  };

  const getExpirationTime = () => {
    if (customExpiry) {
      return formData.expiration;
    }

    const now = Math.floor(Date.now() / 1000);
    const option = EXPIRY_OPTIONS.find((opt) => opt.value === expiryOption);
    return option ? (now + option.seconds).toString() : '';
  };

  const validateForm = () => {
    const newErrors = {
      lockId: '',
      amount: '',
      arbiterAddress: '',
      nonce: '',
      expiration: '',
    };

    if (!formData.lockId) {
      newErrors.lockId = 'Resource lock is required';
    }

    if (!formData.amount) {
      newErrors.amount = 'Amount is required';
    } else if (selectedLock) {
      try {
        const amountBigInt = parseUnits(formData.amount, lockDecimals);
        const availableBigInt = BigInt(selectedLock.balanceAvailableToAllocate);
        if (amountBigInt > availableBigInt) {
          newErrors.amount = 'Amount exceeds available balance';
        }
      } catch {
        newErrors.amount = 'Invalid amount';
      }
    }

    if (!formData.arbiterAddress) {
      newErrors.arbiterAddress = 'Arbiter address is required';
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(formData.arbiterAddress)) {
      newErrors.arbiterAddress = 'Invalid address format';
    }

    if (!formData.nonce) {
      newErrors.nonce = 'Nonce is required';
    }

    const expirationTime = customExpiry
      ? formData.expiration
      : getExpirationTime();
    if (!expirationTime) {
      newErrors.expiration = 'Expiration is required';
    } else {
      const expTime = parseInt(expirationTime);
      const now = Math.floor(Date.now() / 1000);
      if (isNaN(expTime) || expTime <= now) {
        newErrors.expiration = 'Expiration must be in the future';
      }
    }

    setErrors(newErrors);
    return Object.values(newErrors).every((error) => !error);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm() || !selectedLock || !address) return;

    try {
      setIsSubmitting(true);

      const request = {
        chainId: selectedLock.chainId.toString(),
        compact: {
          arbiter: formData.arbiterAddress as `0x${string}`,
          sponsor: address,
          nonce: formData.nonce,
          expires: getExpirationTime(), // Calculate fresh expiration time at submission
          id: selectedLock.lockId,
          amount: parseUnits(formData.amount, lockDecimals).toString(),
          ...(showWitnessFields && {
            witnessTypeString: formData.witnessTypestring,
            witnessHash: formData.witnessHash,
          }),
        },
      };

      const result = await createAllocation(request);

      showNotification({
        type: 'success',
        title: 'Allocation Created',
        message: `Successfully created allocation with hash: ${result.hash}`,
      });

      // Reset form but keep Tribunal as default arbiter
      setFormData({
        lockId: '',
        amount: '',
        arbiterAddress: TRIBUNAL_ADDRESS,
        nonce: '',
        expiration: '',
        witnessHash: '',
        witnessTypestring: '',
      });
      setSelectedArbiter(KNOWN_ARBITERS[0]);
      setShowCustomArbiter(false);
      setCustomArbiterAddress('');
      setShowWitnessFields(false);
      generateNewNonce();
    } catch (error) {
      showNotification({
        type: 'error',
        title: 'Error',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to create allocation',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    formData,
    errors,
    showWitnessFields,
    selectedLock,
    lockDecimals,
    expiryOption,
    customExpiry,
    isSubmitting,
    isConnected,
    isLoadingBalances,
    balances,
    handleInputChange,
    handleExpiryChange,
    handleSubmit,
    generateNewNonce,
    setShowWitnessFields,
    // Arbiter selection exports
    selectedArbiter,
    showCustomArbiter,
    customArbiterAddress,
    arbiterOptions,
    handleArbiterChange,
    handleCustomArbiterChange,
  };
}
