# Autocator Update Plan: HybridAllocator Support

This document outlines the comprehensive changes required to update Autocator to support the new **HybridAllocator** contract, **The Compact V1** (already partially supported), the updated **V1 indexer**, and the **Tribunal** arbiter.

---

## Code Quality Requirements

**Before any phase is considered complete, ALL of the following must pass:**

### 1. TypeScript Compilation

```bash
pnpm type-check
```

Must exit with code 0 (no type errors).

### 2. ESLint

```bash
pnpm lint
```

Must exit with code 0 (no lint errors or warnings).

### 3. Prettier Formatting

```bash
pnpm format:check
```

Must exit with code 0. If formatting issues exist, run `pnpm format` to fix them.

### 4. Unit Tests

```bash
pnpm test
```

All tests must pass. The test command automatically includes `NODE_OPTIONS='--experimental-vm-modules --no-warnings'` which is required for PGlite compatibility.

### 5. Smoke Test (for API changes)

```bash
pnpm smoke-test
```

Basic integration smoke test for the API.

### Quick Check Command

Run all checks in sequence:

```bash
pnpm lint && pnpm type-check && pnpm format:check && pnpm test
```

---

## Table of Contents

1. [Overview of Changes](#overview-of-changes)
2. [Implementation Progress](#implementation-progress)
3. [Contract Addresses & Endpoints](#contract-addresses--endpoints)
4. [Data Structure Changes](#data-structure-changes)
5. [Backend Changes](#backend-changes)
6. [Frontend Changes](#frontend-changes)
7. [GraphQL/Indexer Integration Changes](#graphqlindexer-integration-changes)
8. [Cryptographic & Signature Changes](#cryptographic--signature-changes)
9. [Database Schema Changes](#database-schema-changes)
10. [New Features to Implement](#new-features-to-implement)
11. [Migration Considerations](#migration-considerations)

---

## Implementation Progress

### Completed Work (Phase 1 & 2)

#### ✅ Phase 1: Core Data Structures

| Task                                    | Status             | File(s) Modified                           |
| --------------------------------------- | ------------------ | ------------------------------------------ |
| Add `Lock` interface                    | ✅ Already existed | `src/validation/types.ts`                  |
| Add `NonceCommand` enum                 | ✅ Complete        | `src/validation/types.ts`                  |
| Add `ParsedNonce` interface             | ✅ Complete        | `src/validation/types.ts`                  |
| Add `HybridAllocationContext` interface | ✅ Complete        | `src/validation/types.ts`                  |
| Create nonce utilities                  | ✅ Complete        | `src/validation/hybrid-nonce.ts` (NEW)     |
| Claim hash for Lock-based BatchCompact  | ✅ Already existed | `src/crypto.ts`                            |
| Commitments hash generation             | ✅ Already existed | `src/crypto.ts` (`generateBatchClaimHash`) |

**New File Created: `src/validation/hybrid-nonce.ts`**

- `constructHybridNonce(command, sponsor, fragment)` - Build nonces with command byte + sponsor + fragment
- `parseHybridNonce(nonce)` - Extract components from nonce
- `validateHybridNonce(nonce, sponsor, expectedCommand?)` - Verify sponsor and command type
- `isOffChainNonce(nonce)`, `isOnChainNonce(nonce)`, `isPermit2Nonce(nonce)` - Command type checks
- `hybridNonceToHex(nonce)`, `hexToHybridNonce(hex)` - Hex conversion utilities

#### ✅ Phase 2: Backend Integration

| Task                                     | Status      | File(s) Modified                  |
| ---------------------------------------- | ----------- | --------------------------------- |
| Add HybridAllocator & Tribunal addresses | ✅ Complete | `src/validation/arbiter.ts` (NEW) |
| Create arbiter validation module         | ✅ Complete | `src/validation/arbiter.ts` (NEW) |
| Add hybrid-allocator-indexer client      | ✅ Complete | `src/graphql.ts`                  |
| Add indexer health checks                | ✅ Complete | `src/graphql.ts`                  |
| Update .env.example                      | ✅ Complete | `.env.example`                    |
| Update validation exports                | ✅ Complete | `src/validation/index.ts`         |

**New File Created: `src/validation/arbiter.ts`**

- Exports `HYBRID_ALLOCATOR_ADDRESS`, `TRIBUNAL_ADDRESS`, `THE_COMPACT_ADDRESS`
- `initializeAllowedArbiters(arbitersEnv?)` - Initialize from env config
- `isArbiterAllowed(arbiter)` - Check if arbiter is whitelisted
- `validateArbiter(arbiter)` - Full validation with error messages
- `getAllowedArbiters()` - Get current whitelist
- `isTribunal(arbiter)` - Check if address is Tribunal
- `addAllowedArbiter(arbiter)` / `removeAllowedArbiter(arbiter)` - Runtime management
- Handles case-insensitive address matching (all-uppercase and all-lowercase converted to checksum)

**Updates to `src/graphql.ts`:**

- Added `HYBRID_ALLOCATOR_INDEXER_URL` constant
- Added `hybridAllocatorGraphqlClient` secondary GraphQL client
- Added `checkHybridIndexerHealth()` function
- Added `ensureIndexersHealthy()` fail-closed health check
- Added queries: `GET_HYBRID_ALLOCATIONS`, `GET_HYBRID_ALLOCATION_BY_CLAIM_HASH`, `GET_ALLOCATOR_INSTANCE`, `GET_SIGNERS`

**Updates to `.env.example`:**

```env
HYBRID_ALLOCATOR_INDEXER_URL=https://hybrid-allocator-indexer.marble.live/graphql
ALLOWED_ARBITERS=
```

#### ✅ Phase 4: Frontend Updates (Partial)

| Task                              | Status             | File(s) Modified                      |
| --------------------------------- | ------------------ | ------------------------------------- |
| lockTag utilities                 | ✅ Already existed | `frontend/src/utils/lockTag.ts`       |
| claimant encoding                 | ✅ Already existed | `frontend/src/utils/claimant.ts`      |
| Add HybridAllocator address & ABI | ✅ Complete        | `frontend/src/constants/contracts.ts` |
| Add Tribunal address              | ✅ Complete        | `frontend/src/constants/contracts.ts` |

**Updates to `frontend/src/constants/contracts.ts`:**

- Added `HYBRID_ALLOCATOR_ADDRESS`
- Added `TRIBUNAL_ADDRESS`
- Added `HYBRID_ALLOCATOR_ABI` with key functions:
  - `ALLOCATOR_ID()` - View allocator ID
  - `signers(address)` - Check authorized signers
  - `allocateAndRegister(...)` - On-chain allocation
  - `authorizeAttestation(...)` - Transfer pre-authorization
  - `attestations(bytes32)` - Check attestation status

#### ✅ Phase 5: Testing

| Task                               | Status      | File(s) Modified                                      |
| ---------------------------------- | ----------- | ----------------------------------------------------- |
| Create hybrid-nonce tests          | ✅ Complete | `src/__tests__/validation/hybrid-nonce.test.ts` (NEW) |
| Create arbiter tests               | ✅ Complete | `src/__tests__/validation/arbiter.test.ts` (NEW)      |
| Fix Jest setup for lazy DB loading | ✅ Complete | `src/__tests__/setup.ts`                              |
| Verify all tests pass              | ✅ Complete | -                                                     |

**Test Setup Improvements (`src/__tests__/setup.ts`):**

- Made database initialization lazy - only tests that call `dbManager.requireDatabase()` or `dbManager.getDb()` initialize PGlite
- Tests that don't need database (like pure unit tests) now skip PGlite entirely
- Prevents `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` errors for non-DB tests

### Remaining Work

#### ✅ Phase 3: Database

| Task                              | Status        | Notes                                                                            |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| Add `commitments` support         | ✅ Complete   | Already exists via normalized tables (`compact_elements`, `compact_commitments`) |
| Add `nonce_command` column        | ✅ Complete   | Added to `nonces` table in `schema.sql`                                          |
| Create `hybrid_allocations` table | ❌ Not needed | Using existing `compacts` table with `compact_type=1` for BatchCompact           |
| Run migrations                    | ⏳ Pending    | Will auto-apply on fresh database; manual migration for existing databases       |

**Schema Update Notes:**

- The schema already supports BatchCompact through normalized tables (`compacts` → `compact_elements` → `compact_commitments`)
- Added `nonce_command` column to `nonces` table to track ON_CHAIN (1), OFF_CHAIN (2), PERMIT2 (3) commands

#### ⏳ Phase 4: Frontend Updates (Remaining)

| Task                      | Status     | Notes                                |
| ------------------------- | ---------- | ------------------------------------ |
| Add arbiter selection UI  | ⏳ Pending | UI component for selecting arbiter   |
| Add HybridAllocator hooks | ⏳ Pending | React hooks for contract interaction |

#### ✅ New Features (Unified Allocation Flow)

| Task                                   | Status      | Notes                                                                       |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| Unified `/allocation` endpoint         | ✅ Complete | `src/routes/allocation.ts` - single endpoint for all three request types    |
| **Standard (signed compact)**          | ✅ Complete | Full implementation with signature verification, nonce validation, storage  |
| Permit2 signature verification         | ⏳ Pending  | Stub created, returns 501 Not Implemented                                   |
| Transaction hash lookup                | ⏳ Pending  | Stub created, returns 501 Not Implemented                                   |
| Automatic partial allocation detection | ⏳ Pending  | Part of permit2/transaction handlers                                        |
| Off-chain allocation for delta         | ⏳ Pending  | Part of permit2/transaction handlers                                        |
| Balance verification                   | ✅ Complete | Uses existing `validateBatchAllocation` from `src/validation/allocation.ts` |

**New File Created: `src/routes/allocation.ts`**

- `POST /allocation` - Unified allocation endpoint supporting:
  - `type: 'standard'` - Full off-chain allocation for signed BatchCompact ✅
  - `type: 'permit2'` - Pre-execution hybrid (stub) ⏳
  - `type: 'transaction'` - Post-execution hybrid (stub) ⏳
- `GET /allocation/:chainId/:claimHash` - Check if allocation exists (local + indexer)
- `POST /allocation/suggested-nonce` - Generate hybrid nonce with OFF_CHAIN command

---

## Learnings & Technical Notes

### Jest + PGlite Compatibility

**Issue**: PGlite uses dynamic imports internally which cause `TypeError: A dynamic import callback was invoked without --experimental-vm-modules` when running with Jest.

**Solution**:

1. Always run tests via `pnpm test` which includes `NODE_OPTIONS='--experimental-vm-modules --no-warnings'`
2. Direct `npx jest` commands will fail for tests using PGlite
3. For tests that don't need database, the lazy-loading in `setup.ts` prevents the error

### Address Case Sensitivity

**Issue**: Ethereum addresses can be all-lowercase, all-uppercase, or checksummed. viem's `getAddress()` validates checksums for mixed-case addresses but rejects all-uppercase.

**Solution**: The `normalizeAddress()` function in `arbiter.ts` handles this:

- All-lowercase → converted to checksum via `getAddress(address.toLowerCase())`
- All-uppercase → converted to checksum via `getAddress(address.toLowerCase())`
- Mixed-case → validated as checksum via `getAddress(address)`

### Nonce Structure

The HybridAllocator nonce is 32 bytes structured as:

```
| Command (1 byte) | Sponsor Address (20 bytes) | Fragment (11 bytes) |
```

- Command byte position: `nonce >> 248` (top byte)
- Sponsor position: `(nonce >> 88) & ((1 << 160) - 1)` (middle 20 bytes)
- Fragment position: `nonce & ((1 << 88) - 1)` (bottom 11 bytes)

This differs from the existing autocator nonce which has sponsor at the top.

### Indexer Health Checks

**Design Decision**: Fail-closed approach - if either indexer is down, refuse to issue off-chain allocations.

The `ensureIndexersHealthy()` function checks both:

1. `the-compact-v1-indexer` - for balances and claims
2. `hybrid-allocator-indexer` - for allocations and signers

Both must respond successfully before signing any allocation.

---

## Contract Addresses & Endpoints

### Contracts

| Contract        | Address                                      | Notes           |
| --------------- | -------------------------------------------- | --------------- |
| The Compact V1  | `0x00000000000000171ede64904551eeDF3C6C9788` | Already used ✅ |
| HybridAllocator | `0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B` | ✅ Added        |
| Tribunal        | `0x000000000000790009689f43bAedb61D67D45bB8` | ✅ Added        |

### Indexer Endpoints

| Indexer                  | Endpoint                                               | Purpose                            |
| ------------------------ | ------------------------------------------------------ | ---------------------------------- |
| the-compact-v1-indexer   | `https://the-compact-v1-indexer.marble.live/graphql`   | Balances, claims, registrations    |
| hybrid-allocator-indexer | `https://hybrid-allocator-indexer.marble.live/graphql` | Allocations, signers, attestations |

### Supported Networks

Both mainnets and testnets:

- Ethereum Mainnet (1), Sepolia (11155111)
- Base (8453), Base Sepolia (84532)
- Arbitrum One (42161), Arbitrum Sepolia (421614)
- Optimism (10), Optimism Sepolia (11155420)
- Unichain (130), Unichain Sepolia (1301)

---

## Data Structure Changes

### Lock vs ID Structure

**Current (Autocator uses `id`):**

```typescript
interface CompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: string;
  expires: string;
  id: string; // uint256 - lockTag + token packed
  amount: string;
  witnessTypeString: string | null;
  witnessHash: string | null;
}
```

**New (HybridAllocator uses `Lock` struct for BatchCompact):**

```typescript
interface Lock {
  lockTag: string; // bytes12 - allocatorId + resetPeriod + scope
  token: string; // address - underlying token
  amount: string; // uint256 - committed amount
}

interface BatchCompactMessage {
  arbiter: string;
  sponsor: string;
  nonce: string;
  expires: string;
  commitments: Lock[]; // Array of locks instead of single id
  witnessTypeString: string | null;
  witnessHash: string | null;
}
```

### Nonce Structure Changes

**Current (Autocator):**

- Nonce is a simple incrementing uint256 prefixed with sponsor address

**New (HybridAllocator) - Structured Nonce:**

```
Nonce Structure (32 bytes):
- Byte 0: Command (0x01=on-chain, 0x02=off-chain, 0x03=permit2)
- Bytes 1-20: Sponsor address (20 bytes)
- Bytes 21-31: Freely chosen nonce value (11 bytes)
```

```typescript
enum NonceCommand {
  ON_CHAIN = 0x01,
  OFF_CHAIN = 0x02,
  PERMIT2 = 0x03,
}

// ✅ Implemented in src/validation/hybrid-nonce.ts
function constructHybridNonce(
  command: NonceCommand,
  sponsor: string,
  fragment: bigint
): bigint;
function parseHybridNonce(nonce: bigint): {
  command: NonceCommand;
  sponsor: string;
  fragment: bigint;
};
```

### EIP-712 Type Changes

**BatchCompact TypeHash (new):**

```solidity
// keccak256("BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments)Lock(bytes12 lockTag,address token,uint256 amount)")
bytes32 constant BATCH_COMPACT_TYPEHASH = 0x179fcd593ea3b4b32623a455fb55eb007c5040f4c85774f2e3f18d98e87eb76b;

// Lock typehash
// keccak256("Lock(bytes12 lockTag,address token,uint256 amount)")
bytes32 constant LOCK_TYPEHASH = 0xfb7744571d97aa61eb9c2bc3c67b9b1ba047ac9e95afb2ef02bc5b3d9e64fbe5;
```

---

## Backend Changes

### 1. ✅ Update `src/validation/types.ts`

**Added types for HybridAllocator:**

```typescript
// ✅ Complete - NonceCommand enum
export enum NonceCommand {
  ON_CHAIN = 0x01,
  OFF_CHAIN = 0x02,
  PERMIT2 = 0x03,
}

// ✅ Complete - ParsedNonce interface
export interface ParsedNonce {
  command: NonceCommand;
  sponsor: string;
  fragment: bigint;
}

// ✅ Complete - HybridAllocationContext
export interface HybridAllocationContext {
  claimHash: string;
  nonce: bigint;
  sponsor: string;
  commitments: Lock[];
  expires: bigint;
  signature?: string;
}
```

### 2. ✅ Create `src/validation/hybrid-nonce.ts`

Full nonce parsing/construction utilities (see implementation details above).

### 3. ✅ Update `src/graphql.ts`

**Added hybrid-allocator-indexer queries:**

```typescript
// ✅ Complete - Secondary indexer
export const hybridAllocatorGraphqlClient = new GraphQLClient(
  HYBRID_ALLOCATOR_INDEXER_URL
);

// ✅ Complete - Health checks
export async function checkHybridIndexerHealth(): Promise<boolean>;
export async function ensureIndexersHealthy(): Promise<{
  compact: boolean;
  hybrid: boolean;
}>;

// ✅ Complete - Queries
export const GET_HYBRID_ALLOCATIONS = `...`;
export const GET_HYBRID_ALLOCATION_BY_CLAIM_HASH = `...`;
export const GET_ALLOCATOR_INSTANCE = `...`;
export const GET_SIGNERS = `...`;
```

### 4. ✅ Create `src/validation/arbiter.ts`

**Arbiter validation with whitelist:**

```typescript
// ✅ Complete - Contract addresses
export const HYBRID_ALLOCATOR_ADDRESS =
  '0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B';
export const TRIBUNAL_ADDRESS = '0x000000000000790009689f43bAedb61D67D45bB8';
export const THE_COMPACT_ADDRESS = '0x00000000000000171ede64904551eeDF3C6C9788';

// ✅ Complete - Functions
export function initializeAllowedArbiters(arbitersEnv?: string): void;
export function isArbiterAllowed(arbiter: string): boolean;
export function validateArbiter(arbiter: string): {
  isValid: boolean;
  error?: string;
};
export function getAllowedArbiters(): string[];
export function isTribunal(arbiter: string): boolean;
export function addAllowedArbiter(arbiter: string): boolean;
export function removeAllowedArbiter(arbiter: string): boolean;
```

### 5. ⏳ Update `src/routes/compact.ts`

**Add unified allocation endpoint:** (Pending)

The unified `/allocation` endpoint accepts **three** types of requests:

#### Request Type 1: Vanilla (Signed BatchCompact) - Fully Off-chain

The simplest case. Sponsor has already deposited and settled tokens into The Compact. They sign a BatchCompact and submit it for full off-chain allocation.

```typescript
interface StandardAllocationRequest {
  type: 'standard';
  chainId: number; // Chain for the allocation
  compact: BatchCompact; // The BatchCompact message
  sponsorSignature: Hex; // Sponsor's signature on the BatchCompact
}
```

**Flow:**

1. Verify sponsor's signature on the BatchCompact
2. Query indexer for sponsor's settled balances
3. Verify all commitment amounts are covered by settled balances
4. Generate off-chain nonce (0x02 command) and sign full allocation
5. Return claim hash + allocator signature

#### Request Type 2: Permit2-based (Pre-execution Hybrid)

Sponsor deposits tokens AND registers a compact in a single Permit2 transaction. If the compact commits more than being deposited, additional off-chain allocation is needed.

```typescript
interface Permit2AllocationRequest {
  type: 'permit2';
  permit2Message: Permit2Message; // Full Permit2 message with embedded compact witness
  signature: Hex; // Sponsor's signature on Permit2 message
  compact: BatchCompact; // The compact pre-image for verification
}
```

**Flow:**

1. Verify sponsor's Permit2 signature
2. Extract deposit amounts from Permit2 `permitted` array
3. Compare against compact commitment amounts
4. If `commitment > deposit`, generate off-chain allocation for the delta
5. Return claim hash + any additional allocation signature needed

#### Request Type 3: Transaction-based (Post-execution Hybrid)

Sponsor has already executed a deposit+register transaction. Submit the tx hash to get any additional allocation.

```typescript
interface TransactionAllocationRequest {
  type: 'transaction';
  transactionHash: Hex; // Hash of deposit+register tx
  chainId: number; // Chain where tx was executed
  compact: BatchCompact; // The compact pre-image for verification
}
```

**Flow:**

1. Query indexer for transaction details
2. Extract deposit amounts from transaction logs
3. Compare against compact commitment amounts
4. If `commitment > deposit`, generate off-chain allocation for the delta
5. Return claim hash + any additional allocation signature needed

#### Common Response

```typescript
// Response includes claim hash and optional additional allocation
interface AllocationResponse {
  claimHash: Hex;
  // For vanilla: this is the full allocation signature
  // For permit2/tx: this is only for amounts exceeding deposit (null if fully covered)
  allocation: {
    commitments: Lock[]; // Amounts being allocated off-chain
    nonce: Hex; // Off-chain nonce (0x02 command)
    signature: Hex; // Allocator signature
  } | null;
  message: string;
}
```

---

## Frontend Changes

### 1. ✅ Update `frontend/src/constants/contracts.ts`

```typescript
// ✅ Complete - Added addresses
export const HYBRID_ALLOCATOR_ADDRESS = '0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B' as const;
export const TRIBUNAL_ADDRESS = '0x000000000000790009689f43bAedb61D67D45bB8' as const;

// ✅ Complete - Added ABI
export const HYBRID_ALLOCATOR_ABI = [...] as const;
```

### 2. ✅ Existing `frontend/src/utils/lockTag.ts`

LockTag utilities already exist.

### 3. ⏳ Create `frontend/src/hooks/useHybridAllocator.ts`

(Pending - hooks for HybridAllocator contract interaction)

---

## Database Schema Changes

### ⏳ Update `schema.sql`

```sql
-- TODO: Add new columns for Lock-based compacts
ALTER TABLE compacts ADD COLUMN commitments JSONB;
ALTER TABLE compacts ADD COLUMN nonce_command INTEGER;
ALTER TABLE compacts ADD COLUMN lock_tag TEXT;

-- TODO: Create hybrid_allocations table
CREATE TABLE IF NOT EXISTS hybrid_allocations (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  sponsor TEXT NOT NULL,
  nonce TEXT NOT NULL,
  nonce_command INTEGER NOT NULL,
  expires TEXT NOT NULL,
  commitments JSONB NOT NULL,
  arbiter TEXT NOT NULL,
  witness_hash TEXT,
  witness_type_string TEXT,
  signature TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chain_id, claim_hash)
);
```

---

## Implementation Checklist

### ✅ Phase 1: Core Data Structures

- [x] Add `Lock` interface to `src/validation/types.ts`
- [x] Add `NonceCommand` enum and nonce parsing utilities
- [x] Update claim hash generation in `src/crypto.ts` for Lock-based BatchCompact
- [x] Add commitments hash generation function
- [x] Create `src/validation/hybrid-nonce.ts` with full nonce utilities

### ✅ Phase 2: Backend Integration

- [x] Add hybrid-allocator-indexer GraphQL client
- [x] Add indexer health check with fail-closed behavior
- [x] Add arbiter whitelist with Tribunal included
- [x] Update `.env.example` with new variables
- [x] Export new modules from `src/validation/index.ts`
- [x] Update nonce generation to use OFF_CHAIN scope via `/allocation/suggested-nonce`
- [x] Create new `/allocation` endpoint (`src/routes/allocation.ts`)

### ✅ Phase 3: Database

- [x] Add `commitments` support (already exists via normalized tables)
- [x] Add `nonce_command` column for scope tracking
- [x] Use existing `compacts` table with `compact_type=1` for BatchCompact
- [ ] Run migrations (auto-applies on fresh database)

### ✅ Phase 4: Frontend Updates (Partial)

- [x] Add HybridAllocator contract address and ABI
- [x] Add Tribunal address to constants
- [x] Verify lockTag utilities exist
- [ ] Add arbiter selection to UI
- [ ] Create HybridAllocator React hooks

### ✅ Phase 5: Testing

- [x] Unit tests for hybrid-nonce utilities (`src/__tests__/validation/hybrid-nonce.test.ts`)
- [x] Unit tests for arbiter validation (`src/__tests__/validation/arbiter.test.ts`)
- [x] Fix Jest setup for lazy database loading
- [x] All existing tests pass (231 tests)
- [ ] Integration tests for `/allocation` endpoint
- [ ] End-to-end test of allocation flow
- [ ] Test indexer failover behavior

### ⏳ Phase 6: Permit2 & Transaction Allocation (Future)

- [ ] Implement `handlePermit2Allocation` in `src/routes/allocation.ts`
- [ ] Implement `handleTransactionAllocation` in `src/routes/allocation.ts`
- [ ] Add partial allocation detection (compare deposit vs commitment amounts)
- [ ] Tests for permit2 and transaction allocation flows

IMPORTANT NOTE: all new functionality must have corresponding new tests!

---

## Design Decisions

These decisions were clarified during the planning phase:

### 1. Multi-token Deposits

**Decision**: We do NOT need to support batch deposits through the frontend UI for now.

**However**: We DO need to support registered or signed compacts that incorporate batch resource locks (`Lock[]` / `commitments`) as that's what the HybridAllocator expects.

### 2. Arbiter Selection

**Decision**: Users should be able to select their arbiter.

Tribunal (`0x000000000000790009689f43bAedb61D67D45bB8`) is just one arbiter that we need to:

- Be aware of and explicitly support (understand its witness typestring structure)
- Include in an "allowed arbiters" configuration (but not hardcode as the only option)

### 3. Nonce Management

**Decision**: Nonces should be explicitly scoped as being on-chain or off-chain.

Off-chain nonces MUST always use the correct dedicated scope:

- Command byte `0x02` (OFF_CHAIN) for allocator-signed allocations
- Next 20 bytes: sponsor address
- Remaining bytes: incremented nonce value

### 4. Error Handling for Indexer Availability

**Decision**: If EITHER indexer is down, refuse to issue off-chain allocations entirely since it's unsafe to do so.

Implementation:

- Before signing any allocation, verify both indexers are reachable
- Return an error like `"Service temporarily unavailable: cannot verify allocation safety"` if either indexer fails health check

---

## Reference Repositories

For additional context during implementation:

| Repository               | Path                                           | Key Files                   |
| ------------------------ | ---------------------------------------------- | --------------------------- |
| HybridAllocator          | `/Users/0age/Desktop/hybrid-allocator`         | `src/HybridAllocator.sol`   |
| hybrid-allocator-indexer | `/Users/0age/Desktop/hybrid-allocator-indexer` | `ponder.schema.ts`          |
| The Compact V1           | `/Users/0age/Desktop/the-compact`              | `src/types/EIP712Types.sol` |
| the-compact-indexer      | `/Users/0age/Desktop/the-compact-indexer`      | `ponder.schema.ts`          |
| Tribunal                 | `/Users/0age/Desktop/tribunal`                 | `src/Tribunal.sol`          |

---

_Document last updated: January 6, 2026_
_Based on implementation work in Autocator repository_

Additional TODOs that are not reflected in the doc yet:

- use hybrid allocator indexer to check onchain allocations and ensure that we don't overallocate
  - basically each allocated event will reserve tokens that cannot be allocated offchain
  - may require adding latest processed block number and tracking block number => block hash on each indexer to ensure consistency between compact indexer and hybrid allocator indexer
- use proper permit2 messages that The Compact expects in implementation and tests
  - recommendation here is to examine Exarch as it has working examples of what this will look like in practice (even though Exarch is yet to be deployed)
  - parse out deposited tokens from tokens on the preimage of the batch compact in question
  - mandate will remain hidden to autocator, but the mandate hash and the witness typestring (specific to each arbiter) will need to be provided alongside the compact preimage for derivation of the claim hash
- update README with latest feature set and interface
