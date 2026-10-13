import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
// Match the Node suite's bounded concurrency and per-test budget. These tests
// include multi-step workerd/SQLite transactions, not just in-process assertions.
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'}})],test:{include:['tests/worker/**/*.test.ts','tests/project/**/*.test.ts'],maxWorkers:3,testTimeout:15000}});
