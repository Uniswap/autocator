import { FastifyInstance } from 'fastify';
import {
  createTestServer,
  validPayload,
  getFreshCompact,
  cleanupTestServer,
  compactToAPI,
  generateValidCompactSignature,
} from '../utils/test-server';
import {
  graphqlClient,
  AccountDeltasResponse,
  AccountResponse,
  fetchAndCacheSupportedChains,
} from '../../graphql';
import { RequestDocument, Variables, RequestOptions } from 'graphql-request';
import { hexToBytes } from 'viem/utils';
import { CompactMessage } from '../../validation/types';
import { StoredCompactMessage } from '../../compact';

describe('Compact Routes', () => {
  let server: FastifyInstance;
  let originalRequest: typeof graphqlClient.request;

  beforeEach(async () => {
    server = await createTestServer();

    // Store original function
    originalRequest = graphqlClient.request;

    // Initialize chain config cache
    await fetchAndCacheSupportedChains(process.env.ALLOCATOR_ADDRESS!);

    // Mock GraphQL response
    graphqlClient.request = async <
      V extends Variables = Variables,
      T = AccountDeltasResponse & AccountResponse,
    >(
      _documentOrOptions: RequestDocument | RequestOptions<V, T>,
      ..._variablesAndRequestHeaders: unknown[]
    ): Promise<AccountDeltasResponse & AccountResponse> => ({
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
    });
  });

  afterEach(async () => {
    await cleanupTestServer();
    // Restore original function
    graphqlClient.request = originalRequest;
  });

  // Helper to convert API compact to the format expected by generateValidCompactSignature
  function apiCompactToStoredCompact(
    compact: CompactMessage
  ): StoredCompactMessage {
    if (compact.nonce === null) {
      throw new Error(
        'Nonce cannot be null when converting to StoredCompactMessage'
      );
    }

    return {
      id: BigInt(compact.id),
      arbiter: compact.arbiter,
      sponsor: compact.sponsor,
      nonce: BigInt(compact.nonce),
      expires: BigInt(compact.expires),
      amount: compact.amount,
      witnessTypeString: compact.witnessTypeString,
      witnessHash: compact.witnessHash,
    };
  }

  describe('GET /suggested-nonce/:chainId/:account', () => {
    it('should return a valid nonce for an account', async () => {
      const sponsorAddress = validPayload.address;
      const response = await server.inject({
        method: 'GET',
        url: `/suggested-nonce/1/${sponsorAddress}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('nonce');
      expect(result.nonce).toMatch(/^0x[0-9a-f]{64}$/i);

      // Verify hybrid nonce format:
      // - Byte 0 (hex chars 0-1): command (0x02 = OFF_CHAIN)
      // - Bytes 1-20 (hex chars 2-41): sponsor address
      // - Bytes 21-31 (hex chars 42-63): fragment
      const nonceHex = BigInt(result.nonce).toString(16).padStart(64, '0');

      // First byte should be 0x02 (OFF_CHAIN command)
      expect(nonceHex.slice(0, 2)).toBe('02');

      // Bytes 1-20 should match sponsor address
      const sponsorHex = sponsorAddress.toLowerCase().slice(2);
      expect(nonceHex.slice(2, 42)).toBe(sponsorHex);
    });

    it('should reject request with invalid account address', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/suggested-nonce/1/0xinvalid',
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toBe('Invalid account address format');
    });
  });

  describe('POST /compact', () => {
    it('should submit valid compact with sponsor signature', async () => {
      const freshCompact = getFreshCompact();
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

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: compactPayload,
      });

      if (response.statusCode !== 200) {
        console.error('Error submitting compact:', response.payload);
      }

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('nonce');
      expect(result.nonce).toBe(
        '0x' + freshCompact.nonce.toString(16).padStart(64, '0')
      );
    });

    it('should reject request without sponsor signature', async () => {
      const freshCompact = getFreshCompact();
      const compactPayload = {
        chainId: '1',
        compact: compactToAPI(freshCompact),
      };

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: compactPayload,
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toBe('Sponsor signature is required');
    });

    // New test for base 10 numeric string id
    it('should submit valid compact with base 10 numeric string id', async () => {
      const freshCompact = getFreshCompact();
      const compactData = {
        ...compactToAPI(freshCompact),
        id: freshCompact.id.toString(10), // Convert id to base 10 string
      };

      const storedCompact = apiCompactToStoredCompact(compactData);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: compactData,
          sponsorSignature,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('nonce');
    });

    // New test for hex inputs
    it('should submit valid compact with hex inputs', async () => {
      const freshCompact = getFreshCompact();
      const hexCompact = {
        ...compactToAPI(freshCompact),
        id: '0x' + freshCompact.id.toString(16),
        expires: '0x' + freshCompact.expires.toString(16),
        amount: '0x' + BigInt(freshCompact.amount).toString(16),
        nonce: '0x' + freshCompact.nonce.toString(16),
      };

      const storedCompact = apiCompactToStoredCompact(hexCompact);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: hexCompact,
          sponsorSignature,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('nonce');
    });

    // New test for mixed decimal and hex inputs
    it('should submit valid compact with mixed decimal and hex inputs', async () => {
      const freshCompact = getFreshCompact();
      const mixedCompact = {
        ...compactToAPI(freshCompact),
        id: '0x' + freshCompact.id.toString(16),
        expires: freshCompact.expires.toString(),
        amount: '0x' + BigInt(freshCompact.amount).toString(16),
        nonce: freshCompact.nonce.toString(),
      };

      const storedCompact = apiCompactToStoredCompact(mixedCompact);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: mixedCompact,
          sponsorSignature,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('nonce');
    });

    // New test for invalid hex format
    it('should reject invalid hex format', async () => {
      const freshCompact = getFreshCompact();
      const invalidHexCompact = {
        ...compactToAPI(freshCompact),
        id: '0xInvalidHex',
      };

      // Use valid ID for signature
      const validCompactForSig = {
        ...invalidHexCompact,
        id: '0x123',
      };
      const storedCompact = apiCompactToStoredCompact(validCompactForSig);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: invalidHexCompact,
          sponsorSignature,
        },
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toContain('Failed to convert id');
    });

    it('should reject compact with null nonce', async () => {
      const freshCompact = getFreshCompact();
      const compactData = {
        ...compactToAPI(freshCompact),
        nonce: null,
      };

      const storedCompact = apiCompactToStoredCompact({
        ...compactData,
        nonce: '0x1', // Use a valid nonce for signature generation
      });
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      const compactPayload = {
        chainId: '1',
        compact: compactData,
        sponsorSignature,
      };

      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: compactPayload,
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toBe(
        'Nonce is required. Use /suggested-nonce/:chainId to get a valid nonce.'
      );
    });

    it('should store nonce after successful submission', async (): Promise<void> => {
      const freshCompact = getFreshCompact();
      const chainId = '1';
      const compactData = compactToAPI(freshCompact);
      const storedCompact = apiCompactToStoredCompact(compactData);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        chainId
      );

      // Submit compact
      const response = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId,
          compact: compactData,
          sponsorSignature,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);

      // Extract nonce components from hybrid nonce format:
      // - Byte 0 (hex chars 0-1): command
      // - Bytes 1-20 (hex chars 2-41): sponsor
      // - Bytes 21-31 (hex chars 42-63): fragment (11 bytes = 88 bits)
      const nonceHex = BigInt(result.nonce).toString(16).padStart(64, '0');
      const fragmentPart = nonceHex.slice(42); // bytes 21-31 = 11 bytes = 22 hex chars
      const fragmentBigInt = BigInt('0x' + fragmentPart);

      // Split fragment into nonce_high and nonce_low for database lookup
      const nonceLowUnsigned = fragmentBigInt & BigInt(0xffffffff);
      const nonceHighUnsigned = fragmentBigInt >> BigInt(32);

      // Convert to signed for PostgreSQL storage
      const nonceLow =
        nonceLowUnsigned >= BigInt(0x80000000)
          ? Number(nonceLowUnsigned - BigInt(0x100000000))
          : Number(nonceLowUnsigned);
      const nonceHigh =
        nonceHighUnsigned >= BigInt('0x8000000000000000')
          ? Number(nonceHighUnsigned - BigInt('0x10000000000000000'))
          : Number(nonceHighUnsigned);

      // Verify nonce was stored with correct high and low values
      const dbResult = await server.db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM nonces WHERE chain_id = $1 AND sponsor = $2 AND nonce_high = $3 AND nonce_low = $4',
        [
          chainId,
          hexToBytes(freshCompact.sponsor as `0x${string}`),
          nonceHigh,
          nonceLow,
        ]
      );
      expect(dbResult.rows[0].count).toBe(1);
    });
  });

  describe('GET /compacts/:account', () => {
    it('should return compacts for a specific account', async () => {
      // First submit a compact to ensure there's data
      const freshCompact = getFreshCompact();
      const compactData = compactToAPI(freshCompact);
      const storedCompact = apiCompactToStoredCompact(compactData);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: compactData,
          sponsorSignature,
        },
      });

      // Now get compacts for this account
      const response = await server.inject({
        method: 'GET',
        url: `/compacts/${freshCompact.sponsor}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should reject request with invalid account address', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/compacts/0xinvalid',
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result.error).toBe('Invalid account address format');
    });
  });

  describe('GET /compact/:chainId/:claimHash', () => {
    it('should return specific compact', async () => {
      const freshCompact = getFreshCompact();
      const compactData = compactToAPI(freshCompact);
      const storedCompact = apiCompactToStoredCompact(compactData);
      const sponsorSignature = await generateValidCompactSignature(
        storedCompact,
        '1'
      );

      // First submit a compact
      const submitResponse = await server.inject({
        method: 'POST',
        url: '/compact',
        payload: {
          chainId: '1',
          compact: compactData,
          sponsorSignature,
        },
      });

      const submitResult = JSON.parse(submitResponse.payload);
      if (submitResponse.statusCode !== 200 || !submitResult?.hash) {
        console.error('Failed to submit compact:', submitResponse.payload);
        throw new Error('Failed to submit compact');
      }

      const { hash } = submitResult;

      const response = await server.inject({
        method: 'GET',
        url: `/compact/1/${hash}`,
      });

      if (response.statusCode === 500) {
        console.error('Got 500 error:', {
          payload: response.payload,
          hash,
        });
      }

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('chainId', '1');
      expect(result).toHaveProperty('hash', hash);
      expect(result).toHaveProperty('compact');
      expect(result.compact).toHaveProperty('nonce');
    });

    it('should return error for non-existent compact', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/compact/1/0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
