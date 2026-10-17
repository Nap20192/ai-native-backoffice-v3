// Node tests of apps/agent in test/ (docs/plans/environments.md, AT/).
// The root vitest.config.ts runs the Worker pool. These tests start local
// processes and servers, so they run in Node threads. From platform/apps/agent:
//   test-slot ../../node_modules/.bin/vitest run
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
