// Enum for compact types matching the contract
export enum CompactCategory {
  Compact = 0,
  BatchCompact = 1,
  MultichainCompact = 2,
}

// Enum for nonce command types (HybridAllocator)
// The command byte is the first byte of the 32-byte nonce
export enum NonceCommand {
  ON_CHAIN = 0x01, // Nonce used for on-chain allocation
  OFF_CHAIN = 0x02, // Nonce used for off-chain (allocator-signed) allocation
  PERMIT2 = 0x03, // Nonce used for Permit2-based allocation
}

// Parsed nonce structure for HybridAllocator
export interface ParsedNonce {
  command: NonceCommand;
  sponsor: string; // 20-byte address
  fragment: bigint; // 11-byte nonce fragment
}

// Hybrid allocation context for off-chain authorization
export interface HybridAllocationContext {
  nonce: bigint;
  signature: string;
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

// ============================================================
// Permit2 Types
// ============================================================

// Permit2 contract address (same on all EVM chains)
export const PERMIT2_ADDRESS =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

// Token permission in Permit2 message
export interface TokenPermission {
  token: string;
  amount: string; // Can be decimal or hex string
}

// Deposit details for The Compact's batchDepositAndRegisterViaPermit2
export interface DepositDetails {
  nonce: string; // Permit2 nonce
  deadline: string; // Permit2 deadline (Unix timestamp)
  lockTag: string; // bytes12 lock tag for deposit
}

// BatchActivation witness structure for Permit2
export interface BatchActivationWitness {
  activator: string; // The Hybrid Allocator address
  ids: string[]; // Resource lock IDs (uint256[])
  compact: BatchCompactMessage; // The compact being registered
}

// Full Permit2 message structure
export interface Permit2Message {
  permitted: TokenPermission[]; // Token deposits
  spender: string; // The Compact address (recipient of tokens)
  nonce: string; // Permit2 nonce
  deadline: string; // Deadline for signature validity
  witness: BatchActivationWitness; // BatchActivation witness containing the compact
  depositLockTag: string; // The lockTag used for ALL deposits (bytes12 hex)
  // Note: All tokens in `permitted` are deposited with this SAME lockTag.
  // Only compact commitments with matching (lockTag, token) pairs can be offset.
}

// Structured Permit2 allocation request (updated from unknown)
export interface Permit2AllocationPayload {
  permit2Message: Permit2Message;
  signature: string; // Sponsor's signature on the Permit2 message
  mandateHash: string; // The mandate hash (bytes32) - used as witness hash in compact
  witnessTypeString: string; // The full witness type string for claim hash derivation
}

// Result of deposit vs commitment comparison
export interface DepositCommitmentDelta {
  lockTag: string;
  token: string;
  commitmentAmount: bigint;
  depositAmount: bigint;
  delta: bigint; // Positive means needs allocation, zero means fully covered
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
