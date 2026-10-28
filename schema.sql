-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main compacts table storing common fields for all compact types
CREATE TABLE compacts (
    id UUID PRIMARY KEY,
    chain_id bigint NOT NULL,  -- The chain where the compact was registered/signed
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
);

-- Elements table - all compacts have at least one element
-- Compact/BatchCompact: single element with chain_id matching compact's chain_id
-- MultichainCompact: multiple elements, potentially on different chains
CREATE TABLE compact_elements (
    id UUID PRIMARY KEY,
    compact_id UUID NOT NULL REFERENCES compacts(id) ON DELETE CASCADE,
    element_index INTEGER NOT NULL DEFAULT 0,
    arbiter bytea NOT NULL CHECK (length(arbiter) = 20),
    chain_id bigint NOT NULL,  -- The chain where this element's commitments are
    mandate_hash bytea CHECK (mandate_hash IS NULL OR length(mandate_hash) = 32),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(compact_id, element_index)
);

-- Commitments table - resource locks
-- Each element has one or more commitments
CREATE TABLE compact_commitments (
    id UUID PRIMARY KEY,
    element_id UUID NOT NULL REFERENCES compact_elements(id) ON DELETE CASCADE,
    
    -- Resource lock details
    lock_tag bytea NOT NULL CHECK (length(lock_tag) = 12),
    token bytea NOT NULL CHECK (length(token) = 20),
    amount bytea NOT NULL CHECK (length(amount) = 32),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Nonces table for tracking consumed nonces
CREATE TABLE nonces (
    id UUID PRIMARY KEY,
    chain_id bigint NOT NULL,
    sponsor bytea NOT NULL CHECK (length(sponsor) = 20),
    nonce_high bigint NOT NULL,
    nonce_low integer NOT NULL,
    -- Command type for HybridAllocator nonces (1=ON_CHAIN, 2=OFF_CHAIN, 3=PERMIT2)
    nonce_command INTEGER CHECK (nonce_command IS NULL OR nonce_command IN (1, 2, 3)),
    consumed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain_id, sponsor, nonce_high, nonce_low)
);

-- Create indexes for common query patterns
CREATE INDEX idx_compacts_sponsor ON compacts(sponsor);
CREATE INDEX idx_compacts_chain_claim ON compacts(chain_id, claim_hash);
CREATE INDEX idx_compacts_type ON compacts(compact_type);
CREATE INDEX idx_compacts_created ON compacts(created_at DESC);

CREATE INDEX idx_compact_elements_compact ON compact_elements(compact_id);
CREATE INDEX idx_compact_elements_chain ON compact_elements(chain_id);

CREATE INDEX idx_compact_commitments_element ON compact_commitments(element_id);

CREATE INDEX idx_nonces_chain_sponsor ON nonces(chain_id, sponsor);
CREATE INDEX idx_nonces_consumed ON nonces(consumed_at DESC);

-- Permit2 allocations table for storing hybrid allocations with Permit2 deposits
-- These allocations sign for the delta (excess) amount when deposit doesn't cover full commitment
CREATE TABLE permit2_allocations (
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
);

-- Create indexes for permit2_allocations
CREATE INDEX idx_permit2_allocations_sponsor ON permit2_allocations(sponsor);
CREATE INDEX idx_permit2_allocations_chain_claim ON permit2_allocations(chain_id, claim_hash);
CREATE INDEX idx_permit2_allocations_created ON permit2_allocations(created_at DESC);
