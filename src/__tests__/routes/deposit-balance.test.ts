import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  cleanupTestServer,
  validPayload,
} from '../utils/test-server';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  AllResourceLocksResponse,
  fetchAndCacheSupportedChains,
} from '../../graphql';
import { RequestDocument, Variables, RequestOptions } from 'graphql-request';
import { dbManager } from '../setup';
import { hexToBytes } from 'viem/utils';

describe('Deposit Balance Routes', () => {
  let server: FastifyInstance;
  let originalRequest: typeof graphqlClient.request;
  const realDateNow = Date.now;
  const sponsorAddress = validPayload.address;

  beforeEach(async () => {
    // Set up test server
    server = await createTestServer();

    // Store original function
    originalRequest = graphqlClient.request;

    // Mock current time
    Date.now = () => 1702152079000; // 2024-12-09T12:01:19-08:00

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);
  });

  afterEach(async () => {
    // Clean up
    await cleanupTestServer();
    Date.now = realDateNow;
    // Restore original function
    graphqlClient.request = originalRequest;
  });

  it('should reflect deposit in allocatable balance', async () => {
    const chainId = '10'; // Optimism
    const lockId =
      '0x1234567890123456789012345678901234567890123456789012345678901234';
    const currentBalance = '1000000000000000000'; // 1 ETH
    const pendingBalance = '500000000000000000'; // 0.5 ETH

    // Mock GraphQL responses
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = (AccountDeltasResponse & AccountResponse) | AllResourceLocksResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query = documentOrOptions.toString();

      if (query.includes('GetAllResourceLocks')) {
        return {
          account: {
            resourceLocks: {
              items: [
                {
                  chainId,
                  resourceLock: {
                    lockId,
                    allocatorAddress: process.env.ALLOCATOR_ADDRESS,
                  },
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes('GetDetails')) {
        return {
          accountDeltas: {
            items: [
              {
                delta: pendingBalance,
              },
            ],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: currentBalance,
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        } as T;
      }

      return {} as T;
    };

    // Get balances
    const response = await server.inject({
      method: 'GET',
      url: `/balances/${sponsorAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body).toHaveProperty('balances');
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBe(1);

    const balance = body.balances[0];
    expect(balance).toMatchObject({
      chainId,
      lockId,
      allocatableBalance: '500000000000000000', // Should be currentBalance - pendingBalance = 0.5 ETH
      allocatedBalance: '0',
      balanceAvailableToAllocate: '500000000000000000',
      withdrawalStatus: 0,
    });
  });

  it('should set allocatable balance to 0 when pending balance exceeds current balance', async () => {
    const chainId = '10'; // Optimism
    const lockId =
      '0x1234567890123456789012345678901234567890123456789012345678901234';
    const currentBalance = '1000000000000000000'; // 1 ETH
    const pendingBalance = '2000000000000000000'; // 2 ETH (exceeds current balance)

    // Mock GraphQL responses
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = (AccountDeltasResponse & AccountResponse) | AllResourceLocksResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query = documentOrOptions.toString();

      if (query.includes('GetAllResourceLocks')) {
        return {
          account: {
            resourceLocks: {
              items: [
                {
                  chainId,
                  resourceLock: {
                    lockId,
                    allocatorAddress: process.env.ALLOCATOR_ADDRESS,
                  },
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes('GetDetails')) {
        return {
          accountDeltas: {
            items: [
              {
                delta: pendingBalance, // Unfinalized deposit exceeds current balance
              },
            ],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: currentBalance,
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        } as T;
      }

      return {} as T;
    };

    // Get balances
    const response = await server.inject({
      method: 'GET',
      url: `/balances/${sponsorAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body).toHaveProperty('balances');
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBe(1);

    const balance = body.balances[0];
    expect(balance).toMatchObject({
      chainId,
      lockId,
      allocatableBalance: '0', // Should be 0 since pending balance exceeds current balance
      allocatedBalance: '0',
      balanceAvailableToAllocate: '0',
      withdrawalStatus: 0,
    });
  });

  it('should reflect finalized claims in allocated balance', async () => {
    const chainId = '10'; // Optimism
    const lockId =
      '0x1234567890123456789012345678901234567890123456789012345678901234';
    const currentBalance = '1000000000000000000'; // 1 ETH
    const pendingBalance = '0'; // No pending deposits
    const claimAmount = '300000000000000000'; // 0.3 ETH claimed

    // Mock GraphQL responses
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = (AccountDeltasResponse & AccountResponse) | AllResourceLocksResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query = documentOrOptions.toString();

      if (query.includes('GetAllResourceLocks')) {
        return {
          account: {
            resourceLocks: {
              items: [
                {
                  chainId,
                  resourceLock: {
                    lockId,
                    allocatorAddress: process.env.ALLOCATOR_ADDRESS,
                  },
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes('GetDetails')) {
        return {
          accountDeltas: {
            items: [
              {
                delta: pendingBalance,
              },
            ],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: currentBalance,
                },
              ],
            },
            claims: {
              items: [
                {
                  // Add a finalized claim
                  claimHash:
                    '0x1234567890123456789012345678901234567890123456789012345678901234',
                  amount: claimAmount,
                  isFinalized: true,
                },
              ],
            },
          },
        } as T;
      }

      return {} as T;
    };

    // Get balances
    const response = await server.inject({
      method: 'GET',
      url: `/balances/${sponsorAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body).toHaveProperty('balances');
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBe(1);

    const balance = body.balances[0];
    expect(balance).toMatchObject({
      chainId,
      lockId,
      allocatableBalance: '1000000000000000000', // Full 1 ETH since no pending deposits
      allocatedBalance: '0', // 0 ETH since the claim is finalized (already processed)
      balanceAvailableToAllocate: '1000000000000000000', // 1 ETH (currentBalance since no allocated balance)
      withdrawalStatus: 0,
    });
  });

  it('should reduce allocatable balance by finalized claims', async () => {
    const chainId = '10'; // Optimism
    const lockId =
      '0x1234567890123456789012345678901234567890123456789012345678901234';
    const currentBalance = '1000000000000000000'; // 1 ETH
    const pendingBalance = '0';

    // Define our test amounts
    const finalizedAmount = '300000000000000000'; // 0.3 ETH (processed)
    const unprocessedAmount = '200000000000000000'; // 0.2 ETH (not expired)
    const expiredAmount = '100000000000000000'; // 0.1 ETH (expired)

    // Current time in seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Insert test compacts into database
    const db = await dbManager.getDb();

    // Helper to insert a test compact using the new normalized schema
    async function insertTestCompact(
      compactId: string,
      claimHash: string,
      arbiter: string,
      sponsor: string,
      nonce: string,
      expires: number,
      lockTag: string, // 12 bytes for lock_tag
      token: string, // 20 bytes for token
      amount: string,
      signature: string
    ) {
      // Generate unique element and commitment IDs by modifying the UUID
      // Replace first char of last segment with 'e' for element, 'c' for commitment
      const elementId = compactId.replace(/-(\w)(\w{11})$/, '-e$2');
      const commitmentId = compactId.replace(/-(\w)(\w{11})$/, '-f$2');

      // Insert into compacts table
      await db.query(
        `INSERT INTO compacts (id, chain_id, claim_hash, compact_type, sponsor, nonce, expires, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          compactId,
          chainId,
          hexToBytes(claimHash as `0x${string}`),
          0, // Legacy compact type
          hexToBytes(sponsor as `0x${string}`),
          hexToBytes(nonce as `0x${string}`),
          expires,
          hexToBytes(signature as `0x${string}`),
        ]
      );

      // Insert into compact_elements table
      await db.query(
        `INSERT INTO compact_elements (id, compact_id, element_index, arbiter, chain_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [elementId, compactId, 0, hexToBytes(arbiter as `0x${string}`), chainId]
      );

      // Insert into compact_commitments table
      await db.query(
        `INSERT INTO compact_commitments (id, element_id, lock_tag, token, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          commitmentId,
          elementId,
          hexToBytes(lockTag as `0x${string}`),
          hexToBytes(token as `0x${string}`),
          hexToBytes(
            ('0x' +
              BigInt(amount).toString(16).padStart(64, '0')) as `0x${string}`
          ),
        ]
      );
    }

    // Extract lock_tag (12 bytes) and token (20 bytes) from lockId
    // lockId is 32 bytes: upper 12 bytes = lock_tag, lower 20 bytes = token
    const lockTagHex = lockId.slice(0, 26); // 0x + 24 hex chars = 12 bytes
    const tokenHex = '0x' + lockId.slice(26); // remaining 40 hex chars = 20 bytes

    // 1. Insert finalized compact (already processed)
    await insertTestCompact(
      '123e4567-e89b-12d3-a456-426614174002',
      '0x1234567890123456789012345678901234567890123456789012345678901234', // Same as finalized claim hash
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000003',
      currentTime + 3600, // Not expired, but finalized via claim
      lockTagHex,
      tokenHex,
      finalizedAmount,
      '0x1234000000000000000000000000000000000000000000000000000000001236'
    );

    // 2. Insert unprocessed compact (not expired)
    await insertTestCompact(
      '123e4567-e89b-12d3-a456-426614174000',
      '0x2000000000000000000000000000000000000000000000000000000000000001',
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      currentTime + 3600, // Expires in 1 hour
      lockTagHex,
      tokenHex,
      unprocessedAmount,
      '0x1234000000000000000000000000000000000000000000000000000000001234'
    );

    // 3. Insert expired compact
    await insertTestCompact(
      '123e4567-e89b-12d3-a456-426614174001',
      '0x3000000000000000000000000000000000000000000000000000000000000001',
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000002',
      currentTime - 3600, // Expired 1 hour ago
      lockTagHex,
      tokenHex,
      expiredAmount,
      '0x1234000000000000000000000000000000000000000000000000000000001235'
    );

    // Mock GraphQL responses
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = (AccountDeltasResponse & AccountResponse) | AllResourceLocksResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query = documentOrOptions.toString();

      if (query.includes('GetAllResourceLocks')) {
        return {
          account: {
            resourceLocks: {
              items: [
                {
                  chainId,
                  resourceLock: {
                    lockId,
                    allocatorAddress: process.env.ALLOCATOR_ADDRESS,
                  },
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes('GetDetails')) {
        return {
          accountDeltas: {
            items: [
              {
                delta: pendingBalance,
              },
            ],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 0,
                  balance: currentBalance,
                },
              ],
            },
            claims: {
              items: [
                {
                  // Add a finalized claim
                  claimHash:
                    '0x1234567890123456789012345678901234567890123456789012345678901234',
                  amount: finalizedAmount,
                  isFinalized: true,
                },
              ],
            },
          },
        } as T;
      }

      return {} as T;
    };

    // Get balances
    const response = await server.inject({
      method: 'GET',
      url: `/balances/${sponsorAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body).toHaveProperty('balances');
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBe(1);

    const balance = body.balances[0];
    expect(balance).toMatchObject({
      chainId,
      lockId,
      allocatableBalance: '1000000000000000000', // Full 1 ETH since no pending deposits
      allocatedBalance: '200000000000000000', // 0.2 ETH (only the unprocessed, non-expired compact)
      balanceAvailableToAllocate: '800000000000000000', // 0.8 ETH (currentBalance - allocatedBalance)
      withdrawalStatus: 0,
    });
  });

  it('should handle multiple compacts with pending deposits and withdrawal enabled', async () => {
    const chainId = '10'; // Optimism
    const lockId =
      '0x1234567890123456789012345678901234567890123456789012345678901234';
    const currentBalance = '1000000000000000000'; // 1 ETH
    const pendingBalance = '500000000000000000'; // 0.5 ETH pending deposit

    // Define our test amounts
    const finalizedAmount = '300000000000000000'; // 0.3 ETH (processed)
    const unprocessedAmount = '200000000000000000'; // 0.2 ETH (not expired)
    const expiredAmount = '100000000000000000'; // 0.1 ETH (expired)

    // Current time in seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Insert test compacts into database
    const db = await dbManager.getDb();

    // Helper to insert a test compact using the new normalized schema
    // Use different UUIDs for this test to avoid conflicts with the previous test
    async function insertTestCompact(
      compactId: string,
      claimHash: string,
      arbiter: string,
      sponsor: string,
      nonce: string,
      expires: number,
      lockTag: string, // 12 bytes for lock_tag
      token: string, // 20 bytes for token
      amount: string,
      signature: string
    ) {
      // Generate unique element and commitment IDs by modifying the UUID
      // Replace first char of last segment with 'a' for element, 'b' for commitment
      const elementId = compactId.replace(/-(\w)(\w{11})$/, '-a$2');
      const commitmentId = compactId.replace(/-(\w)(\w{11})$/, '-b$2');

      // Insert into compacts table
      await db.query(
        `INSERT INTO compacts (id, chain_id, claim_hash, compact_type, sponsor, nonce, expires, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          compactId,
          chainId,
          hexToBytes(claimHash as `0x${string}`),
          0, // Legacy compact type
          hexToBytes(sponsor as `0x${string}`),
          hexToBytes(nonce as `0x${string}`),
          expires,
          hexToBytes(signature as `0x${string}`),
        ]
      );

      // Insert into compact_elements table
      await db.query(
        `INSERT INTO compact_elements (id, compact_id, element_index, arbiter, chain_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [elementId, compactId, 0, hexToBytes(arbiter as `0x${string}`), chainId]
      );

      // Insert into compact_commitments table
      await db.query(
        `INSERT INTO compact_commitments (id, element_id, lock_tag, token, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          commitmentId,
          elementId,
          hexToBytes(lockTag as `0x${string}`),
          hexToBytes(token as `0x${string}`),
          hexToBytes(
            ('0x' +
              BigInt(amount).toString(16).padStart(64, '0')) as `0x${string}`
          ),
        ]
      );
    }

    // Extract lock_tag (12 bytes) and token (20 bytes) from lockId
    // lockId is 32 bytes: upper 12 bytes = lock_tag, lower 20 bytes = token
    const lockTagHex = lockId.slice(0, 26); // 0x + 24 hex chars = 12 bytes
    const tokenHex = '0x' + lockId.slice(26); // remaining 40 hex chars = 20 bytes

    // Use different UUIDs for this test (xxxxx5 series) to avoid conflicts with the previous test (xxxxx0-2 series)
    // 1. Insert finalized compact (already processed)
    await insertTestCompact(
      'a23e4567-e89b-12d3-a456-426614174005',
      '0x1234567890123456789012345678901234567890123456789012345678901234', // Same as finalized claim hash
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000013',
      currentTime + 3600, // Not expired, but finalized via claim
      lockTagHex,
      tokenHex,
      finalizedAmount,
      '0x1234000000000000000000000000000000000000000000000000000000002236'
    );

    // 2. Insert unprocessed compact (not expired)
    await insertTestCompact(
      'a23e4567-e89b-12d3-a456-426614174003',
      '0x4000000000000000000000000000000000000000000000000000000000000001',
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000011',
      currentTime + 3600, // Expires in 1 hour
      lockTagHex,
      tokenHex,
      unprocessedAmount,
      '0x1234000000000000000000000000000000000000000000000000000000002234'
    );

    // 3. Insert expired compact
    await insertTestCompact(
      'a23e4567-e89b-12d3-a456-426614174004',
      '0x5000000000000000000000000000000000000000000000000000000000000001',
      '0x1230000000000000000000000000000000000123',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x0000000000000000000000000000000000000000000000000000000000000012',
      currentTime - 3600, // Expired 1 hour ago
      lockTagHex,
      tokenHex,
      expiredAmount,
      '0x1234000000000000000000000000000000000000000000000000000000002235'
    );

    // Mock GraphQL responses
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = (AccountDeltasResponse & AccountResponse) | AllResourceLocksResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query = documentOrOptions.toString();

      if (query.includes('GetAllResourceLocks')) {
        return {
          account: {
            resourceLocks: {
              items: [
                {
                  chainId,
                  resourceLock: {
                    lockId,
                    allocatorAddress: process.env.ALLOCATOR_ADDRESS,
                  },
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes('GetDetails')) {
        return {
          accountDeltas: {
            items: [
              {
                delta: pendingBalance,
              },
            ],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 1, // Withdrawal enabled
                  balance: currentBalance,
                },
              ],
            },
            claims: {
              items: [
                {
                  // Add a finalized claim (same hash as the finalized compact)
                  claimHash:
                    '0x1234567890123456789012345678901234567890123456789012345678901234',
                  amount: finalizedAmount,
                  isFinalized: true,
                },
              ],
            },
          },
        } as T;
      }

      return {} as T;
    };

    // Get balances
    const response = await server.inject({
      method: 'GET',
      url: `/balances/${sponsorAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body).toHaveProperty('balances');
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBe(1);

    const balance = body.balances[0];
    expect(balance).toMatchObject({
      chainId,
      lockId,
      allocatableBalance: '500000000000000000', // currentBalance - pendingBalance = 0.5 ETH
      allocatedBalance: '200000000000000000', // 0.2 ETH (only the unprocessed, non-expired compact)
      balanceAvailableToAllocate: '0', // 0 since withdrawal is enabled
      withdrawalStatus: 1,
    });
  });
});
