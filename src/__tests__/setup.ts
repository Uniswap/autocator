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

// Lazy-loaded database manager
// Only tests that actually need the database will initialize it
let PGliteModule: typeof import('@electric-sql/pglite') | null = null;
let schemaModule: typeof import('../schema') | null = null;

class DatabaseManager {
  private db: import('@electric-sql/pglite').PGlite | null = null;
  private static instance: DatabaseManager;
  private initializationPromise: Promise<void> | null = null;
  private needsDatabase: boolean = false;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  // Call this to mark that the current test needs a database
  requireDatabase(): void {
    this.needsDatabase = true;
  }

  async initialize(): Promise<void> {
    // Only initialize if the test actually needs a database
    if (!this.needsDatabase) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      if (!this.db) {
        // Lazy load the modules
        if (!PGliteModule) {
          PGliteModule = await import('@electric-sql/pglite');
        }
        if (!schemaModule) {
          schemaModule = await import('../schema');
        }

        this.db = new PGliteModule.PGlite('memory://');
        await this.db.ready;
        await schemaModule.initializeDatabase(this.db);
      }
    })();

    return this.initializationPromise;
  }

  async getDb(): Promise<import('@electric-sql/pglite').PGlite> {
    if (!this.db) {
      this.needsDatabase = true;
      await this.initialize();
    }
    return this.db as import('@electric-sql/pglite').PGlite;
  }

  async cleanup(): Promise<void> {
    // Reset the needsDatabase flag for next test
    const wasNeeded = this.needsDatabase;
    this.needsDatabase = false;
    this.initializationPromise = null;

    // Only cleanup if we actually had a database
    if (this.db && wasNeeded) {
      try {
        if (schemaModule) {
          await schemaModule.dropTables(this.db);
        }
        // Skip closing the database as it causes issues with dynamic imports
        // await this.db.close();
      } catch (error) {
        console.error('Error during database cleanup:', error);
      } finally {
        this.db = null;
      }
    }
  }
}

export const dbManager = DatabaseManager.getInstance();

// Global test setup - only initialize if needed
beforeEach(async () => {
  // Database will only be initialized if a test calls dbManager.requireDatabase()
  // or dbManager.getDb() before this point
  await dbManager.initialize();
});

// Global test cleanup
afterAll(async () => {
  // Wait for any pending operations to complete
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await dbManager.cleanup();
  } catch (error) {
    console.error('Error during global cleanup:', error);
  }
}, 10000);

// Reset database between tests
afterEach(async () => {
  // Wait for any pending operations to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await dbManager.cleanup();
  } catch (error) {
    console.error('Error during test cleanup:', error);
  }
});
