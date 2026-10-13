import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/project/**', 'tests/worker/**'], testTimeout: 15000, maxWorkers: 3 } });
