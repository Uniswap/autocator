import { FastifyInstance } from 'fastify';
import { setupHealthRoutes } from './health';
import { setupBalanceRoutes } from './balance';
import { setupCompactRoutes } from './compact';
import { setupAllocationRoutes } from './allocation';

// Declare db property on FastifyInstance
declare module 'fastify' {
  interface FastifyInstance {
    db: import('@electric-sql/pglite').PGlite;
  }
}

export async function setupRoutes(server: FastifyInstance): Promise<void> {
  // Setup all route modules
  await setupHealthRoutes(server);
  await setupBalanceRoutes(server);
  await setupCompactRoutes(server);
  await setupAllocationRoutes(server);
}
