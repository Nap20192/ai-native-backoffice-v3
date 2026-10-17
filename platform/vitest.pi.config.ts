import { defineConfig } from "vitest/config";

/** Node-side coverage gate for the Pi harness compaction policy. */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: [
      "apps/agent/tests/pi-loop.test.ts",
      "apps/agent/tests/pi-compaction.test.ts",
      // Registry: legacy harness names of stored agents resolve to Pi (D41).
      "apps/agent/tests/harness-composition.test.ts",
      // Tool output from the sandbox: both exec formats, cuts that fit the
      // Pi bridge (harness-fixes items 8 and 11).
      "apps/agent/tests/tool-results-size.test.ts",
      "apps/agent/tests/tool-exec-output.test.ts",
      // edit, write and glob: harness-fixes items 9, 10 and 12.
      "apps/agent/tests/tool-file-ops.test.ts",
      "apps/main-node/test/pi-sandbox-harness.e2e.test.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["apps/agent/src/harness/pi-compaction.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/pi",
      thresholds: {
        perFile: true,
        lines: 85,
        statements: 85,
        functions: 80,
        branches: 70,
      },
    },
  },
});
