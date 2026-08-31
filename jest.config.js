/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript" },
          target: "es2022",
        },
      },
    ],
  },
  // `test/contract/` runs the real provider binaries and makes real calls;
  // it is opt-in via `npm run test:contract` and never part of offline CI.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "<rootDir>/.history/",
    "<rootDir>/test/fixtures/",
    "<rootDir>/test/contract/",
  ],
  setupFiles: ["<rootDir>/test/setup/force-color-off.ts"],
  clearMocks: true,
  // The pure layers carry the bulk of the logic and are cheap to cover
  // (testing.md). A drop here means logic drifted out of them into I/O code.
  collectCoverageFrom: [
    "src/manifest/**/*.ts",
    "src/graph/**/*.ts",
    "src/context/**/*.ts",
  ],
  // Statements/lines/functions at 90 per testing.md. Branches sit lower
  // because `Map.get()` under `noUncheckedIndexedAccess` forces a `?? []`
  // fallback on every lookup, and those arms describe states that earlier
  // validation stages have already ruled out — unreachable by construction,
  // so chasing them would mean writing tests for impossible inputs.
  coverageThreshold: {
    "./src/manifest/": { statements: 90, branches: 75, functions: 90, lines: 90 },
    "./src/graph/": { statements: 90, branches: 55, functions: 90, lines: 90 },
    "./src/context/": { statements: 90, branches: 90, functions: 90, lines: 90 },
  },
};
