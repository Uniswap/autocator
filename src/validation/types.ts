// Enum for compact types matching the contract
export enum CompactCategory {
  Compact = 0,
  BatchCompact = 1,
  MultichainCompact = 2,
}

// Interface for incoming compact messages (from API)
export interface CompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: string | null; // Can be decimal or hex string
  expires: string; // Can be decimal or hex string
  id: string; // Can be decimal or hex string
  amount: string; // Can be decimal or hex string
  witnessTypeString: string | null;
  witnessHash: string | null;
}

// Interface for Lock structure in BatchCompact
export interface Lock {
  lockTag: string; // bytes12 as hex string
  token: string; // address
  amount: string; // Can be decimal or hex string
}

// Interface for incoming batch compact messages
export interface BatchCompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: string | null; // Can be decimal or hex string
  expires: string; // Can be decimal or hex string
  commitments: Lock[];
  witnessTypeString: string | null;
  witnessHash: string | null;
}

// Interface for Element structure in MultichainCompact
export interface Element {
  arbiter: string;
  chainId: string; // Can be decimal or hex string
  commitments: Lock[];
  witnessHash: string; // Witness hash for this element
}

// Interface for incoming multichain compact messages
export interface MultichainCompactMessage {
  sponsor: string;
  nonce: string | null; // Can be decimal or hex string
  expires: string; // Can be decimal or hex string
  elements: Element[];
  witnessTypeString: string; // Witness type string (shared across all elements)
}

// Interface for validated compact messages (internal use)
export interface ValidatedCompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: bigint;
  expires: bigint;
  id: bigint;
  amount: string;
  witnessTypeString: string | null;
  witnessHash: string | null;
}

// Interface for validated batch compact messages
export interface ValidatedBatchCompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: bigint;
  expires: bigint;
  commitments: {
    lockTag: string;
    token: string;
    amount: string;
  }[];
  witnessTypeString: string | null;
  witnessHash: string | null;
}

// Interface for validated multichain compact messages
export interface ValidatedMultichainCompactMessage {
  sponsor: string;
  nonce: bigint;
  expires: bigint;
  elements: {
    arbiter: string;
    chainId: bigint;
    commitments: {
      lockTag: string;
      token: string;
      amount: string;
    }[];
    witnessHash: string;
  }[];
  witnessTypeString: string;
}

// Union type for any compact message
export type AnyCompactMessage =
  | CompactMessage
  | BatchCompactMessage
  | MultichainCompactMessage;
export type AnyValidatedCompactMessage =
  | ValidatedCompactMessage
  | ValidatedBatchCompactMessage
  | ValidatedMultichainCompactMessage;

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// Helper to determine compact category from message structure
export function getCompactCategory(
  message: AnyCompactMessage
): CompactCategory {
  if ('elements' in message) {
    return CompactCategory.MultichainCompact;
  } else if ('commitments' in message) {
    return CompactCategory.BatchCompact;
  } else if ('id' in message) {
    return CompactCategory.Compact;
  }
  throw new Error('Unknown compact message type');
}
