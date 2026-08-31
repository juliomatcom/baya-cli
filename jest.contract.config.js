import base from './jest.config.js';

/**
 * The contract tier (providers.md §Drift policy #2, plan M3.7).
 *
 * Runs the **real** provider CLIs against real endpoints and asserts the
 * adapter's `buildRun` / `parseEvents` / `extractResult` still hold. It costs
 * requests and needs auth, so it is never in offline CI — run it before a
 * release with `npm run test:contract`.
 *
 * A provider whose binary does not resolve (or whose environment is known
 * broken) is skipped, not failed: the point is to catch upstream drift on the
 * CLIs you actually have.
 */
/** @type {import('jest').Config} */
export default {
  ...base,
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/test/fixtures/'],
  testMatch: ['<rootDir>/test/contract/**/*.test.ts'],
  // Real model calls: minutes, not milliseconds.
  testTimeout: 180_000,
  collectCoverageFrom: [],
  coverageThreshold: undefined,
};
