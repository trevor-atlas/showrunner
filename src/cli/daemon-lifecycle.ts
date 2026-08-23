import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The cli -> daemon edge is a relative import (bun 1.4 cannot resolve a
// `file:` dep's own `file:` deps, so the cli does not declare the daemon as a
// package dependency). The daemon stays a separate package with its own
// dependency on core.
import { daemonEntryPath } from "../daemon/daemon.ts";
import { DaemonClient } from "../daemon/client.ts";

/**
 * Daemon lifecycle for the CLI: if no daemon is listening on HTTP, spawn one
 * detached and wait for it to come up; `stop` signals it via the pidfile.
 * The daemon is the long-lived owner of execution (§2.1) - every CLI command
 * lands on the same TCP port.
 *
 * The daemon binds 127.0.0.1:<port> and writes a two-line pidfile
 * (pid, then port) AFTER a successful bind (src/daemon/daemon.ts). The port
 * knob is SHOWRUNNER_PORT (default 44100). The unix socket is gone — the CLI
 * talks HTTP, health-checking via the pidfile port.
 */

/**
 * The daemon base URL for a data dir: the pidfile's port line (line 2), else
 * the SHOWRUNNER_PORT ?? 44100 fallback (what the spawned daemon resolves when
 * the pidfile isn't written yet — the env is inherited, so they agree).
 */
export function daemonBaseUrl(dataDir: string): string {
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const port = readFileSync(pidFile, "utf8").split("\n")[1]?.trim();
    if (port !== undefined && port !== "" && Number.isInteger(Number(port))) {
      return `http://127.0.0.1:${port}`;
    }
  }
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
    // read the pidfile port as soon as it exists (ephemeral ports), then
    // health-check until the daemon answers
    if (await isDaemonUp(daemonBaseUrl(dataDir))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `daemon did not come up at ${daemonBaseUrl(dataDir)} - start it manually with \`showrunner daemon\``,
  );
}

export async function stopDaemon(dataDir: string): Promise<void> {
  const pidFile = join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) {
    throw new Error(`no daemon pidfile at ${pidFile} - is a daemon running?`);
  }
  // the pidfile holds two lines: pid, then port
  const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]?.trim());
  if (!Number.isInteger(pid)) {
    throw new Error(`unreadable daemon pidfile ${pidFile}`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // a stale pidfile whose pid is already dead (ESRCH — kill(2) found no such
    // process): there is no daemon to signal and nothing will remove the file,
    // so surface a friendly message and clean the stale pidfile up. This only
    // runs on the provably-dead path — the graceful flow below never unlinks
    // (the daemon removes its own pidfile during shutdown; an eager unlink
    // would race it).
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") {
      console.log(`no live daemon (stale pidfile) — removing it`);
      rmSync(pidFile, { force: true });
      return;
    }
    throw err;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // graceful shutdown removes the pidfile (no socket to unlink anymore)
    if (!existsSync(pidFile)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the daemon may have already shut down; nothing more to do
}
