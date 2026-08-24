/**
 * Production build = a COMPILE GATE, not an artifact producer.
 *
 * The remix asset server's compile cache is in-memory PER PROCESS (the public
 * AssetServer exposes only fetch/getHref/getPreloads/close —
 * node_modules/@remix-run/assets/dist/lib/asset-server.d.ts — backed by an
 * in-memory ModuleStore, .../lib/module-store.d.ts), so this separate build
 * process CANNOT precompile anything the daemon later loads. What it CAN do is
 * force the entire client entry graph to compile+minify here (NODE_ENV=production
 * makes assets.ts minify) and fail the build on any asset-compiler error, so
 * that error surfaces in CI instead of on a user's first page load. The real
 * first-load speedup is the boot-time warm inside the daemon process
 * (src/daemon/daemon.ts).
 */
import { entryHref, entryPreloads } from "../src/ui/app/assets.ts";

try {
  const [href, preloads] = await Promise.all([entryHref(), entryPreloads()]);
  console.log(`showrunner build: entry compiled → ${href} (${preloads.length} preload(s))`);
  process.exit(0);
} catch (err) {
  console.error("showrunner build: asset compilation failed");
  console.error(err);
  process.exit(1);
}
