import {
  generateNonce,
  validateNonce,
  storeNonce,
} from '../../validation/nonce';
import {
  parseHybridNonce,
  constructHybridNonce,
} from '../../validation/hybrid-nonce';
import { NonceCommand } from '../../validation/types';
import { PGlite } from '@electric-sql/pglite';
import { hexToBytes } from 'viem/utils';

describe('Nonce Validation', () => {
  let db: PGlite;

  beforeAll(async (): Promise<void> => {
    db = new PGlite();

    // Create test tables using the new normalized schema
    await db.query(`
      CREATE TABLE IF NOT EXISTS compacts (
        id UUID PRIMARY KEY,
        chain_id bigint NOT NULL,
        claim_hash bytea NOT NULL CHECK (length(claim_hash) = 32),
        compact_type INTEGER NOT NULL DEFAULT 0 CHECK (compact_type IN (0, 1, 2)),
        sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
        nonce bytea NOT NULL CHECK (length(nonce) = 32),
        expires BIGINT NOT NULL,
        signature bytea NOT NULL,
        witness_type_string TEXT,
        witness_hash bytea CHECK (witness_hash IS NULL OR length(witness_hash) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chain_id, claim_hash)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS compact_elements (
        id UUID PRIMARY KEY,
        compact_id UUID NOT NULL REFERENCES compacts(id) ON DELETE CASCADE,
        element_index INTEGER NOT NULL DEFAULT 0,
        arbiter bytea NOT NULL CHECK (length(arbiter) = 20),
        chain_id bigint NOT NULL,
        mandate_hash bytea CHECK (mandate_hash IS NULL OR length(mandate_hash) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(compact_id, element_index)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS compact_commitments (
        id UUID PRIMARY KEY,
        element_id UUID NOT NULL REFERENCES compact_elements(id) ON DELETE CASCADE,
        lock_tag bytea NOT NULL CHECK (length(lock_tag) = 12),
        token bytea NOT NULL CHECK (length(token) = 20),
        amount bytea NOT NULL CHECK (length(amount) = 32),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS nonces (
        id UUID PRIMARY KEY,
        chain_id bigint NOT NULL,
        sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
        nonce_high bigint NOT NULL,
        nonce_low integer NOT NULL,
        nonce_command INTEGER,
        consumed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chain_id, sponsor, nonce_high, nonce_low)
      )
    `);
  });

  afterAll(async (): Promise<void> => {
    // Clean up (order matters due to foreign keys)
    await db.query('DROP TABLE IF EXISTS compact_commitments');
    await db.query('DROP TABLE IF EXISTS compact_elements');
    await db.query('DROP TABLE IF EXISTS compacts');
    await db.query('DROP TABLE IF EXISTS nonces');
  });

  describe('generateNonce', () => {
    beforeEach(async () => {
      // Clear nonces table before each test
      await db.query('DELETE FROM nonces');
    });

    it('should generate a valid initial nonce for a sponsor', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const chainId = '1';

      const nonce = await generateNonce(sponsor, chainId, db);

      // Parse the hybrid nonce to verify its structure
      const parsed = parseHybridNonce(nonce);

      // Check command is OFF_CHAIN (default)
      expect(parsed.command).toBe(NonceCommand.OFF_CHAIN);

      // Check sponsor matches
      expect(parsed.sponsor.toLowerCase()).toBe(sponsor.toLowerCase());

      // Fragment should be 1 (starts at 1, not 0)
      expect(parsed.fragment).toBe(BigInt(1));
    });

    it('should increment nonce fragment when previous ones are used', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const chainId = '1';

      // Insert a used nonce with fragment 1 (nonce_low=1, nonce_high=0)
      await db.query(
        'INSERT INTO nonces (id, chain_id, sponsor, nonce_high, nonce_low) VALUES ($1, $2, $3, $4, $5)',
        [
          '123e4567-e89b-12d3-a456-426614174000',
          chainId,
          hexToBytes(sponsor as `0x${string}`),
          0,
          1,
        ]
      );

      const nonce = await generateNonce(sponsor, chainId, db);
      const parsed = parseHybridNonce(nonce);

      // Check sponsor matches
      expect(parsed.sponsor.toLowerCase()).toBe(sponsor.toLowerCase());

      // Fragment should be 2 (next after 1)
      expect(parsed.fragment).toBe(BigInt(2));
    });

    it('should find next available fragment after max used', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const chainId = '1';

      // Insert nonces with fragments 1 and 3
      await db.query(
        'INSERT INTO nonces (id, chain_id, sponsor, nonce_high, nonce_low) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8)',
        [
          '123e4567-e89b-12d3-a456-426614174000',
          chainId,
          hexToBytes(sponsor as `0x${string}`),
          0,
          1,
          '123e4567-e89b-12d3-a456-426614174001',
          0,
          3,
        ]
      );

      const nonce = await generateNonce(sponsor, chainId, db);
      const parsed = parseHybridNonce(nonce);

      // Fragment should be 4 (next after max 3)
      expect(parsed.fragment).toBe(BigInt(4));
    });

    it('should handle mixed case sponsor addresses', async (): Promise<void> => {
      const sponsorUpper = '0x0000000000FFe8B47B3e2130213B802212439497';
      const sponsorLower = sponsorUpper.toLowerCase();
      const chainId = '1';

      const nonceLower = await generateNonce(sponsorLower, chainId, db);
      const nonceUpper = await generateNonce(sponsorUpper, chainId, db);

      expect(nonceLower).toBe(nonceUpper);
    });
  });

  describe('validateNonce', () => {
    const chainId = '1';

    beforeEach(async () => {
      // Clear test data
      await db.query('DELETE FROM nonces');
    });

    it('should validate a fresh nonce', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const nonce = await generateNonce(sponsor, chainId, db);

      const result = await validateNonce(nonce, sponsor, chainId, db);
      expect(result.isValid).toBe(true);
    });

    it('should reject a used nonce', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const nonce = await generateNonce(sponsor, chainId, db);

      // Store the nonce as used using the proper method
      await storeNonce(nonce, chainId, db);

      const result = await validateNonce(nonce, sponsor, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Nonce has already been used');
    });

    it('should reject a nonce with incorrect sponsor prefix', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const wrongSponsor = '0x0000000000000000000000000000000000001234';

      // Create valid hybrid nonce with wrong sponsor
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        wrongSponsor,
        BigInt(1)
      );

      const result = await validateNonce(nonce, sponsor, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Nonce does not match sponsor address');
    });

    it('should allow same nonce in different chains', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const nonce = await generateNonce(sponsor, chainId, db);

      // Store nonce as used in a different chain
      await storeNonce(nonce, '10', db);

      // Should still be valid in chain 1
      const result = await validateNonce(nonce, sponsor, chainId, db);
      expect(result.isValid).toBe(true);
    });

    it('should reject nonce used on same chain', async (): Promise<void> => {
      const sponsor = '0x1234567890123456789012345678901234567890';
      const nonce = await generateNonce(sponsor, chainId, db);

      // Store nonce as used on same chain
      await storeNonce(nonce, chainId, db);

      // Should fail validation
      const result = await validateNonce(nonce, sponsor, chainId, db);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Nonce has already been used');
    });
  });
});
