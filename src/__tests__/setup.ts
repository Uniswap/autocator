import { PGlite } from '@electric-sql/pglite';
import { initializeDatabase, dropTables } from '../schema';

// Set up test environment variables before any tests run
process.env.SKIP_SIGNING_VERIFICATION = 'true';
process.env.NODE_ENV = 'test';
process.env.SIGNING_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
process.env.ALLOCATOR_ADDRESS = '0x2345678901234567890123456789012345678901';
process.env.PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.CORS_ORIGIN = '*';
process.env.PORT = '3001';
process.env.DOMAIN = 'autocator.example';
process.env.BASE_URL = 'https://autocator.example';

class DatabaseManager {
  private db: PGlite | null = null;
  private static instance: DatabaseManager;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  async initialize(): Promise<void> {
    if (!this.db) {
      this.db = new PGlite('memory://');
      await this.db.ready;
      await initializeDatabase(this.db);
    }
  }

  async getDb(): Promise<PGlite> {
    if (!this.db) {
      await this.initialize();
    }
    return this.db as PGlite;
  }

  async cleanup(): Promise<void> {
    if (this.db) {
      await dropTables(this.db);
      this.db = null;
    }
  }
}

export const dbManager = DatabaseManager.getInstance();

// Global test setup
beforeEach(async () => {
  await dbManager.initialize();
});

// Global test cleanup
afterAll(async () => {
  // Wait for any pending operations to complete
  await new Promise((resolve) => setTimeout(resolve, 500));
  await dbManager.cleanup();
}, 10000);

// Reset database between tests
afterEach(async () => {
  // Wait for any pending operations to complete
  await new Promise((resolve) => setTimeout(resolve, 500));
  await dbManager.cleanup();
});
