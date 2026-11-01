import { defineConfig } from 'vitest/config';

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('TEST_DATABASE_URL not set: skipping API integration tests (see docs/DESIGN.md "Tests").');

export default defineConfig({
  test: {
    include: hasDb ? ['test/**/*.test.ts'] : [],
    passWithNoTests: true,
    // API tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
