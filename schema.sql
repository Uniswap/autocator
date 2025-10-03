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
