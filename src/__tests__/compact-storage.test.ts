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

    // Mock GraphQL responses
    graphqlClient.request = async (): Promise<unknown> => ({
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
    });
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

      // Use a large counter value in the nonce
      const sponsorAddress = compact.sponsor.toLowerCase();
      const sponsorBigInt = BigInt('0x' + sponsorAddress.slice(2));
      const largeCounter = BigInt('0xFFFFFFFFFFFF'); // 48 bits, well within range
      compact.nonce = (sponsorBigInt << BigInt(96)) | largeCounter;

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

    it('should handle nonces with full uint256 range values', async () => {
      const compact = getFreshCompact();

      // Use a nonce with values that would overflow if treated as signed integers
      // Example: 0xff001122334455667788990011223344556677889900112233445566778899ff
      // Split: sponsor (20 bytes) + fragment (12 bytes)
      // We'll construct a nonce where the fragment has high values
      const sponsorAddress = compact.sponsor.toLowerCase();
      const sponsorBigInt = BigInt('0x' + sponsorAddress.slice(2));

      // Fragment with high bit values (this will test unsigned vs signed handling)
      // High 8 bytes: 0x9900112233445566 = 11025984847301887334 (> 2^63-1)
      // Low 4 bytes: 0x77889900 = 2005678336 (< 2^31-1 so this part is ok)
      const fragmentHigh = BigInt('0x9900112233445566');
      const fragmentLow = BigInt('0x77889900');
      const fragment = (fragmentHigh << BigInt(32)) | fragmentLow;

      compact.nonce = (sponsorBigInt << BigInt(96)) | fragment;

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

    it('should handle the exact nonce example: 0xff001122334455667788990011223344556677889900112233445566778899ff', async () => {
      const compact = getFreshCompact();

      // Use the exact nonce example: 0xff001122334455667788990011223344556677889900112233445566778899ff
      // Sponsor part (20 bytes): 0xff0011223344556677889900112233445566778899
      // Fragment part (12 bytes): 0x00112233445566778899ff
      const exampleNonce = BigInt(
        '0xff001122334455667788990011223344556677889900112233445566778899ff'
      );
      const exampleSponsor = '0xFF00112233445566778899001122334455667788';

      compact.sponsor = exampleSponsor;
      compact.arbiter = exampleSponsor;
      compact.nonce = exampleNonce;

      // Mock onchain registration to accept this compact since we don't have the private key
      // for this sponsor address
      const originalGraphQL = graphqlClient.request;
      graphqlClient.request = async (...args: unknown[]): Promise<unknown> => {
        const query =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] as { document?: string }).document || '';
        // If querying for registered compact, return ACTIVE status
        if (
          query.includes('registeredCompact') ||
          query.includes('GetRegisteredCompact')
        ) {
          return {
            registeredCompact: {
              blockNumber: '1000000',
              timestamp: '1000000',
              typehash:
                '0x0000000000000000000000000000000000000000000000000000000000000001',
              expires: (BigInt(compact.expires) + BigInt(1000)).toString(),
              sponsor: {
                address: exampleSponsor,
              },
              claim: null,
            },
          };
        }
        // Default mock response for other queries
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

      const compactData = compactToAPI(compact);

      // Use a dummy signature since we're relying on onchain registration
      const dummySignature =
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

      const submitResult = await submitCompact(
        server,
        { chainId: '1', compact: compactData },
        compact.sponsor,
        dummySignature
      );

      const retrieved = await getCompactByHash(server, '1', submitResult.hash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.compact.nonce).toBe(exampleNonce);

      // Verify the exact nonce value round-trips correctly
      const retrievedNonceHex =
        '0x' + retrieved!.compact.nonce.toString(16).padStart(64, '0');
      expect(retrievedNonceHex).toBe(
        '0xff001122334455667788990011223344556677889900112233445566778899ff'
      );

      // Restore original graphQL
      graphqlClient.request = originalGraphQL;
    });
  });
});
