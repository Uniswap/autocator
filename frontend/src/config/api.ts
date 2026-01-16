// Default to production URLs
const DEFAULT_GRAPHQL_URL = 'https://unified-compact-indexer.marble.live/';

interface Config {
  graphqlUrl: string;
}

export const config: Config = {
  graphqlUrl: import.meta.env.VITE_GRAPHQL_INDEXER_URL || DEFAULT_GRAPHQL_URL,
};
