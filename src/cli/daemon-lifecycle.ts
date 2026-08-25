import { spawn } from "node:child_process";

// The cli -> daemon edge is a relative import (bun 1.4 cannot resolve a
// `file:` dep's own `file:` deps, so the cli does not declare the daemon as a
// package dependency). The daemon stays a separate package with its own
// dependency on core.
import { daemonEntryPath } from "../server/lifecycle.ts";
import { DaemonClient, isDaemonDown } from "../server/transport/client.ts";

/**
 * Daemon lifecycle for the CLI: if no daemon is listening on HTTP, spawn one
 * detached and wait for it to come up; `stop` asks it to exit over HTTP. The
 * daemon is the long-lived owner of execution - every CLI command lands on
 * the same TCP port.
 *
 * The daemon binds 127.0.0.1:<port> on the CONFIGURED port (SHOWRUNNER_PORT,
 * default 44100). There is no discovery file: the CLI talks HTTP on the known port,
 * discovers the daemon by health-checking it, and stops it via POST
 * /api/shutdown. A dead daemon simply fails the health check.
 */

/** The daemon base URL for a data dir: the configured port (SHOWRUNNER_PORT ??
 * 44100). The spawned daemon resolves the SAME port from the inherited env, so
 * the CLI and the daemon always agree without any discovery file. */
export function daemonBaseUrl(_dataDir: string): string {
  return `http://127.0.0.1:${process.env.SHOWRUNNER_PORT ?? 44100}`;
}

export async function isDaemonUp(baseUrl: string): Promise<boolean> {
  try {
    await new DaemonClient({ baseUrl }).health();
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemon(dataDir: string): Promise<void> {
  if (await isDaemonUp(daemonBaseUrl(dataDir))) return;

  const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // health-check the known port until the spawned daemon answers
    if (await isDaemonUp(daemonBaseUrl(dataDir))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `daemon did not come up at ${daemonBaseUrl(dataDir)} - start it manually with \`showrunner daemon\``,
  );
}

export async function stopDaemon(dataDir: string): Promise<void> {
  const baseUrl = daemonBaseUrl(dataDir);
  if (!(await isDaemonUp(baseUrl))) {
    throw new Error(`no daemon running at ${baseUrl} - is a daemon running?`);
  }
  try {
    // POST /api/shutdown: the daemon flushes the response, then SIGTERMs itself
    // into its graceful signal handler (stops children, closes server + DB).
    await new DaemonClient({ baseUrl }).shutdown();
  } catch (err) {
    // the daemon may drop the connection as it exits before the body is read —
    // that is a successful shutdown, not a failure
    if (!isDaemonDown(err)) throw err;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isDaemonUp(baseUrl))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the daemon may still be finishing its close; nothing more to do
}
