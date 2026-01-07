import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  validPayload,
  getFreshCompact,
  cleanupTestServer,
  generateValidCompactSignature,
  compactToAPI,
} from '../utils/test-server';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  fetchAndCacheSupportedChains,
} from '../../graphql';

describe('Integration Tests', () => {
  let server: FastifyInstance;
  let originalRequest: typeof graphqlClient.request;
  const sponsorAddress = validPayload.address;

  beforeEach(async () => {
    // Ensure environment variables are set
    if (!process.env.ALLOCATOR_ADDRESS || !process.env.SIGNING_ADDRESS) {
      process.env.ALLOCATOR_ADDRESS =
        '0x2345678901234567890123456789012345678901';
      process.env.SIGNING_ADDRESS =
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    }

    server = await createTestServer();
    originalRequest = graphqlClient.request;

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);
  });

  afterEach(async () => {
    await cleanupTestServer();
    graphqlClient.request = originalRequest;
  });

  // Helper to convert API compact to the format expected by generateValidCompactSignature
  function apiCompactToStoredCompact(compact: {
    id: string;
    arbiter: string;
    sponsor: string;
    nonce: string | null;
    expires: string;
    amount: string;
    witnessTypeString: string | null;
    witnessHash: string | null;
  }): {
    id: bigint;
    arbiter: string;
    sponsor: string;
    nonce: bigint;
    expires: bigint;
    amount: string;
    witnessTypeString: string | null;
    witnessHash: string | null;
  } {
    return {
      id: BigInt(compact.id),
      arbiter: compact.arbiter,
      sponsor: compact.sponsor,
      nonce: compact.nonce ? BigInt(compact.nonce) : BigInt(0),
      expires: BigInt(compact.expires),
      amount: compact.amount,
      witnessTypeString: compact.witnessTypeString,
      witnessHash: compact.witnessHash,
    };
  }

  describe('Allocation Flow', () => {
    it('should handle complete allocation flow: nonce -> compact -> balance', async () => {
      // Mock GraphQL response with zero allocated balance
      graphqlClient.request = async (): Promise<
        AccountDeltasResponse & AccountResponse
      > => ({
        accountDeltas: {
          items: [],
        },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 0,
                balance: '1000000000000000000000', // 1000 ETH total
              },
            ],
          },
          claims: {
            items: [],
          },
        },
      });

      const freshCompact = getFreshCompact();

      // 1. Get initial suggested nonce
      const initialNonceResponse = await server.inject({
        method: 'GET',
        url: `/suggested-nonce/1/${sponsorAddress}`,
      });
      expect(initialNonceResponse.statusCode).toBe(200);
      const { nonce: initialNonce } = JSON.parse(initialNonceResponse.payload);

      // Use the suggested nonce in the compact so it gets consumed
      freshCompact.nonce = BigInt(initialNonce);

      // 2. Submit compact
      const compactData = compactToAPI(freshCompact);
      const storedCompact = apiCompactToStoredCompact(compactData);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const compactPayload = {
        chainId: '1',
        compact: compactData,
        sponsorSignature,
      };

      const submitResponse = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: compactPayload,
      });
      expect(submitResponse.statusCode).toBe(200);
      const submitResult = JSON.parse(submitResponse.payload);
      expect(submitResult).toHaveProperty('hash');

      // Query compacts table with normalized schema
      await server.db.query(`
        SELECT 
          c.id::text,
          c.chain_id,
          encode(c.claim_hash, 'hex') as claim_hash,
          encode(c.sponsor, 'hex') as sponsor,
          encode(c.nonce, 'hex') as nonce,
          c.expires,
          encode(ce.arbiter, 'hex') as arbiter,
          encode(cc.lock_tag, 'hex') as lock_tag,
          encode(cc.token, 'hex') as token,
          encode(cc.amount, 'hex') as amount,
          c.witness_type_string,
          encode(c.witness_hash, 'hex') as witness_hash,
          encode(c.signature, 'hex') as signature,
          c.created_at
        FROM compacts c
        LEFT JOIN compact_elements ce ON ce.compact_id = c.id
        LEFT JOIN compact_commitments cc ON cc.element_id = ce.id
      `);

      // 3. Verify updated balance
      const updatedBalanceResponse = await server.inject({
        method: 'GET',
        url: `/balance/1/${freshCompact.id}/${sponsorAddress}`,
      });
      expect(updatedBalanceResponse.statusCode).toBe(200);
      const updatedBalance = JSON.parse(updatedBalanceResponse.payload);
      expect(updatedBalance.allocatedBalance).toBe(
        freshCompact.amount.toString()
      );

      // 4. Verify next suggested nonce is incremented
      const nextNonceResponse = await server.inject({
        method: 'GET',
        url: `/suggested-nonce/1/${sponsorAddress}`,
      });
      expect(nextNonceResponse.statusCode).toBe(200);
      const { nonce: nextNonce } = JSON.parse(nextNonceResponse.payload);
      expect(nextNonce).not.toBe(initialNonce);

      // Convert hex strings to BigInts for comparison
      const initialNonceBigInt = BigInt(initialNonce);
      const nextNonceBigInt = BigInt(nextNonce);
      expect(nextNonceBigInt).toBeGreaterThan(initialNonceBigInt);
    });
  });
});
