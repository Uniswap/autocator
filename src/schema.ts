import { PGlite } from '@electric-sql/pglite';

export const schemas = {
  compacts: `
    CREATE TABLE IF NOT EXISTS compacts (
      id UUID PRIMARY KEY,
      chain_id bigint NOT NULL,
      claim_hash bytea NOT NULL CHECK (length(claim_hash) = 32),
      compact_type INTEGER NOT NULL DEFAULT 0 CHECK (compact_type IN (0, 1, 2)),
      -- 0 = Compact, 1 = BatchCompact, 2 = MultichainCompact
      
      -- Common fields for all compact types
      sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
      nonce bytea NOT NULL CHECK (length(nonce) = 32),
      expires BIGINT NOT NULL,
      signature bytea NOT NULL,
      
      -- Witness data (optional for all types)
      witness_type_string TEXT,
      witness_hash bytea CHECK (witness_hash IS NULL OR length(witness_hash) = 32),
      
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, claim_hash)
    )
  `,
  compact_elements: `
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
  `,
  compact_commitments: `
    CREATE TABLE IF NOT EXISTS compact_commitments (
      id UUID PRIMARY KEY,
      element_id UUID NOT NULL REFERENCES compact_elements(id) ON DELETE CASCADE,
      
      -- Resource lock details
      lock_tag bytea NOT NULL CHECK (length(lock_tag) = 12),
      token bytea NOT NULL CHECK (length(token) = 20),
      amount bytea NOT NULL CHECK (length(amount) = 32),
      
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `,
  nonces: `
    CREATE TABLE IF NOT EXISTS nonces (
      id UUID PRIMARY KEY,
      chain_id bigint NOT NULL,
      sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
      nonce_high bigint NOT NULL,
      nonce_low integer NOT NULL,
      -- Command type for HybridAllocator nonces (1=ON_CHAIN, 2=OFF_CHAIN, 3=PERMIT2)
      nonce_command INTEGER CHECK (nonce_command IS NULL OR nonce_command IN (1, 2, 3)),
      consumed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, sponsor, nonce_high, nonce_low)
    )
  `,
  permit2_allocations: `
    CREATE TABLE IF NOT EXISTS permit2_allocations (
      id UUID PRIMARY KEY,
      chain_id bigint NOT NULL,
      claim_hash bytea NOT NULL CHECK (length(claim_hash) = 32),
      
      -- The sponsor who signed the Permit2 message
      sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
      
      -- Nonce from the compact (not the Permit2 nonce)
      nonce bytea NOT NULL CHECK (length(nonce) = 32),
      
      -- Expiration of the compact
      expires BIGINT NOT NULL,
      
      -- The mandate hash used as witness hash in the compact
      mandate_hash bytea NOT NULL CHECK (length(mandate_hash) = 32),
      
      -- The witness type string for claim hash derivation
      witness_type_string TEXT NOT NULL,
      
      -- The full Permit2 message as JSON (for retrieval/debugging)
      permit2_message JSONB NOT NULL,
      
      -- The original Permit2 signature from the sponsor
      permit2_signature bytea NOT NULL,
      
      -- Deposit details - the lock tag for all deposits
      deposit_lock_tag bytea NOT NULL CHECK (length(deposit_lock_tag) = 12),
      
      -- The HybridAllocationContext signature from the allocator
      -- (null if no additional allocation needed - deposit covers all commitments)
      allocation_signature bytea,
      
      -- The additional commitments that needed allocation (delta amounts)
      -- JSON array of {lockTag, token, amount}
      additional_commitments JSONB,
      
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, claim_hash)
    )
  `,
};

export const indexes = {
  compacts: [
    'CREATE INDEX IF NOT EXISTS idx_compacts_sponsor ON compacts(sponsor)',
    'CREATE INDEX IF NOT EXISTS idx_compacts_chain_claim ON compacts(chain_id, claim_hash)',
    'CREATE INDEX IF NOT EXISTS idx_compacts_type ON compacts(compact_type)',
    'CREATE INDEX IF NOT EXISTS idx_compacts_created ON compacts(created_at DESC)',
  ],
  compact_elements: [
    'CREATE INDEX IF NOT EXISTS idx_compact_elements_compact ON compact_elements(compact_id)',
    'CREATE INDEX IF NOT EXISTS idx_compact_elements_chain ON compact_elements(chain_id)',
  ],
  compact_commitments: [
    'CREATE INDEX IF NOT EXISTS idx_compact_commitments_element ON compact_commitments(element_id)',
  ],
  nonces: [
    'CREATE INDEX IF NOT EXISTS idx_nonces_chain_sponsor ON nonces(chain_id, sponsor)',
    'CREATE INDEX IF NOT EXISTS idx_nonces_consumed ON nonces(consumed_at DESC)',
  ],
  permit2_allocations: [
    'CREATE INDEX IF NOT EXISTS idx_permit2_allocations_sponsor ON permit2_allocations(sponsor)',
    'CREATE INDEX IF NOT EXISTS idx_permit2_allocations_chain_claim ON permit2_allocations(chain_id, claim_hash)',
    'CREATE INDEX IF NOT EXISTS idx_permit2_allocations_created ON permit2_allocations(created_at DESC)',
  ],
};

export async function initializeDatabase(db: PGlite): Promise<void> {
  await db.query('BEGIN');
  try {
    // Check if migration is needed - detect old schema without compact_type column
    const checkCompactType = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'compacts' AND column_name = 'compact_type'`
    );

    const compactsTableExists = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'compacts'
      ) as exists`
    );

    // If compacts table exists but doesn't have compact_type, we need to migrate
    if (
      compactsTableExists.rows[0]?.exists &&
      checkCompactType.rows.length === 0
    ) {
      // Drop old tables and recreate with new schema
      await db.query('DROP TABLE IF EXISTS compact_commitments CASCADE');
      await db.query('DROP TABLE IF EXISTS compact_elements CASCADE');
      await db.query('DROP TABLE IF EXISTS compacts CASCADE');
      await db.query('DROP TABLE IF EXISTS nonces CASCADE');
    }

    // Create tables in order (compacts first, then elements, then commitments due to FK constraints)
    await db.query(schemas.compacts);
    await db.query(schemas.compact_elements);
    await db.query(schemas.compact_commitments);
    await db.query(schemas.nonces);
    await db.query(schemas.permit2_allocations);

    // Create indexes
    await Promise.all(
      Object.values(indexes)
        .flat()
        .map((index) => db.query(index))
    );

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function dropTables(db: PGlite): Promise<void> {
  await db.query('BEGIN');
  try {
    // Drop in reverse order due to FK constraints
    await db.query('DROP TABLE IF EXISTS permit2_allocations CASCADE');
    await db.query('DROP TABLE IF EXISTS compact_commitments CASCADE');
    await db.query('DROP TABLE IF EXISTS compact_elements CASCADE');
    await db.query('DROP TABLE IF EXISTS compacts CASCADE');
    await db.query('DROP TABLE IF EXISTS nonces CASCADE');
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
