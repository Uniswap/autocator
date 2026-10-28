# $$\mathbf{\color{green}{Auto}\color{default}{cator}}$$ 🚗

A server-based allocator for [The Compact](https://github.com/Uniswap/the-compact) that leverages protocol signatures and transactions for authentication. Autocator supports the **HybridAllocator** contract, enabling flexible allocation strategies including fully off-chain allocations, Permit2-based hybrid allocations, and on-chain registration-based allocations.

Autocator provides an API for requesting resource lock allocations across multiple blockchains by providing the details of associated compacts with accompanying sponsor signatures, Permit2 messages, or onchain registrations. It also includes a frontend application for interacting directly with the server that facilitates making deposits into resource locks it oversees.

Autocator is a fork of [Smallocator](https://github.com/uniswap/smallocator) with key differences:

- No "Sign in with Ethereum" authentication component
- **Autocator does not provide the same privacy guarantees as Smallocator** — allocated token balances and suggested nonces are public
- Support for HybridAllocator with three distinct allocation types
- Uses a structured hybrid nonce format with command byte prefixes
- Supports BatchCompact messages with multiple commitments (Lock arrays)

A hosted version is available at [Autocator.org](https://autocator.org/) — Note that it's likely not ready for real production use (do reach out if it goes down).

> ⚠️ Autocator is under development and is intended to serve as a reference for understanding server-based allocator functionality and for testing purposes. Use caution when using Autocator in a production environment.

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Allocation Types](#allocation-types)
  - [Standard Allocation](#1-standard-allocation-full-off-chain)
  - [Permit2 Allocation](#2-permit2-allocation-hybrid)
  - [On-Chain Allocation](#3-on-chain-allocation)
  - [When to Use Each Type](#when-to-use-each-type)
- [Nonce Structure](#nonce-structure)
- [API Reference](#api-reference)
- [Contract Addresses](#contract-addresses)
- [Installation & Setup](#installation--setup)
- [Configuration](#configuration)
- [Frontend Usage](#frontend-usage)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [License](#license)

## Features

- ✍️ EIP-712 Compact message validation and signing with multiple verification methods
- 🔄 Three allocation types: standard (off-chain), Permit2 (hybrid), and on-chain registration
- 🔐 Hybrid nonce structure with command byte prefixes for allocation type enforcement
- 📦 BatchCompact support with multiple Lock commitments
- 🛡️ Arbiter whitelist with Tribunal as default arbiter
- 📊 GraphQL integration with unified indexer for multi-chain data
- 💾 Persistent storage using PGLite to track attested compacts and used nonces
- 🔎 Comprehensive validation pipeline to ensure resource locks never end up in an overallocated state
- 🚫 Fail-closed design: refuses allocations when indexer is unavailable

## Allocation Types

Autocator supports three distinct allocation types, each designed for different use cases. Understanding when to use each type is crucial for integrators.

### 1. Standard Allocation (Full Off-Chain)

**Use Case**: Sponsor has already deposited and settled tokens into The Compact (or has tokens available from a previous operation that was not successfully completed) and wants to create a fully off-chain allocation.

**Flow**:

1. Sponsor deposits tokens into The Compact (separate transaction)
2. Wait for deposit to finalize (chain-specific finalization threshold)
3. Sponsor signs a BatchCompact message
4. Submit to Autocator's `/allocation` endpoint with `type: 'standard'`
5. Autocator verifies signature, checks balances, and signs the full allocation

**When to Use**:

- You've already deposited tokens and want maximum flexibility
- You want to retry allocations without additional deposits
- You need to pre-fund accounts for multiple future allocations

**Nonce Command**: `0x02` (OFF_CHAIN)

**Request Example**:

```json
{
  "type": "standard",
  "chainId": "8453",
  "compact": {
    "arbiter": "0x000000000000790009689f43bAedb61D67D45bB8",
    "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "nonce": "0x0270997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000001",
    "expires": "1737100000",
    "commitments": [
      {
        "lockTag": "0x12345678901234567890abcd",
        "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "amount": "1000000000000000000"
      }
    ],
    "witnessTypeString": null,
    "witnessHash": null
  },
  "sponsorSignature": "0x..."
}
```

**Response**:

```json
{
  "claimHash": "0x...",
  "allocation": {
    "commitments": [...],
    "nonce": "0x...",
    "signature": "0x..."
  },
  "message": "Off-chain allocation successful"
}
```

### 2. Permit2 Allocation (Hybrid)

**Use Case**: Sponsor wants to deposit tokens AND register a compact in a single Permit2 transaction. If the compact commits more than being deposited, Autocator provides an additional off-chain signature for the delta. Note that this method is _not_ required when the tokens being deposited match or exceed the tokens being committed in the accompanying resource lock; in those cases, only an on-chain allocation is required (which can be initiated alongside the deposit and registration).

**Flow**:

1. Sponsor constructs a Permit2 message with embedded compact witness
2. Sponsor signs the Permit2 message
3. Submit to Autocator's `/allocation` endpoint with `type: 'permit2'`
4. Autocator verifies Permit2 signature and calculates deposit vs commitment delta
5. If `commitment > deposit`, Autocator signs a HybridAllocationContext for the delta only
6. Interested party executes the Permit2 transaction on-chain

**When to Use**:

- You want a single-transaction flow (deposit + register)
- You have existing settled balance and want to top it up with new deposits
- You want atomic deposit and compact registration

**Nonce Command**: `0x03` (PERMIT2)

**Important**: The delta calculation is **lockTag-aware**. Only commitments whose lockTag matches the deposit lockTag can be offset by deposits. Commitments with different lockTags require full off-chain allocation.

**Request Example**:

```json
{
  "type": "permit2",
  "chainId": "8453",
  "permit2Message": {
    "permitted": [
      {
        "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "amount": "500000000000000000"
      }
    ],
    "spender": "0x00000000000000171ede64904551eeDF3C6C9788",
    "nonce": "12345",
    "deadline": "1737100000",
    "witness": {
      "activator": "0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B",
      "ids": ["0x..."],
      "compact": {
        "arbiter": "0x000000000000790009689f43bAedb61D67D45bB8",
        "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "nonce": "0x0370997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000001",
        "expires": "1737100000",
        "commitments": [
          {
            "lockTag": "0x12345678901234567890abcd",
            "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "amount": "1000000000000000000"
          }
        ],
        "witnessTypeString": null,
        "witnessHash": null
      }
    },
    "depositLockTag": "0x12345678901234567890abcd"
  },
  "signature": "0x...",
  "mandateHash": "0x...",
  "witnessTypeString": "..."
}
```

**Response** (when delta > 0):

```json
{
  "claimHash": "0x...",
  "allocation": {
    "commitments": [
      {
        "lockTag": "0x12345678901234567890abcd",
        "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "amount": "500000000000000000"
      }
    ],
    "nonce": "0x...",
    "signature": "0x..."
  },
  "message": "Permit2 allocation successful - signed HybridAllocationContext for 1 commitment(s) exceeding deposit"
}
```

**Response** (when deposit fully covers commitment):

```json
{
  "claimHash": "0x...",
  "allocation": null,
  "message": "Deposit covers all commitments - no additional allocation needed (use on-chain flow)"
}
```

### 3. On-Chain Allocation

**Use Case**: Sponsor has already executed a deposit+register transaction on-chain via the HybridAllocator. After the transaction finalizes, they can request Autocator to sign the full allocation.

**Flow**:

1. Sponsor executes `allocateAndRegister()` on HybridAllocator contract
2. Wait for transaction to finalize (chain-specific threshold)
3. Submit to Autocator's `/allocation` endpoint with `type: 'onchain'`
4. Autocator verifies the registration exists and is finalized
5. Autocator signs the full BatchCompact

**When to Use**:

- You've already registered a compact on-chain
- You want the simplest flow after an on-chain action
- You're building retry logic for failed transactions

**Nonce Command**: `0x01` (ON_CHAIN)

**Request Example**:

```json
{
  "type": "onchain",
  "chainId": "8453",
  "compact": {
    "arbiter": "0x000000000000790009689f43bAedb61D67D45bB8",
    "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "nonce": "0x0170997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000001",
    "expires": "1737100000",
    "commitments": [...],
    "witnessTypeString": null,
    "witnessHash": null
  },
  "mandateHash": "0x...",
  "witnessTypeString": "..."
}
```

**Response**:

```json
{
  "claimHash": "0x...",
  "allocation": {
    "commitments": [...],
    "nonce": "0x...",
    "signature": "0x..."
  },
  "message": "On-chain allocation successful - signed full BatchCompact for finalized registration"
}
```

### When to Use Each Type

| Scenario                            | Recommended Type      | Reason                                              |
| ----------------------------------- | --------------------- | --------------------------------------------------- |
| Already deposited, want flexibility | **Standard**          | Full off-chain flow, can retry without new deposits |
| Atomic deposit + register           | **Permit2**           | Single signature, single transaction                |
| Partial top-up needed               | **Permit2**           | Autocator calculates and signs only the delta       |
| Already registered on-chain         | **On-Chain**          | Get allocator signature for finalized registration  |
| Testing/development                 | **Standard**          | Simplest to implement and debug                     |
| Maximum gas efficiency              | **Permit2**           | Combines multiple operations                        |
| Retry after failed claim            | **Standard/On-Chain** | Depends on whether deposit completed                |

## Nonce Structure

Autocator uses a **hybrid nonce** format that encodes the allocation type in the first byte:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Nonce Structure (32 bytes)                      │
├─────────┬────────────────────────┬──────────────────────────────────┤
│ Command │     Sponsor Address    │           Fragment               │
│ (1 byte)│       (20 bytes)       │          (11 bytes)              │
├─────────┼────────────────────────┼──────────────────────────────────┤
│  0x01   │   ON_CHAIN allocation  │                                  │
│  0x02   │   OFF_CHAIN allocation │     Freely chosen value          │
│  0x03   │   PERMIT2 allocation   │     (up to 2^88 - 1)             │
└─────────┴────────────────────────┴──────────────────────────────────┘
```

**Command Bytes**:

- `0x01` - ON_CHAIN: For compacts registered directly on-chain via HybridAllocator
- `0x02` - OFF_CHAIN: For fully off-chain allocations signed by Autocator
- `0x03` - PERMIT2: For Permit2-based hybrid allocations

**Important**: The nonce command MUST match the allocation type. Autocator validates this and rejects mismatched requests.

**Example Nonce Construction**:

```
Command:  0x02 (OFF_CHAIN)
Sponsor:  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
Fragment: 1

Nonce: 0x0270997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000001
       ^^                                        ^^^^^^^^^^^^^^^^^^^^^^^^
       Command                                   Fragment (11 bytes)
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         Sponsor Address (20 bytes)
```

## API Reference

### Health Check

```http
GET /health
```

Returns server status, supported chains, and configuration.

**Response**:

```json
{
  "status": "healthy",
  "allocatorAddress": "0x...",
  "signingAddress": "0x...",
  "timestamp": "2026-01-15T12:00:00.000Z",
  "supportedChains": [
    {
      "chainId": "1",
      "allocatorId": "0x12345678901234567890abcd",
      "finalizationThresholdSeconds": 25
    }
  ]
}
```

### Unified Allocation Endpoint

```http
POST /allocation
```

Submit an allocation request. Supports three types: `standard`, `permit2`, and `onchain`.

See [Allocation Types](#allocation-types) for detailed request/response formats.

### Check Allocation Status

```http
GET /allocation/:chainId/:claimHash
```

Check if an allocation exists for a given claim hash.

**Response**:

```json
{
  "exists": true,
  "source": "hybrid-allocator",
  "allocation": {
    "claimHash": "0x...",
    "sponsor": "0x...",
    "nonce": "0x...",
    "expires": "1737100000",
    "commitments": [...],
    "timestamp": "1737050000"
  }
}
```

### Generate Suggested Nonce (Hybrid Format)

```http
POST /allocation/suggested-nonce
```

Generate a suggested hybrid nonce for off-chain allocation.

**Request**:

```json
{
  "chainId": "8453",
  "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```

**Response**:

```json
{
  "nonce": "0x0270997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000001",
  "command": "OFF_CHAIN",
  "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "fragment": "1"
}
```

### Legacy Compact Endpoints

These endpoints support the original Compact format (single resource lock, not BatchCompact):

#### Get Suggested Nonce (Legacy)

```http
GET /suggested-nonce/:chainId/:account
```

**Response**:

```json
{
  "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001"
}
```

#### Submit Compact (Legacy)

```http
POST /compact
```

**Request**:

```json
{
  "chainId": "10",
  "compact": {
    "arbiter": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001",
    "expires": "1737100000",
    "id": "0x300000000000000000000000000000000000000000000000000000000000001c",
    "amount": "1000000000000000000",
    "witnessTypeString": null,
    "witnessHash": null
  },
  "sponsorSignature": "0x..."
}
```

#### Get Compacts by Account

```http
GET /compacts/:account
```

#### Get Specific Compact

```http
GET /compact/:chainId/:claimHash
```

#### Check Allocatability

```http
POST /compact/is-allocatable
```

### Balance Endpoints

#### Get Balance for Specific Lock

```http
GET /balance/:chainId/:lockId/:account
```

**Response**:

```json
{
  "allocatableBalance": "1000000000000000000",
  "allocatedBalance": "500000000000000000",
  "balanceAvailableToAllocate": "500000000000000000",
  "withdrawalStatus": 0
}
```

Balance definitions:

- **allocatableBalance**: Current finalized balance (excludes unfinalized deposits)
- **allocatedBalance**: Sum of unexpired, unclaimed compact allocations
- **balanceAvailableToAllocate**: `allocatableBalance - allocatedBalance` (0 if withdrawal initiated)
- **withdrawalStatus**: 0 = normal, non-zero = forced withdrawal in progress

#### Get All Balances for Account

```http
GET /balances/:account
```

Returns balance information for all resource locks managed by this allocator for the given account.

## Contract Addresses

All contracts are deployed at the same address across all supported networks:

| Contract            | Address                                      | Description                           |
| ------------------- | -------------------------------------------- | ------------------------------------- |
| **The Compact V1**  | `0x00000000000000171ede64904551eeDF3C6C9788` | Core resource lock protocol           |
| **HybridAllocator** | `0xa110cE8BFD2Bb33fd7dB4804f9b8736fE4d05A4B` | Hybrid allocation contract            |
| **Tribunal**        | `0x000000000000790009689f43bAedb61D67D45bB8` | Default arbiter for cross-chain swaps |
| **Permit2**         | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 contract            |

### Supported Networks

Note that finalization thresholds are configurable.

| Network          | Chain ID | Finalization Threshold |
| ---------------- | -------- | ---------------------- |
| Ethereum Mainnet | 1        | ~25 seconds            |
| Optimism         | 10       | ~10 seconds            |
| Base             | 8453     | ~2 seconds             |
| Arbitrum One     | 42161    | ~10 seconds            |
| Unichain         | 130      | ~2 seconds             |
| Sepolia          | 11155111 | ~25 seconds            |
| Base Sepolia     | 84532    | ~2 seconds             |
| Optimism Sepolia | 11155420 | ~10 seconds            |
| Arbitrum Sepolia | 421614   | ~10 seconds            |
| Unichain Sepolia | 1301     | ~2 seconds             |

## Installation & Setup

### Prerequisites

- Node.js >= 18
- pnpm >= 9.14.1
- TypeScript >= 5.2

### Quick Start

```bash
# Clone the repository
git clone git@github.com:Uniswap/autocator.git && cd autocator

# Copy environment configuration
cp .env.example .env

# Install all dependencies (frontend + backend)
pnpm install:all

# Run tests to verify setup
pnpm test

# Start development servers
pnpm dev:all
```

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# Server Configuration
BASE_URL=http://localhost:3000
PORT=3000
CORS_ORIGIN=*
DEV_FRONTEND_URL=http://localhost:3001

# Database Configuration
DATABASE_DIR=.autocator-data

# Crypto Configuration
PRIVATE_KEY=your_private_key_here
ALLOCATOR_ADDRESS=signing_address_or_contract_address
SIGNING_ADDRESS=derived_from_private_key

# External Services - Unified Indexer
INDEXER_URL=https://unified-compact-indexer.marble.live

# Arbiter Configuration
# Tribunal is always allowed by default. Add additional allowed arbiters (comma-separated)
# ALLOWED_ARBITERS=0x1234...,0x5678...
```

### Key Configuration Notes

1. **PRIVATE_KEY**: The private key used for signing allocations. Keep this secure!
2. **ALLOCATOR_ADDRESS**: The on-chain allocator address (can be same as signing address or a contract)
3. **INDEXER_URL**: The unified indexer endpoint that provides data from The Compact, HybridAllocator, and Tribunal
4. **ALLOWED_ARBITERS**: Additional arbiters beyond Tribunal that are whitelisted for allocations

## Frontend Usage

A basic frontend is available at the root path (`GET /`), or at `localhost:3001/` when running locally in dev mode.

### Features

- Health status monitoring
- Native token and ERC20 token deposits
- Allocatable and allocated balance viewing
- Allocated transfers and withdrawals
- Forced withdrawal management (initiate, execute, disable)
- Arbiter selection (Tribunal default, custom arbiter support)
- Allocation creation with hybrid nonce generation

### Frontend Configuration

Copy `frontend/.env.example` to `frontend/.env`:

```bash
VITE_API_URL=http://localhost:3000
VITE_ALLOCATOR_ADDRESS=0x...
```

## Development

### Available Scripts

```bash
# Run both frontend and backend in development mode
pnpm dev:all

# Run backend only
pnpm dev

# Run frontend only (from frontend directory)
cd frontend && pnpm dev

# Type checking
pnpm type-check

# Linting
pnpm lint

# Format code
pnpm format

# Build for production
pnpm build:all

# Start production server
pnpm start
```

### Code Quality

The project enforces strict code quality through:

- **ESLint** for linting
- **Prettier** for formatting
- **TypeScript** strict mode
- **Husky** pre-commit hooks
- **lint-staged** for staged file checks

Run all quality checks:

```bash
pnpm lint && pnpm type-check && pnpm format:check && pnpm test
```

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test src/__tests__/routes/allocation.test.ts

# Run tests with coverage
pnpm test --coverage
```

### Test Suites

- **Unit tests**: Core functionality (crypto, nonce parsing, validation)
- **Integration tests**: API endpoint testing
- **Validation tests**: Compact message validation
- **E2E tests**: Permit2 flow with actual signatures

### PGlite Compatibility Note

Tests require `--experimental-vm-modules` flag for PGlite compatibility. Always run tests via `pnpm test` which includes this flag automatically.

## Deployment

### Build Locally

As servers may have limited resources, build the project locally first:

```bash
# Install dependencies
pnpm install:all

# Create production .env
cp .env.example .env
# Edit .env with production configuration

# Build
pnpm build:all
```

### Deploy to Server

```bash
# SSH into your server
ssh user@your-server

# Clone the repository
git clone https://github.com/Uniswap/autocator.git
cd autocator

# Run setup script with your domain and IP
./scripts/setup-server.sh your-domain.com your-server-ip

# Transfer built files from local machine
scp -r dist/* user@your-server:/opt/autocator/dist/
```

The setup script will:

- Install dependencies (Node.js, pnpm, nginx, certbot)
- Set up the project in `/opt/autocator`
- Configure nginx with CORS support
- Set up SSL certificates with Let's Encrypt
- Create and enable a systemd service

### Monitoring

```bash
# Check server status
sudo systemctl status autocator

# View logs
sudo journalctl -u autocator -f

# Test health endpoint
curl https://your-domain.com/health
```

## Security Considerations

1. **Fail-Closed Design**: If the indexer is unavailable, Autocator refuses to issue allocations
2. **Nonce Uniqueness**: Every attested nonce is unique; no reuse on expirations
3. **Arbiter Whitelist**: Only approved arbiters can be used in allocations
4. **Signature Verification**: All allocation types verify appropriate signatures
5. **Balance Validation**: Comprehensive checks prevent over-allocation
6. **Finalization Thresholds**: Chain-specific thresholds guard against reorg issues

## License

MIT
