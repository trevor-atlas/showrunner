import { fileURLToPath } from "node:url";

/**
 * `showrunner dev` — run the UI dev loop (the remix HMR proxy chain in
 * src/server/hmr.ts) with NODE_ENV=development, so contributors get hot reload
 * from the CLI instead of hunting through package.json scripts.
 */

export interface DevFlags {
  dataDir: string | undefined;
  rest: Record<string, string | undefined>;
}

export interface DevSpawn {
  cmd: string[];
  env: Record<string, string | undefined>;
}

// Resolved relative to this module so it works regardless of cwd.
const HMR_ENTRY = fileURLToPath(new URL("../server/hmr.ts", import.meta.url));

/**
 * Pure spawn-config builder (the test seam): computes the exact argv + env for
 * the HMR child without launching it.
 */
export function buildDevSpawn(flags: DevFlags, env: Record<string, string | undefined>): DevSpawn {
  const childEnv: Record<string, string | undefined> = { ...env, NODE_ENV: "development" };
  // hmr.ts sets the child daemon's PORT=appPort, but startDaemon resolves
  // SHOWRUNNER_PORT before PORT — a leaked SHOWRUNNER_PORT would make the inner
  // daemon bind that port and collide with the proxy. Drop it so appPort wins.
  delete childEnv.SHOWRUNNER_PORT;
  if (flags.dataDir !== undefined) childEnv.SHOWRUNNER_DATA_DIR = flags.dataDir;
  if (flags.rest.port !== undefined) childEnv.PORT = flags.rest.port;
  return { cmd: ["bun", HMR_ENTRY], env: childEnv };
}
