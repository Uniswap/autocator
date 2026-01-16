// Default to production URLs
const DEFAULT_GRAPHQL_URL = 'https://the-compact-indexer-2.ponder-dev.com/';
const DEFAULT_HYBRID_ALLOCATOR_INDEXER_URL =
  'https://hybrid-allocator-indexer.ponder-dev.com/';

interface Config {
  graphqlUrl: string;
  hybridAllocatorIndexerUrl: string;
}

export const config: Config = {
  graphqlUrl: import.meta.env.VITE_GRAPHQL_INDEXER_URL || DEFAULT_GRAPHQL_URL,
  hybridAllocatorIndexerUrl:
    import.meta.env.VITE_HYBRID_ALLOCATOR_INDEXER_URL ||
    DEFAULT_HYBRID_ALLOCATOR_INDEXER_URL,
};
