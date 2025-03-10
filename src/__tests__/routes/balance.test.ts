import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  getFreshCompact,
  cleanupTestServer,
  validPayload,
} from '../utils/test-server';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  AllResourceLocksResponse,
  fetchAndCacheSupportedChains,
  SupportedChainsResponse,
} from '../../graphql';
import { RequestDocument, Variables, RequestOptions } from 'graphql-request';

describe('Balance Routes', () => {
  let server: FastifyInstance;
  let originalRequest: typeof graphqlClient.request;
  const sponsorAddress = validPayload.address;

  beforeEach(async () => {
    server = await createTestServer();

    // Store original function
    originalRequest = graphqlClient.request;

    // Mock GraphQL response
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = AccountDeltasResponse & AccountResponse & SupportedChainsResponse,
    >(
      documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<T> => {
      const query =
        typeof documentOrOptions === 'string'
          ? documentOrOptions
          : (documentOrOptions as RequestOptions).document.toString();

      if (query.includes('GetSupportedChains')) {
        return {
          allocator: {
            supportedChains: {
              items: [
                {
                  chainId: '1',
                  allocatorId: '1',
                },
              ],
            },
          },
        } as T;
      }

      return {
        accountDeltas: {
          items: [],
        },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 0,
                balance: '1000000000000000000000', // 1000 ETH
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      } as T;
    };

    // Cache the supported chains data
    await fetchAndCacheSupportedChains(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
    );
  });

  afterEach(async () => {
    await cleanupTestServer();
    // Restore original function
    graphqlClient.request = originalRequest;
  });

  describe('GET /balance/:chainId/:lockId', () => {
    it('should return balance information for valid lock', async () => {
      const freshCompact = getFreshCompact();
      const lockId = freshCompact.id.toString();

      const response = await server.inject({
        method: 'GET',
        url: `/balance/1/${lockId}/${sponsorAddress}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('allocatableBalance');
      expect(result).toHaveProperty('allocatedBalance');
      expect(result).toHaveProperty('balanceAvailableToAllocate');
      expect(result).toHaveProperty('withdrawalStatus');

      // Verify numeric string formats
      expect(/^\d+$/.test(result.allocatableBalance)).toBe(true);
      expect(/^\d+$/.test(result.allocatedBalance)).toBe(true);
      expect(/^\d+$/.test(result.balanceAvailableToAllocate)).toBe(true);
      expect(typeof result.withdrawalStatus).toBe('number');
    });

    it('should return 404 for missing path parameter', async () => {
      const freshCompact = getFreshCompact();
      const lockId = freshCompact.id.toString();

      const response = await server.inject({
        method: 'GET',
        url: `/balance/1/${lockId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for non-existent lock', async () => {
      // Store original function
      const originalRequest = graphqlClient.request;

      // Mock GraphQL response with no resource lock
      graphqlClient.request = async <
        V extends Variables = Variables,
        T = AccountDeltasResponse & AccountResponse & SupportedChainsResponse,
      >(
        documentOrOptions: RequestDocument | RequestOptions<V, T>,
        ..._variablesAndRequestHeaders: unknown[]
      ): Promise<T> => {
        const query =
          typeof documentOrOptions === 'string'
            ? documentOrOptions
            : (documentOrOptions as RequestOptions).document.toString();

        if (query.includes('GetSupportedChains')) {
          return {
            allocator: {
              supportedChains: {
                items: [
                  {
                    chainId: '1',
                    allocatorId: '1',
                  },
                ],
              },
            },
          } as T;
        }

        return {
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [], // Empty array indicates no resource lock found
            },
            claims: {
              items: [],
            },
          },
        } as T;
      };

      try {
        const response = await server.inject({
          method: 'GET',
          url: `/balance/1/0x0000000000000000000000000000000000000000000000000000000000000000/${sponsorAddress}`,
        });

        expect(response.statusCode).toBe(404);
      } finally {
        // Restore original function
        graphqlClient.request = originalRequest;
      }
    });

    it('should return zero balanceAvailableToAllocate when withdrawal enabled', async () => {
      // Store original function
      const originalRequest = graphqlClient.request;

      // Mock GraphQL response with withdrawal status = 1
      graphqlClient.request = async <
        V extends Variables = Variables,
        T = AccountDeltasResponse & AccountResponse & SupportedChainsResponse,
      >(
        documentOrOptions: RequestDocument | RequestOptions<V, T>,
        ..._variablesAndRequestHeaders: unknown[]
      ): Promise<T> => {
        const query =
          typeof documentOrOptions === 'string'
            ? documentOrOptions
            : (documentOrOptions as RequestOptions).document.toString();

        if (query.includes('GetSupportedChains')) {
          return {
            allocator: {
              supportedChains: {
                items: [
                  {
                    chainId: '1',
                    allocatorId: '1',
                  },
                ],
              },
            },
          } as T;
        }

        return {
          accountDeltas: {
            items: [],
          },
          account: {
            resourceLocks: {
              items: [
                {
                  withdrawalStatus: 1,
                  balance: '1000000000000000000000',
                },
              ],
            },
            claims: {
              items: [],
            },
          },
        } as T;
      };

      try {
        const freshCompact = getFreshCompact();
        const lockId = freshCompact.id.toString();

        const response = await server.inject({
          method: 'GET',
          url: `/balance/1/${lockId}/${sponsorAddress}`,
        });

        expect(response.statusCode).toBe(200);
        const result = JSON.parse(response.payload);
        expect(result.balanceAvailableToAllocate).toBe('0');
        expect(result.withdrawalStatus).toBe(1);
      } finally {
        // Restore original function
        graphqlClient.request = originalRequest;
      }
    });
  });

  describe('GET /balances', () => {
    it('should return balances for all resource locks', async () => {
      // Store original function
      const originalRequest = graphqlClient.request;

      // Mock GraphQL response for getAllResourceLocks
      let requestCount = 0;
      graphqlClient.request = async <
        V extends Variables = Variables,
        T =
          | AllResourceLocksResponse
          | (AccountDeltasResponse & AccountResponse)
          | SupportedChainsResponse,
      >(
        documentOrOptions: RequestDocument | RequestOptions<V, T>,
        ..._variablesAndRequestHeaders: unknown[]
      ): Promise<T> => {
        const query =
          typeof documentOrOptions === 'string'
            ? documentOrOptions
            : (documentOrOptions as RequestOptions).document.toString();

        if (query.includes('GetSupportedChains')) {
          return {
            allocator: {
              supportedChains: {
                items: [
                  {
                    chainId: '1',
                    allocatorId: '1',
                  },
                ],
              },
            },
          } as T;
        }

        requestCount++;
        if (requestCount === 1) {
          // First request - getAllResourceLocks
          return {
            account: {
              resourceLocks: {
                items: [
                  {
                    chainId: '1',
                    resourceLock: {
                      lockId: '0x1234',
                      allocatorAddress: process.env.ALLOCATOR_ADDRESS!, // Add non-null assertion
                    },
                  },
                  {
                    chainId: '2',
                    resourceLock: {
                      lockId: '0x5678',
                      allocatorAddress: 'different_address',
                    },
                  },
                ],
              },
            },
          } as T;
        } else {
          // Subsequent requests - getCompactDetails
          return {
            accountDeltas: {
              items: [],
            },
            account: {
              resourceLocks: {
                items: [
                  {
                    withdrawalStatus: 0,
                    balance: '1000000000000000000000',
                  },
                ],
              },
              claims: {
                items: [],
              },
            },
          } as T;
        }
      };

      try {
        const response = await server.inject({
          method: 'GET',
          url: `/balances/${sponsorAddress}`,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);

        expect(body).toHaveProperty('balances');
        expect(Array.isArray(body.balances)).toBe(true);
        expect(body.balances.length).toBe(1); // Only our allocator's locks

        const balance = body.balances[0];
        expect(balance).toHaveProperty('chainId', '1');
        expect(balance).toHaveProperty('lockId', '0x1234');
        expect(balance).toHaveProperty('allocatableBalance');
        expect(balance).toHaveProperty('allocatedBalance');
        expect(balance).toHaveProperty('balanceAvailableToAllocate');
        expect(balance).toHaveProperty('withdrawalStatus', 0);
      } finally {
        // Restore original function
        graphqlClient.request = originalRequest;
      }
    });

    it('should return 400 with invalid account address format', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/balances/invalid-address',
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toBe('Invalid account address format');
    });

    it('should handle case when no resource locks exist', async () => {
      // Store original function
      const originalRequest = graphqlClient.request;

      // Mock GraphQL response with no locks
      graphqlClient.request = async <
        V extends Variables = Variables,
        T = AllResourceLocksResponse | SupportedChainsResponse,
      >(
        documentOrOptions: RequestDocument | RequestOptions<V, T>,
        ..._variablesAndRequestHeaders: unknown[]
      ): Promise<T> => {
        const query =
          typeof documentOrOptions === 'string'
            ? documentOrOptions
            : (documentOrOptions as RequestOptions).document.toString();

        if (query.includes('GetSupportedChains')) {
          return {
            allocator: {
              supportedChains: {
                items: [
                  {
                    chainId: '1',
                    allocatorId: '1',
                  },
                ],
              },
            },
          } as T;
        }

        return {
          account: {
            resourceLocks: {
              items: [],
            },
          },
        } as T;
      };

      try {
        const response = await server.inject({
          method: 'GET',
          url: `/balances/${sponsorAddress}`,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);

        expect(body).toHaveProperty('balances');
        expect(Array.isArray(body.balances)).toBe(true);
        expect(body.balances.length).toBe(0);
      } finally {
        // Restore original function
        graphqlClient.request = originalRequest;
      }
    });
  });
});
