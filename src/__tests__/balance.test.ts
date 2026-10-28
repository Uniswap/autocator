import { PGlite } from '@electric-sql/pglite';
import { getAllocatedBalance } from '../balance.js';
import { chainConfig } from '../chain-config.js';
import { hexToBytes } from 'viem/utils';

describe('Balance Functions', () => {
  let db: PGlite;
  let originalNow: () => number;
  let originalFinalizationThresholds: Record<string, number>;
  const mockTimestampMs = 1700000000000; // Fixed timestamp for testing
  const mockTimestampSec = Math.floor(mockTimestampMs / 1000);
  const chainId = '10';
  const mockFinalizationThreshold = 5; // Fixed finalization threshold for testing

  beforeAll(async () => {
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
  });

  // Helper to extract lock_tag and token from lockId (32-byte value)
  function extractLockTagAndToken(lockIdBytes: Uint8Array): {
    lockTag: Uint8Array;
    token: Uint8Array;
  } {
    // lockId is 32 bytes: upper 12 bytes = lock_tag, lower 20 bytes = token
    return {
      lockTag: lockIdBytes.slice(0, 12),
      token: lockIdBytes.slice(12),
    };
  }

  beforeEach(async () => {
    // Store original values
    originalNow = Date.now;
    originalFinalizationThresholds = { ...chainConfig.finalizationThresholds };

    // Mock functions and values
    Date.now = (): number => mockTimestampMs;
    chainConfig.finalizationThresholds = {
      ...chainConfig.finalizationThresholds,
      [chainId]: mockFinalizationThreshold,
    };

    // Clear test data (order matters due to foreign keys)
    await db.query('DELETE FROM compact_commitments');
    await db.query('DELETE FROM compact_elements');
    await db.query('DELETE FROM compacts');

    // Insert test compacts using normalized schema
    const testData = [
      // Active compact (not expired)
      {
        compactId: '123e4567-e89b-12d3-a456-426614174001',
        elementId: '123e4567-e89b-12d3-a456-426614175001',
        commitmentId: '123e4567-e89b-12d3-a456-426614176001',
        chain_id: '10',
        claim_hash: hexToBytes(
          '0x1000000000000000000000000000000000000000000000000000000000000001'
        ),
        arbiter: hexToBytes('0x1230000000000000000000000000000000000123'),
        sponsor: hexToBytes('0x4560000000000000000000000000000000000456'),
        nonce: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ),
        expires: (mockTimestampSec + 3600).toString(), // Expires in 1 hour
        lock_id: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000123000'
        ),
        amount: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000000064'
        ), // 100 in hex
        signature: hexToBytes(
          '0x1234000000000000000000000000000000000000000000000000000000001234'
        ),
      },
      // Not fully expired compact (within finalization threshold)
      {
        compactId: '123e4567-e89b-12d3-a456-426614174002',
        elementId: '123e4567-e89b-12d3-a456-426614175002',
        commitmentId: '123e4567-e89b-12d3-a456-426614176002',
        chain_id: '10',
        claim_hash: hexToBytes(
          '0x2000000000000000000000000000000000000000000000000000000000000002'
        ),
        arbiter: hexToBytes('0x1230000000000000000000000000000000000123'),
        sponsor: hexToBytes('0x4560000000000000000000000000000000000456'),
        nonce: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000000002'
        ),
        expires: (mockTimestampSec - 2).toString(), // Expired 2 seconds ago (within 5s threshold)
        lock_id: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000123000'
        ),
        amount: hexToBytes(
          '0x00000000000000000000000000000000000000000000000000000000000000c8'
        ), // 200 in hex
        signature: hexToBytes(
          '0x5678000000000000000000000000000000000000000000000000000000005678'
        ),
      },
      // Truly expired compact
      {
        compactId: '123e4567-e89b-12d3-a456-426614174003',
        elementId: '123e4567-e89b-12d3-a456-426614175003',
        commitmentId: '123e4567-e89b-12d3-a456-426614176003',
        chain_id: '10',
        claim_hash: hexToBytes(
          '0x3000000000000000000000000000000000000000000000000000000000000003'
        ),
        arbiter: hexToBytes('0x1230000000000000000000000000000000000123'),
        sponsor: hexToBytes('0x4560000000000000000000000000000000000456'),
        nonce: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000000003'
        ),
        expires: (mockTimestampSec - 10).toString(), // Expired 10 seconds ago (beyond 5s threshold)
        lock_id: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000123000'
        ),
        amount: hexToBytes(
          '0x000000000000000000000000000000000000000000000000000000000000012c'
        ), // 300 in hex
        signature: hexToBytes(
          '0x9abc000000000000000000000000000000000000000000000000000000009abc'
        ),
      },
    ];

    for (const compact of testData) {
      const { lockTag, token } = extractLockTagAndToken(compact.lock_id);

      // Insert into compacts table
      await db.query(
        `INSERT INTO compacts (id, chain_id, claim_hash, compact_type, sponsor, nonce, expires, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          compact.compactId,
          compact.chain_id,
          compact.claim_hash,
          0, // Legacy compact type
          compact.sponsor,
          compact.nonce,
          compact.expires,
          compact.signature,
        ]
      );

      // Insert into compact_elements table
      await db.query(
        `INSERT INTO compact_elements (id, compact_id, element_index, arbiter, chain_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          compact.elementId,
          compact.compactId,
          0,
          compact.arbiter,
          compact.chain_id,
        ]
      );

      // Insert into compact_commitments table
      await db.query(
        `INSERT INTO compact_commitments (id, element_id, lock_tag, token, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          compact.commitmentId,
          compact.elementId,
          lockTag,
          token,
          compact.amount,
        ]
      );
    }
  });

  afterEach(() => {
    // Restore original values
    Date.now = originalNow;
    chainConfig.finalizationThresholds = originalFinalizationThresholds;
  });

  afterAll(async () => {
    // Clean up (order matters due to foreign keys)
    await db.query('DROP TABLE IF EXISTS compact_commitments');
    await db.query('DROP TABLE IF EXISTS compact_elements');
    await db.query('DROP TABLE IF EXISTS compacts');
  });

  it('should calculate allocated balance correctly with no processed claims', async () => {
    const balance = await getAllocatedBalance(
      db,
      '0x4560000000000000000000000000000000000456',
      '10',
      BigInt('0x123000'),
      []
    );

    // Should include both active and not-fully-expired compacts (100 + 200)
    expect(balance.toString()).toBe(BigInt(300).toString());
  });

  it('should exclude processed claims from allocated balance', async () => {
    const balance = await getAllocatedBalance(
      db,
      '0x4560000000000000000000000000000000000456',
      '10',
      BigInt('0x123000'),
      ['0x1000000000000000000000000000000000000000000000000000000000000001'] // Processed claim for the active compact
    );

    // Should only include the not-fully-expired compact (200)
    expect(balance.toString()).toBe(BigInt(200).toString());
  });

  it('should return zero for all processed or expired claims', async () => {
    const balance = await getAllocatedBalance(
      db,
      '0x4560000000000000000000000000000000000456',
      '10',
      BigInt('0x123000'),
      [
        '0x1000000000000000000000000000000000000000000000000000000000000001',
        '0x2000000000000000000000000000000000000000000000000000000000000002',
      ] // All non-expired compacts processed
    );

    expect(balance.toString()).toBe(BigInt(0).toString());
  });

  it('should handle non-existent sponsor', async () => {
    const balance = await getAllocatedBalance(
      db,
      '0x7890000000000000000000000000000000000789', // Non-existent sponsor
      '10',
      BigInt('0x123000'),
      []
    );

    expect(balance.toString()).toBe(BigInt(0).toString());
  });

  it('should handle non-existent lock ID', async () => {
    const balance = await getAllocatedBalance(
      db,
      '0x4560000000000000000000000000000000000456',
      '10',
      BigInt('0x456000'), // Non-existent lock
      []
    );

    expect(balance.toString()).toBe(BigInt(0).toString());
  });
});
