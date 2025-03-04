# $$\mathbf{Sm\color{green}{allocator}}$$ 🤏

A minimalistic server-based allocator for [The Compact](https://github.com/Uniswap/the-compact). Smallocator provides an API for sponsors to request resource lock allocations across multiple blockchains, with support for EIP-4361 session authentication and signing EIP-712 `Compact` messages. It also includes a frontend application for interacting directly with the server that also facilitates making deposits into resource locks it oversees.

> ⚠️ Smallocator is under developement and is intended to serve as a reference for understanding server-based allocator functionality and for testing purposes. Use caution when using Smallocator in a production environment.

## Features

- 🔐 Secure session-based authentication for sponsors using EIP-4361
- ✍️ EIP-712 Compact message validation and signing on demand from session-gated sponsors
- 🤫 No witness data or signature provided, keeping sponsor intents secret (only the typestring and witness hash is supplied)
- 📊 GraphQL integration with [The Compact Indexer](https://github.com/Uniswap/the-compact-indexer) for multi-chain indexing
- 💾 Persistent storage using PGLite to track attested compacts and used nonces
- 🔎 Comprehensive validation pipeline to ensure resource locks never end up in an overallocated state

## Intentionally Minimal Scope

- ☝️ Single-resource-lock, single-chain compacts only: No `BatchCompact` or `MultichainCompact` attestations
- ❄️ Strict nonce usage: Ensures every attested nonce is unique; no reuse on expirations and no direct onchain nonce consumption
- 🧭 No `attest()` callbacks for ERC6909 transfers: focused solely on attesting compacts
- 🪞 No compact qualification: Attests to the exact compact provided to it without adding qualifiers or extra metadata
- 📡 No direct on-chain awareness: Relies entirely on indexer and internal attestation state
- ⏳ Straightforward finalization: Uses a simple, time-based approach per chain for determining transaction finality

A lightweight hosted version is currently deployed to [https://smallocator.xyz](https://smallocator.xyz/). Note that it's not ready for any kind of production use (do reach out if it goes down).

## UI Usage

A basic frontend is available at the root path (`GET /`), or at `localhost:3001/` when running locally in dev mode. While the primary intended mechanism of interaction with Smallocator is via the API, the UI serves as a convenient and direct secondary access point.

It supports:
 - viewing the health status of the server
 - managing session key via EIP-4361 (Sign in with Ethereum)
 - depositing Native tokens and ERC20 tokens
 - viewing allocatable and allocated balances
 - performing allocated transfers and withdrawals
 - initiating, executing, and disabling forced withdrawals

Note that the frontend is still relatively unstable (any contributions here are welcome).

## API Usage

### Health Check

```http
GET /health
```

Example response:

```json
{
  "status": "healthy",
  "allocatorAddress": "0x1234567890123456789012345678901234567890",
  "signingAddress": "0x9876543210987654321098765432109876543210",
  "timestamp": "2024-03-07T12:00:00.000Z",
  "supportedChains": [
    {
      "chainId": "1",
      "allocatorId": "0x12345678901234567890abcd",
      "finalizationThresholdSeconds": 25
    },
    {
      "chainId": "10",
      "allocatorId": "0x12345678901234567890abcd",
      "finalizationThresholdSeconds": 10
    },
    {
      "chainId": "8453",
      "allocatorId": "0x2345678901234567890abcde",
      "finalizationThresholdSeconds": 2
    }
  ]
}
```

### Authentication

All authentication endpoints require a valid session ID in the `x-session-id` header.

1. **Get Session Payload**

   ```http
   GET /session/:chainId/:address
   ```

   Returns an EIP-4361 payload for signing. The chainId parameter specifies which blockchain network to authenticate for. Example response:

   ```json
   {
     "payload": {
       "domain": "localhost:3000",
       "address": "0x...",
       "uri": "http://localhost:3000",
       "statement": "Sign in to Smallocator",
       "version": "1",
       "chainId": 10,
       "nonce": "unique_nonce",
       "issuedAt": "2024-12-03T12:00:00Z",
       "expirationTime": "2024-12-03T13:00:00Z"
     }
   }
   ```

2. **Create Session**

   ```http
   POST /session
   ```

   Submit the signed payload to create a session. Example request:

   ```json
   {
     "signature": "0x1234...7890",
     "payload": {
       "domain": "localhost:3000",
       "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
       "uri": "http://localhost:3000",
       "statement": "Sign in to Smallocator",
       "version": "1",
       "chainId": 1,
       "nonce": "d6e1c0c4-3d78-4daa-9e57-5485b7c8c6c3",
       "issuedAt": "2024-03-07T12:00:00.000Z",
       "expirationTime": "2024-03-07T13:00:00.000Z",
       "resources": ["http://localhost:3000/resources"]
     }
   }
   ```

   Returns a session ID for subsequent requests.

3. **Get Session**

   ```http
   GET /session
   ```

   Requires a valid session ID in the `x-session-id` header.

   Example response:

   ```json
   {
     "session": {
       "id": "550e8400-e29b-41d4-a716-446655440000",
       "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
       "expiresAt": "2024-03-07T13:30:00Z"
     }
   }
   ```

4. **Delete Session**

   ```http
   DELETE /session
   ```

   Requires a valid session ID in the `x-session-id` header.

   Example response:

   ```json
   {
     "success": true
   }
   ```

### Compact Operations

1. **Submit Compact**

   ```http
   POST /compact
   ```

   Requires a valid session ID in the `x-session-id` header.

   Example request:

   ```json
   {
     "chainId": "10",
     "compact": {
       "arbiter": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
       "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
       "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001",
       "expires": "1732520000",
       "id": "0x300000000000000000000000000000000000000000000000000000000000001c",
       "amount": "1000000000000000000",
       "witnessTypeString": "ExampleWitness exampleWitness)ExampleWitness(uint256 foo, bytes32 bar)",
       "witnessHash": "0x0000000000000000000000000000000000000000000000000000000000000123"
     }
   }
   ```

   Example response:

   ```json
   {
     "hash": "0x1234567890123456789012345678901234567890123456789012345678901234",
     "signature": "0x1234...7890",
     "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001"
   }
   ```

Note that `nonce` can be provided as `null` in which case the next available valid nonce will be automatically assigned. `witnessTypeString` and `witnessHash` can also be `null` in which case the attested compact will not incorporate witness data (values must be provided for both or omitted for both to be considered valid).

2. **Get Compacts by Address**

   ```http
   GET /compacts
   ```

   Requires a valid session ID in the `x-session-id` header.

   Example response:

   ```json
   [
     {
       "chainId": "10",
       "hash": "0x1234567890123456789012345678901234567890123456789012345678901234",
       "compact": {
         "arbiter": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
         "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
         "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001",
         "expires": "1732520000",
         "id": "0x300000000000000000000000000000000000000000000000000000000000001c",
         "amount": "1000000000000000000",
         "witnessTypeString": "ExampleWitness exampleWitness)ExampleWitness(uint256 foo, bytes32 bar)",
         "witnessHash": "0x0000000000000000000000000000000000000000000000000000000000000123"
       },
       "signature": "0x1234...7890",
       "createdAt": "2024-03-07T12:00:00Z"
     }
   ]
   ```

3. **Get Specific Compact**

   ```http
   GET /compact/:chainId/:claimHash
   ```

   Requires a valid session ID in the `x-session-id` header.

   Example response:

   ```json
   {
     "chainId": "10",
     "hash": "0x1234567890123456789012345678901234567890123456789012345678901234",
     "compact": {
       "arbiter": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
       "sponsor": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
       "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001",
       "expires": "1732520000",
       "id": "0x300000000000000000000000000000000000000000000000000000000000001c",
       "amount": "1000000000000000000",
       "witnessTypeString": "ExampleWitness exampleWitness)ExampleWitness(uint256 foo, bytes32 bar)",
       "witnessHash": "0x0000000000000000000000000000000000000000000000000000000000000123"
     },
     "signature": "0x1234...7890",
     "createdAt": "2024-03-07T12:00:00Z"
   }
   ```

4. **Get Resource Lock Balance**

   ```http
   GET /balance/:chainId/:lockId
   ```

   Requires a valid session ID in the `x-session-id` header.

   Returns balance information for a specific resource lock. Example response:

   ```json
   {
     "allocatableBalance": "1000000000000000000",
     "allocatedBalance": "500000000000000000",
     "balanceAvailableToAllocate": "500000000000000000",
     "withdrawalStatus": 0
   }
   ```

   The `allocatableBalance` will be the current balance minus the sum of any unfinalized deposits or inbound transfers. The period after which these are considered finalized is configurable for each chain.

   The `allocatedBalance` will be the sum of any submitted compacts that:
   - have not been processed (as confirmed by a `Claim` event with the respective claim hash in a finalized block)
   - have not expired (as confirmed by a finalized block with a timestamp exceeding the `expires` value)

   The `balanceAvailableToAllocate` will be:

   - `"0"` if `withdrawalStatus` is non-zero
   - `"0"` if `allocatedBalance` >= `allocatableBalance`
   - `allocatableBalance - allocatedBalance` otherwise

5. **Get All Resource Lock Balances**
   ```http
   GET /balances
   ```

   Requires a valid session ID in the `x-session-id` header.

   Returns balance information for all resource locks managed by this allocator. Example response:

   ```json
   {
     "balances": [
       {
         "chainId": "1",
         "lockId": "0x1234567890123456789012345678901234567890123456789012345678901234",
         "allocatableBalance": "1000000000000000000",
         "allocatedBalance": "500000000000000000",
         "balanceAvailableToAllocate": "500000000000000000",
         "withdrawalStatus": 0
       }
     ]
   }
   ```

   Each balance entry follows the same rules as the single balance endpoint.

6. **Get Suggested Nonce**
   ```http
   GET /suggested-nonce/:chainId
   ```
   
   Requires a valid session ID in the `x-session-id` header.

   Returns the next available unused nonce for the account on the session for creating new compacts on a specific chain.

   Example response:
   ```json
   {
     "nonce": "0x70997970C51812dc3A010C7d01b50e0d17dc79C800000000000000000000001"
   }
   ```

## Development

### Prerequisites

- Node.js >= 18
- pnpm >= 9.14.1
- TypeScript >= 5.2

### Development

```bash
### Configuration & Installation ###
# 1. Clone this repo and enter cloned directory
git clone git@github.com:Uniswap/smallocator.git && cd smallocator

# 2. Copy example environment file (modify as needed)
cp .env.example .env

# 3. Install frontend and backend dependencies
pnpm install:all

# 4. Run tests
pnpm test


### Usage ###
# Run both frontend and backend in development mode with hot reload
pnpm dev:all

# Run tests
pnpm test

# Type checking
pnpm type-check

# Linting
pnpm lint

# Format code
pnpm format

# Build frontend and backend for production
pnpm build:all

# Start production server
pnpm start
```

### Testing

The project utilizes Jest to implement various test suites:

- Unit tests for core functionality
- Integration tests for API endpoints
- Validation tests for compact messages

Run all tests with:

```bash
pnpm test
```

### Code Quality

The project uses:

- ESLint for code linting
- Prettier for code formatting
- Husky for git hooks
- lint-staged for pre-commit checks

Pre-commit hooks ensure:

- Code is properly formatted
- Tests pass
- No TypeScript errors
- No ESLint warnings

## License

MIT
