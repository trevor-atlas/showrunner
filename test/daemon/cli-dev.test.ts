import { test, expect } from "bun:test";

import { buildDevSpawn } from "../../src/cli/dev.ts";

/**
 * `showrunner dev` wiring (issue #77, Option B). These tests exercise the pure
 * spawn-config seam (buildDevSpawn) and the CLI usage surface WITHOUT ever
 * launching the live HMR proxy chain.
 */

test("buildDevSpawn runs the hmr.ts chain with NODE_ENV=development", () => {
  const { cmd, env } = buildDevSpawn({ dataDir: undefined, rest: {} }, {});
  expect(env.NODE_ENV).toBe("development");
  expect(cmd[0]).toBe("bun");
  expect(cmd[1]).toEndWith("src/ui/hmr.ts");
});

test("buildDevSpawn threads --data-dir through as SHOWRUNNER_DATA_DIR", () => {
  const { env } = buildDevSpawn({ dataDir: "/tmp/dd", rest: {} }, {});
  expect(env.SHOWRUNNER_DATA_DIR).toBe("/tmp/dd");
});

test("buildDevSpawn threads --port through as PORT (the proxy port)", () => {
  const { env } = buildDevSpawn({ dataDir: undefined, rest: { port: "45000" } }, {});
  expect(env.PORT).toBe("45000");
});

test("buildDevSpawn drops SHOWRUNNER_PORT so it cannot override the child's appPort", () => {
  const { env } = buildDevSpawn({ dataDir: undefined, rest: {} }, { SHOWRUNNER_PORT: "44100" });
  expect(env.SHOWRUNNER_PORT).toBeUndefined();
});

test("buildDevSpawn forwards the surrounding environment", () => {
  const { env } = buildDevSpawn({ dataDir: undefined, rest: {} }, { HOME: "/home/dev", PATH: "/usr/bin" });
  expect(env.HOME).toBe("/home/dev");
  expect(env.PATH).toBe("/usr/bin");
});

test("the CLI documents `dev` in its usage output", async () => {
  const cliEntry = new URL("../../src/cli/index.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bun", cliEntry, "help"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  expect(out).toContain("showrunner dev");
});
