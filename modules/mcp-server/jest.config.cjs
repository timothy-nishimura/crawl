/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],

  // Strip the .js extension that ESM source files use so ts-jest resolves .ts
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      // Suppress @crawl/engine resolution errors — they're a workspace build
      // concern, not a test concern. The files under test (SerpFeatureExtractor,
      // paaExpandJs) have no such dependency.
      diagnostics: { ignoreCodes: [151002] },
    }],
  },

  testMatch: ['**/src/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/__tests__/**'],
};
