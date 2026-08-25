import { spawn } from "node:child_process";

// The cli -> server edge is a relative import (bun 1.4 cannot resolve a
// `file:` dep's own `file:` deps, so the cli does not declare the server as a
// package dependency). The server stays a separate package with its own
// dependency on core.
import { serverEntryPath } from "../server/lifecycle.ts";
import { ServerClient, isServerDown } from "../server/transport/client.ts";

/**
 * Server lifecycle for the CLI: if no server is listening on HTTP, spawn one
 * detached and wait for it to come up; `stop` asks it to exit over HTTP. The
 * server is the long-lived owner of execution - every CLI command lands on
 * the same TCP port.
 *
 * The server binds 127.0.0.1:<port> on the CONFIGURED port (SHOWRUNNER_PORT,
 * default 44100). There is no discovery file: the CLI talks HTTP on the known port,
 * discovers the server by health-checking it, and stops it via POST
 * /api/shutdown. A dead server simply fails the health check.
 */

/** The server base URL for a data dir: the configured port (SHOWRUNNER_PORT ??
 * 44100). The spawned server resolves the SAME port from the inherited env, so
 * the CLI and the server always agree without any discovery file. */
export function serverBaseUrl(_dataDir: string): string {
  return `http://127.0.0.1:${process.env.SHOWRUNNER_PORT ?? 44100}`;
}

export async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    await new ServerClient({ baseUrl }).health();
    return true;
  } catch {
    return false;
  }
}

export async function ensureServer(dataDir: string): Promise<void> {
  if (await isServerUp(serverBaseUrl(dataDir))) return;

  const child = spawn(process.execPath, [serverEntryPath(), "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // health-check the known port until the spawned server answers
    if (await isServerUp(serverBaseUrl(dataDir))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `server did not come up at ${serverBaseUrl(dataDir)} - start it manually with \`showrunner server\``,
  );
}

export async function stopServer(dataDir: string): Promise<void> {
  const baseUrl = serverBaseUrl(dataDir);
  if (!(await isServerUp(baseUrl))) {
    throw new Error(`no server running at ${baseUrl} - is a server running?`);
  }
  try {
    // POST /api/shutdown: the server flushes the response, then SIGTERMs itself
    // into its graceful signal handler (stops children, closes server + DB).
    await new ServerClient({ baseUrl }).shutdown();
  } catch (err) {
    // the server may drop the connection as it exits before the body is read —
    // that is a successful shutdown, not a failure
    if (!isServerDown(err)) throw err;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isServerUp(baseUrl))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the server may still be finishing its close; nothing more to do
}
