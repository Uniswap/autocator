import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  cleanupTestServer,
  getFreshCompact,
  compactToAPI,
  generateValidCompactSignature,
} from './utils/test-server';
import {
  getCompactsByAddress,
  getCompactByHash,
  submitCompact,
} from '../compact';
import { graphqlClient } from '../graphql';

describe('Compact Storage and Retrieval', () => {
  let server: FastifyInstance;
  let originalRequest: typeof graphqlClient.request;

  beforeEach(async () => {
    server = await createTestServer();
    originalRequest = graphqlClient.request;

    // Mock GraphQL responses - handle different query types
    graphqlClient.request = async (
      document: unknown,
      _variables?: Record<string, unknown>
    ): Promise<unknown> => {
      // Extract query string from document
      const query =
        typeof document === 'string'
          ? document
          : (document as { source?: string }).source || String(document);

      // Handle GetAllocations query for on-chain allocated balance
      if (
        query.includes('GetAllocations') ||
        query.includes('allocations(where')
      ) {
        return { allocations: { items: [] } };
      }

      // Handle GetSupportedChains query
      if (query.includes('GetSupportedChains')) {
        return {
          allocator: {
            supportedChains: {
              items: [
                { chainId: '1', allocatorId: '1' },
                { chainId: '10', allocatorId: '1' },
                { chainId: '8453', allocatorId: '1' },
              ],
            },
          },
        };
      }

      // Handle CheckConsumedNonce query
      if (
        query.includes('CheckConsumedNonce') ||
        query.includes('consumedNonce')
      ) {
        return { consumedNonce: null };
      }

      // Handle GetFinalizedRegisteredCompact query
      if (query.includes('registeredCompacts')) {
        return { registeredCompacts: { items: [] } };
      }

      // Handle health check query
      if (query.includes('HealthCheck') || query.includes('__typename')) {
        return { __typename: 'Query' };
      }

      // Default response for compact details (GetDetails)
      return {
        accountDeltas: { items: [] },
        account: {
          resourceLocks: {
            items: [
              {
                withdrawalStatus: 0,
                balance: '1000000000000000000000',
              },
            ],
          },
          claims: { items: [] },
        },
      };
    };
  });

  afterEach(async () => {
    graphqlClient.request = originalRequest;
    await cleanupTestServer();
  });

  describe('submitCompact and storage', () => {
    it('should store a compact and make it retrievable', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const sponsorSignature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const result = await submitCompact(
        server,
        {
          chainId: '1',
          compact: compactData,
        },
        compact.sponsor,
        sponsorSignature
      );

      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('nonce');
      expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.signature).toMatch(/^0x[a-fA-F0-9]{128}$/);
    });

    it('should reject duplicate compact submissions', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const sponsorSignature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      // First submission should succeed
      await submitCompact(
        server,
        {
          chainId: '1',
          compact: compactData,
        },
        compact.sponsor,
        sponsorSignature
      );

      // Second submission with same nonce should fail
      await expect(
        submitCompact(
          server,
          {
            chainId: '1',
            compact: compactData,
          },
          compact.sponsor,
          sponsorSignature
        )
      ).rejects.toThrow();
    });
  });

  describe('getCompactsByAddress', () => {
    it('should return empty array for address with no compacts', async () => {
      const compacts = await getCompactsByAddress(
        server,
        '0x0000000000000000000000000000000000000001'
      );
      expect(compacts).toEqual([]);
    });

    it('should retrieve all compacts for a given sponsor address', async () => {
      const compact1 = getFreshCompact();
      const compact2 = getFreshCompact();

      // Submit first compact
      const compactData1 = compactToAPI(compact1);
      const signature1 = await generateValidCompactSignature(
        {
          id: compact1.id,
          arbiter: compact1.arbiter,
          sponsor: compact1.sponsor,
          nonce: compact1.nonce,
          expires: compact1.expires,
          amount: compact1.amount,
          witnessTypeString: compact1.witnessTypeString,
          witnessHash: compact1.witnessHash,
        },
        '1'
      );
      await submitCompact(
        server,
        { chainId: '1', compact: compactData1 },
        compact1.sponsor,
        signature1
      );

      // Submit second compact
      const compactData2 = compactToAPI(compact2);
      const signature2 = await generateValidCompactSignature(
        {
          id: compact2.id,
          arbiter: compact2.arbiter,
          sponsor: compact2.sponsor,
          nonce: compact2.nonce,
          expires: compact2.expires,
          amount: compact2.amount,
          witnessTypeString: compact2.witnessTypeString,
          witnessHash: compact2.witnessHash,
        },
        '1'
      );
      await submitCompact(
        server,
        { chainId: '1', compact: compactData2 },
        compact2.sponsor,
        signature2
      );

      // Retrieve compacts
      const compacts = await getCompactsByAddress(server, compact1.sponsor);

      expect(compacts).toHaveLength(2);
      expect(compacts[0].chainId).toBe(1);
      expect(compacts[0].compact.sponsor.toLowerCase()).toBe(
        compact1.sponsor.toLowerCase()
      );
      expect(compacts[1].compact.sponsor.toLowerCase()).toBe(
        compact2.sponsor.toLowerCase()
      );
    });

    it('should return compacts in descending order by creation time', async () => {
      const compact1 = getFreshCompact();
      const compact2 = getFreshCompact();

      // Submit first compact
      const compactData1 = compactToAPI(compact1);
      const signature1 = await generateValidCompactSignature(
        {
          id: compact1.id,
          arbiter: compact1.arbiter,
          sponsor: compact1.sponsor,
          nonce: compact1.nonce,
          expires: compact1.expires,
          amount: compact1.amount,
          witnessTypeString: compact1.witnessTypeString,
          witnessHash: compact1.witnessHash,
        },
        '1'
      );
      await submitCompact(
        server,
        { chainId: '1', compact: compactData1 },
        compact1.sponsor,
        signature1
      );

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Submit second compact
      const compactData2 = compactToAPI(compact2);
      const signature2 = await generateValidCompactSignature(
        {
          id: compact2.id,
          arbiter: compact2.arbiter,
          sponsor: compact2.sponsor,
          nonce: compact2.nonce,
          expires: compact2.expires,
          amount: compact2.amount,
          witnessTypeString: compact2.witnessTypeString,
          witnessHash: compact2.witnessHash,
        },
        '1'
      );
      await submitCompact(
        server,
        { chainId: '1', compact: compactData2 },
        compact2.sponsor,
        signature2
      );

      // Retrieve compacts
      const compacts = await getCompactsByAddress(server, compact1.sponsor);

      expect(compacts).toHaveLength(2);
      // Most recent should be first
      expect(compacts[0].compact.nonce).toBe(compact2.nonce);
      expect(compacts[1].compact.nonce).toBe(compact1.nonce);
    });

    it('should handle address case insensitivity', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      // Query with lowercase
      const compactsLower = await getCompactsByAddress(
        server,
        compact.sponsor.toLowerCase()
      );
      // Query with uppercase (will be normalized)
      const compactsUpper = await getCompactsByAddress(
        server,
        compact.sponsor.toUpperCase()
      );

      expect(compactsLower).toHaveLength(1);
      expect(compactsUpper).toHaveLength(1);
      expect(compactsLower[0].hash).toBe(compactsUpper[0].hash);
    });

    it('should not return compacts from different sponsors', async () => {
      const compact1 = getFreshCompact();
      const compactData1 = compactToAPI(compact1);
      const signature1 = await generateValidCompactSignature(
        {
          id: compact1.id,
          arbiter: compact1.arbiter,
          sponsor: compact1.sponsor,
          nonce: compact1.nonce,
          expires: compact1.expires,
          amount: compact1.amount,
          witnessTypeString: compact1.witnessTypeString,
          witnessHash: compact1.witnessHash,
        },
        '1'
      );

      await submitCompact(
        server,
        { chainId: '1', compact: compactData1 },
        compact1.sponsor,
        signature1
      );

      // Query for different address
      const compacts = await getCompactsByAddress(
        server,
        '0x0000000000000000000000000000000000000001'
      );

      expect(compacts).toHaveLength(0);
    });
  });

  describe('getCompactByHash', () => {
    it('should return null for non-existent compact', async () => {
      const result = await getCompactByHash(
        server,
        '1',
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      );
      expect(result).toBeNull();
    });

    it('should retrieve a compact by chain ID and claim hash', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      // Retrieve by hash
      const result = await getCompactByHash(server, '1', submitResult.hash);

      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(1);
      expect(result!.hash).toBe(submitResult.hash);
      expect(result!.signature).toBe(submitResult.signature);
      expect(result!.compact.sponsor.toLowerCase()).toBe(
        compact.sponsor.toLowerCase()
      );
      expect(result!.compact.nonce).toBe(compact.nonce);
    });

    it('should return null for correct hash but wrong chain ID', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      // Try to retrieve with wrong chain ID
      const result = await getCompactByHash(server, '137', submitResult.hash);

      expect(result).toBeNull();
    });

    it('should handle multiple compacts and retrieve the correct one', async () => {
      const compact1 = getFreshCompact();
      const compact2 = getFreshCompact();

      // Submit first compact
      const compactData1 = compactToAPI(compact1);
      const signature1 = await generateValidCompactSignature(
        {
          id: compact1.id,
          arbiter: compact1.arbiter,
          sponsor: compact1.sponsor,
          nonce: compact1.nonce,
          expires: compact1.expires,
          amount: compact1.amount,
          witnessTypeString: compact1.witnessTypeString,
          witnessHash: compact1.witnessHash,
        },
        '1'
      );
      const result1 = await submitCompact(
        server,
        { chainId: '1', compact: compactData1 },
        compact1.sponsor,
        signature1
      );

      // Submit second compact
      const compactData2 = compactToAPI(compact2);
      const signature2 = await generateValidCompactSignature(
        {
          id: compact2.id,
          arbiter: compact2.arbiter,
          sponsor: compact2.sponsor,
          nonce: compact2.nonce,
          expires: compact2.expires,
          amount: compact2.amount,
          witnessTypeString: compact2.witnessTypeString,
          witnessHash: compact2.witnessHash,
        },
        '1'
      );
      const result2 = await submitCompact(
        server,
        { chainId: '1', compact: compactData2 },
        compact2.sponsor,
        signature2
      );

      // Retrieve first compact
      const retrieved1 = await getCompactByHash(server, '1', result1.hash);
      expect(retrieved1).not.toBeNull();
      expect(retrieved1!.compact.nonce).toBe(compact1.nonce);

      // Retrieve second compact
      const retrieved2 = await getCompactByHash(server, '1', result2.hash);
      expect(retrieved2).not.toBeNull();
      expect(retrieved2!.compact.nonce).toBe(compact2.nonce);
    });

    it('should return compacts with correct data types', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      const result = await getCompactByHash(server, '1', submitResult.hash);

      expect(result).not.toBeNull();
      expect(typeof result!.chainId).toBe('number');
      expect(typeof result!.compact.id).toBe('bigint');
      expect(typeof result!.compact.nonce).toBe('bigint');
      expect(typeof result!.compact.expires).toBe('bigint');
      expect(typeof result!.compact.amount).toBe('string');
      expect(typeof result!.compact.arbiter).toBe('string');
      expect(typeof result!.compact.sponsor).toBe('string');
      expect(typeof result!.hash).toBe('string');
      expect(typeof result!.signature).toBe('string');
      // createdAt can be either string or Date object depending on database driver
      expect(['string', 'object']).toContain(typeof result!.createdAt);
    });
  });

  describe('Cross-chain storage', () => {
    it('should store compacts for different chains independently', async () => {
      const compact1 = getFreshCompact();
      const compact2 = getFreshCompact();

      // Submit to chain 1
      const compactData1 = compactToAPI(compact1);
      const signature1 = await generateValidCompactSignature(
        {
          id: compact1.id,
          arbiter: compact1.arbiter,
          sponsor: compact1.sponsor,
          nonce: compact1.nonce,
          expires: compact1.expires,
          amount: compact1.amount,
          witnessTypeString: compact1.witnessTypeString,
          witnessHash: compact1.witnessHash,
        },
        '1'
      );
      const result1 = await submitCompact(
        server,
        { chainId: '1', compact: compactData1 },
        compact1.sponsor,
        signature1
      );

      // Submit to chain 10 (Optimism - a supported chain)
      const compactData2 = compactToAPI(compact2);
      const signature2 = await generateValidCompactSignature(
        {
          id: compact2.id,
          arbiter: compact2.arbiter,
          sponsor: compact2.sponsor,
          nonce: compact2.nonce,
          expires: compact2.expires,
          amount: compact2.amount,
          witnessTypeString: compact2.witnessTypeString,
          witnessHash: compact2.witnessHash,
        },
        '10'
      );
      const result2 = await submitCompact(
        server,
        { chainId: '10', compact: compactData2 },
        compact2.sponsor,
        signature2
      );

      // Verify they're stored separately
      const retrieved1 = await getCompactByHash(server, '1', result1.hash);
      const retrieved2 = await getCompactByHash(server, '10', result2.hash);

      expect(retrieved1).not.toBeNull();
      expect(retrieved2).not.toBeNull();
      expect(retrieved1!.chainId).toBe(1);
      expect(retrieved2!.chainId).toBe(10);

      // Verify cross-retrieval doesn't work
      const crossRetrieve1 = await getCompactByHash(server, '10', result1.hash);
      const crossRetrieve2 = await getCompactByHash(server, '1', result2.hash);
      expect(crossRetrieve1).toBeNull();
      expect(crossRetrieve2).toBeNull();
    });
  });

  describe('Data integrity', () => {
    it('should preserve all compact fields through storage and retrieval', async () => {
      const compact = getFreshCompact();
      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      const retrieved = await getCompactByHash(server, '1', submitResult.hash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.compact.id).toBe(compact.id);
      expect(retrieved!.compact.arbiter.toLowerCase()).toBe(
        compact.arbiter.toLowerCase()
      );
      expect(retrieved!.compact.sponsor.toLowerCase()).toBe(
        compact.sponsor.toLowerCase()
      );
      expect(retrieved!.compact.nonce).toBe(compact.nonce);
      expect(retrieved!.compact.expires).toBe(compact.expires);
      expect(retrieved!.compact.amount).toBe(compact.amount);
    });

    it('should correctly handle large BigInt values', async () => {
      const compact = getFreshCompact();

      // Use default ID from getFreshCompact() - we're testing nonce handling, not ID validation

      // Use a large fragment value in the hybrid nonce
      // Hybrid nonce: command (1 byte) + sponsor (20 bytes) + fragment (11 bytes)
      const sponsorBigInt = BigInt(compact.sponsor);
      const command = BigInt(0x02); // OFF_CHAIN
      const largeFragment = BigInt('0xFFFFFFFFFFF'); // 44 bits, well within 88-bit fragment range
      compact.nonce =
        (command << BigInt(248)) |
        (sponsorBigInt << BigInt(88)) |
        largeFragment;

      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      const retrieved = await getCompactByHash(server, '1', submitResult.hash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.compact.id).toBe(compact.id);
      expect(retrieved!.compact.nonce).toBe(compact.nonce);
    });

    it('should handle nonces with high fragment values in hybrid format', async () => {
      const compact = getFreshCompact();

      // Use a hybrid nonce with high fragment values that would overflow if treated as signed integers
      // Hybrid nonce: command (1 byte) + sponsor (20 bytes) + fragment (11 bytes)
      const sponsorBigInt = BigInt(compact.sponsor);
      const command = BigInt(0x02); // OFF_CHAIN

      // Fragment with high bit values (this will test unsigned vs signed handling)
      // 88-bit fragment with high bits set
      const fragment = BigInt('0xFFFFFFFFFFFFFFFFFF'); // 72 bits of 1s, within 88-bit range

      compact.nonce =
        (command << BigInt(248)) | (sponsorBigInt << BigInt(88)) | fragment;

      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      const retrieved = await getCompactByHash(server, '1', submitResult.hash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.compact.nonce).toBe(compact.nonce);

      // Verify the nonce round-trips correctly
      const retrievedNonceHex = retrieved!.compact.nonce
        .toString(16)
        .padStart(64, '0');
      const originalNonceHex = compact.nonce.toString(16).padStart(64, '0');
      expect(retrievedNonceHex).toBe(originalNonceHex);
    });

    it('should handle hybrid nonce with maximum fragment value', async () => {
      const compact = getFreshCompact();

      // Create a hybrid nonce with maximum fragment value (11 bytes = 88 bits max)
      // Hybrid nonce: command (1 byte) + sponsor (20 bytes) + fragment (11 bytes)
      const command = BigInt(0x02); // OFF_CHAIN
      const sponsorBigInt = BigInt(compact.sponsor);
      // Maximum 88-bit fragment value: 2^88 - 1
      const maxFragment = (BigInt(1) << BigInt(88)) - BigInt(1);

      const exampleNonce =
        (command << BigInt(248)) | (sponsorBigInt << BigInt(88)) | maxFragment;
      compact.nonce = exampleNonce;

      const compactData = compactToAPI(compact);
      const signature = await generateValidCompactSignature(
        {
          id: compact.id,
          arbiter: compact.arbiter,
          sponsor: compact.sponsor,
          nonce: compact.nonce,
          expires: compact.expires,
          amount: compact.amount,
          witnessTypeString: compact.witnessTypeString,
          witnessHash: compact.witnessHash,
        },
        '1'
      );

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        signature
      );

      const retrieved = await getCompactByHash(server, '1', submitResult.hash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.compact.nonce).toBe(exampleNonce);

      // Verify the nonce value round-trips correctly
      const retrievedNonceHex =
        '0x' + retrieved!.compact.nonce.toString(16).padStart(64, '0');
      const originalNonceHex =
        '0x' + exampleNonce.toString(16).padStart(64, '0');
      expect(retrievedNonceHex).toBe(originalNonceHex);
    });
  });
});
