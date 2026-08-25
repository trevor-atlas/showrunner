import { startDaemon, installSignalHandlers } from "./lifecycle.ts";

/**
 * The standalone dev server entry (src/server/main.ts). Runs under bun — `bun main.ts`
 * (or `bun --watch main.ts` for dev).
 *
 * Since the merged web server, the daemon owns the listener: booting this
 * entry starts the daemon in-process (default data dir) on the single TCP
 * port — `/api/*` + the dashboard on the same listener (src/daemon/web.ts).
 * The port honors `PORT` (the remix HMR chain sets it when it spawns this
 * entry) via startDaemon's resolution: `opts.port ?? SHOWRUNNER_PORT ??
 * PORT ?? 44100`.
 *
 * Documented trade-off (accepted): `bun --watch server.ts` restarts the
 * in-process daemon → in-flight runs become `interrupted` (recoverable via
 * resume); `bun hmr` avoids restarts for UI work.
 */

const handle = await startDaemon();
installSignalHandlers(handle);

if (process.env.REMIX_NODE_HMR) {
  import("remix/node-hmr/runtime").then((nodeHmr) => nodeHmr.emitServerReady());
}

console.log(`Server listening on http://localhost:${handle.port}`);
