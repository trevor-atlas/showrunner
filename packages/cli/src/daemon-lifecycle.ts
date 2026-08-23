import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// The cli -> daemon edge is a relative import (bun 1.4 cannot resolve a
// `file:` dep's own `file:` deps, so the cli does not declare the daemon as a
// package dependency). The daemon stays a separate package with its own
// dependency on core.
import { daemonEntryPath } from "../../daemon/src/daemon.ts";
import { DaemonClient } from "../../daemon/src/client.ts";

/**
 * Daemon lifecycle for the CLI: if no daemon is listening on the socket, spawn
 * one detached and wait for it to come up; `stop` signals it via the pidfile.
 * The daemon is the long-lived owner of execution (§2.1) - every CLI command
 * lands on the same socket.
 */

export async function isDaemonUp(socketPath: string): Promise<boolean> {
  try {
    await new DaemonClient({ socketPath }).health();
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemon(socketPath: string, dataDir: string): Promise<void> {
  if (await isDaemonUp(socketPath)) return;

  const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isDaemonUp(socketPath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `daemon did not come up at ${socketPath} - start it manually with \`showrunner daemon\``,
  );
}

export async function stopDaemon(socketPath: string, dataDir: string): Promise<void> {
  const pidFile = join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) {
    throw new Error(`no daemon pidfile at ${pidFile} - is a daemon running?`);
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid)) {
    throw new Error(`unreadable daemon pidfile ${pidFile}`);
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the daemon may have already removed the socket; nothing more to do
  try {
    unlinkSync(socketPath);
  } catch {
    // already gone
  }
}
