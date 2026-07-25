/**
 * Coverage configuration.
 *
 * Runs the unit **and** e2e suites together. Measuring the unit suite alone
 * would understate reality — controllers, guards, and health indicators are
 * exercised end to end — and would push toward writing redundant unit tests
 * purely to move the number. Both suites share `process.env`, so this config is
 * always invoked with `--runInBand`.
 *
 * `coverageProvider: "v8"` rather than the istanbul default: with swc's
 * decorator-metadata emit, istanbul charges the generated `__decorate` helpers
 * to the decorator lines and reports roughly half the branches as uncovered on
 * files whose logic is fully tested. v8 measures what actually executed, so the
 * numbers describe the code instead of the transform.
 *
 * Thresholds sit a few points under the measured values: tight enough to catch
 * a real regression, loose enough not to fail on noise.
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  moduleFileExtensions: ["js", "json", "ts"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest"],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    // Excluded: wiring and declarations, not behavior worth a percentage.
    "!src/**/*.spec.ts",
    "!src/**/*.module.ts",
    "!src/main.ts",
    "!src/**/*.types.ts",
    "!src/**/dto/**",
    "!src/**/*.decorator.ts",
  ],
  coverageProvider: "v8",
  coverageDirectory: "./coverage",
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 82,
      functions: 90,
      lines: 92,
    },
  },
};
