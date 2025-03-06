import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getAddress } from 'viem/utils';
import {
  submitCompact,
  getCompactsByAddress,
  getCompactByHash,
  type CompactSubmission,
  type StoredCompactMessage,
} from '../compact';
import { generateNonce } from '../validation';

// Type for serialized response
interface SerializedCompactMessage {
  id: string;
  arbiter: string;
  sponsor: string;
  nonce: string;
  expires: string;
  amount: string;
  witnessTypeString: string | null;
  witnessHash: string | null;
}

interface SerializedCompactRecord {
  chainId: string;
  compact: SerializedCompactMessage;
  hash: string;
  signature: string;
  createdAt: string;
}

// Helper function to serialize a stored compact message
function serializeCompactMessage(
  compact: StoredCompactMessage
): SerializedCompactMessage {
  return {
    id: compact.id.toString(),
    arbiter: compact.arbiter,
    sponsor: compact.sponsor,
    nonce: compact.nonce.toString(),
    expires: compact.expires.toString(),
    amount: compact.amount,
    witnessTypeString: compact.witnessTypeString,
    witnessHash: compact.witnessHash,
  };
}

export async function setupCompactRoutes(
  server: FastifyInstance
): Promise<void> {
  // Get suggested nonce for a chain and account
  server.get<{
    Params: { chainId: string; account: string };
  }>(
    '/suggested-nonce/:chainId/:account',
    async (
      request: FastifyRequest<{
        Params: { chainId: string; account: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { chainId, account } = request.params;

        let normalizedAccount: string;
        try {
          normalizedAccount = getAddress(account);
        } catch {
          reply.code(400);
          return { error: 'Invalid account address format' };
        }

        // Generate a nonce for the account
        const nonce = await generateNonce(
          normalizedAccount,
          chainId,
          server.db
        );

        // Return the nonce in hex format with 0x prefix
        return {
          nonce: '0x' + nonce.toString(16).padStart(64, '0'),
        };
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error ? error.message : 'Failed to generate nonce',
        };
      }
    }
  );

  // Submit a new compact with sponsor signature
  server.post<{
    Body: CompactSubmission & { sponsorSignature: string };
  }>(
    '/compact',
    async (
      request: FastifyRequest<{
        Body: CompactSubmission & { sponsorSignature: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { sponsorSignature, ...submission } = request.body;

        if (!sponsorSignature) {
          reply.code(400);
          return { error: 'Sponsor signature is required' };
        }

        // Return the result directly without wrapping it
        return await submitCompact(
          server,
          submission,
          submission.compact.sponsor,
          sponsorSignature
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Invalid sponsor signature')
        ) {
          reply.code(403);
        } else if (
          error instanceof Error &&
          error.message.includes(
            'Onchain registration check not yet implemented'
          )
        ) {
          reply.code(501); // Not Implemented
        } else {
          reply.code(400);
        }
        return {
          error:
            error instanceof Error ? error.message : 'Failed to submit compact',
        };
      }
    }
  );

  // Get compacts for a specific sponsor
  server.get<{
    Querystring: { sponsor: string };
  }>(
    '/compacts',
    async (
      request: FastifyRequest<{
        Querystring: { sponsor: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { sponsor } = request.query;

        if (!sponsor) {
          reply.code(400);
          return { error: 'Sponsor address is required' };
        }

        let normalizedSponsor: string;
        try {
          normalizedSponsor = getAddress(sponsor);
        } catch {
          reply.code(400);
          return { error: 'Invalid sponsor address format' };
        }

        const compacts = await getCompactsByAddress(server, normalizedSponsor);

        // Serialize BigInt values to strings for JSON serialization
        const serializedCompacts = compacts.map((compact) => ({
          chainId: compact.chainId,
          compact: serializeCompactMessage(compact.compact),
          hash: compact.hash,
          signature: compact.signature,
          createdAt: compact.createdAt,
        }));

        return serializedCompacts;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('No compacts found')
        ) {
          reply.code(404);
        } else {
          reply.code(400);
        }
        return {
          error:
            error instanceof Error ? error.message : 'Failed to get compacts',
        };
      }
    }
  );

  // Get specific compact
  server.get<{
    Params: { chainId: string; claimHash: string };
  }>(
    '/compact/:chainId/:claimHash',
    async (
      request: FastifyRequest<{
        Params: { chainId: string; claimHash: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { chainId, claimHash } = request.params;
        const compact = await getCompactByHash(server, chainId, claimHash);

        if (!compact) {
          reply.code(404);
          return { error: 'Compact not found' };
        }

        // Convert BigInt values to strings for JSON serialization
        const serializedCompact: SerializedCompactRecord = {
          chainId,
          compact: serializeCompactMessage(compact.compact),
          hash: compact.hash,
          signature: compact.signature,
          createdAt: compact.createdAt,
        };

        return serializedCompact;
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error ? error.message : 'Failed to get compact',
        };
      }
    }
  );
}
