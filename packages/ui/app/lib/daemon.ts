/**
 * The dashboard's server-side daemon access (spec §16.10 `app/lib/daemon.ts`).
 *
 * A thin typed wrapper over the §13 typed client (`packages/daemon`). The
 * browser NEVER imports this module and NEVER talks to the daemon: actions
 * fetch the daemon here, server-side, and the browser only receives rendered
 * HTML (§16.4/§16.5 — no CORS, no daemon credentials in the browser).
 *
 * Import shape: the daemon is imported relatively (not as a `file:` package
 * dep) because bun 1.4 cannot resolve a `file:` dep's own `file:` deps — the
 * CLI uses the same pattern (packages/cli/src/daemon-lifecycle.ts). The
 * client handles unix-socket (default) and SHOWRUNNER_DAEMON_URL http
 * transports itself.
 */

import { DaemonClient, isSocketDown, resolveTransport } from "../../../daemon/src/client.ts";
import type { DaemonTransport, RunListItem } from "../../../daemon/src/client.ts";

/** What the daemon-down banner reports as "expected at <…>". */
export function daemonAddress(): string {
  return describeTransport(resolveTransport());
}

/** The run list rows, or a DaemonUnreachable error when the daemon is down. */
export async function listRuns(): Promise<{ runs: RunListItem[] }> {
  const client = new DaemonClient();
  try {
    return await client.listRuns();
  } catch (err) {
    if (isSocketDown(err)) {
      throw new DaemonUnreachable(resolveTransport(), err);
    }
    throw err;
  }
}

/**
 * The daemon is unreachable (socket/connection refused) — distinct from an
 * API error so pages can render the shell with the DaemonDownBanner instead
 * of 500ing (§16.10).
 */
export class DaemonUnreachable extends Error {
  readonly transport: DaemonTransport;

  constructor(transport: DaemonTransport, cause: unknown) {
    super(`showrunner daemon is not running (expected at ${describeTransport(transport)})`, { cause });
    this.name = "DaemonUnreachable";
    this.transport = transport;
  }
}

function describeTransport(t: DaemonTransport): string {
  return t.kind === "unix" ? t.socketPath : t.baseUrl;
}
