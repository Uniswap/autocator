import { PGlite } from '@electric-sql/pglite';
import { getFinalizationThreshold } from './chain-config.js';
import { hexToBytes } from 'viem/utils';

/**
 * Calculate the total allocated balance for a given sponsor, chain, and resource lock
 * that hasn't been processed yet. This accounts for:
 * 1. Compacts that match the sponsor, chain ID, and lock ID (lock_tag + token)
 * 2. Compacts that haven't been finalized yet (currentTime < expires + finalizationThreshold)
 * 3. Compacts that aren't in the processed claims list
 *
 * With the normalized schema:
 * - compacts: contains sponsor, chain_id, expires, claim_hash
 * - compact_elements: links compacts to commitments via arbiter/chain
 * - compact_commitments: contains lock_tag, token, amount
 *
 * Lock ID = (lock_tag << 160) | token
 */
export async function getAllocatedBalance(
  db: PGlite,
  sponsor: string,
  chainId: string,
  lockId: bigint,
  processedClaimHashes: string[]
): Promise<bigint> {
  try {
    const currentTimeSeconds = BigInt(Math.floor(Date.now() / 1000));
    const finalizationThreshold = BigInt(getFinalizationThreshold(chainId));

    // Convert inputs to bytea format
    const sponsorBytes = hexToBytes(
      sponsor.startsWith('0x')
        ? (sponsor as `0x${string}`)
        : (`0x${sponsor}` as `0x${string}`)
    );

    // Extract lock_tag and token from lockId
    // Lock ID = (lock_tag << 160) | token
    const tokenMask = (BigInt(1) << BigInt(160)) - BigInt(1);
    const token = lockId & tokenMask;
    const lockTag = lockId >> BigInt(160);

    // Convert to bytes
    const lockTagHex = '0x' + lockTag.toString(16).padStart(24, '0'); // 12 bytes = 24 hex chars
    const lockTagBytes = hexToBytes(lockTagHex as `0x${string}`);

    const tokenHex = '0x' + token.toString(16).padStart(40, '0'); // 20 bytes = 40 hex chars
    const tokenBytes = hexToBytes(tokenHex as `0x${string}`);

    const processedClaimBytea = processedClaimHashes.map((hash) =>
      hexToBytes(
        hash.startsWith('0x')
          ? (hash as `0x${string}`)
          : (`0x${hash}` as `0x${string}`)
      )
    );

    // Handle empty processed claims list case
    if (processedClaimHashes.length === 0) {
      const query = `
        SELECT cc.amount 
        FROM compacts c
        JOIN compact_elements ce ON ce.compact_id = c.id
        JOIN compact_commitments cc ON cc.element_id = ce.id
        WHERE c.sponsor = $1 
        AND c.chain_id = $2 
        AND cc.lock_tag = $3
        AND cc.token = $4
        AND $5 < CAST(c.expires AS BIGINT) + $6
      `;

      const params = [
        sponsorBytes,
        chainId,
        lockTagBytes,
        tokenBytes,
        currentTimeSeconds.toString(),
        finalizationThreshold.toString(),
      ];

      const result = await db.query<{ amount: Buffer }>(query, params);

      return result.rows.reduce((sum, row) => {
        // Convert bytea amount to decimal string
        const amountBigInt = BigInt(
          '0x' + Buffer.from(row.amount).toString('hex')
        );
        return sum + amountBigInt;
      }, BigInt(0));
    }

    // Query with processed claims filter
    const query = `
      SELECT cc.amount 
      FROM compacts c
      JOIN compact_elements ce ON ce.compact_id = c.id
      JOIN compact_commitments cc ON cc.element_id = ce.id
      WHERE c.sponsor = $1 
      AND c.chain_id = $2 
      AND cc.lock_tag = $3
      AND cc.token = $4
      AND $5 < CAST(c.expires AS BIGINT) + $6
      AND c.claim_hash NOT IN (${processedClaimBytea.map((_, i) => `$${i + 7}`).join(',')})
    `;

    const params = [
      sponsorBytes,
      chainId,
      lockTagBytes,
      tokenBytes,
      currentTimeSeconds.toString(),
      finalizationThreshold.toString(),
      ...processedClaimBytea,
    ];

    const result = await db.query<{ amount: Buffer }>(query, params);

    return result.rows.reduce((sum, row) => {
      // Convert bytea amount to decimal string
      const amountBigInt = BigInt(
        '0x' + Buffer.from(row.amount).toString('hex')
      );
      return sum + amountBigInt;
    }, BigInt(0));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error in getAllocatedBalance: ${error.message}`);
    }
    throw error;
  }
}
