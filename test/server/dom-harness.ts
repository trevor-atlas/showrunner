/**
 * The happy-dom bridge for the component-render tests (issue #36).
 *
 * `remix/ui/test`'s `render()` needs a live `document`/`window` — it appends a
 * container to `document.body` and the reconciler branches on the DOM globals
 * (`Text`, `Element`, `Node`, `SVGElement`, …). Bun's test runtime has no DOM,
 * so this module installs a happy-dom `Window` onto the globals for the
 * duration of a component spec file.
 *
 * CRITICAL: bun runs every test file in ONE shared process, so a leaked
 * `document`/`window` makes the server-only suites (e.g. run-detail's
 * `router.fetch` SSR) think they are in a browser and mis-render. So this is a
 * scoped install/uninstall: `ensureDom()` records exactly which globals it
 * added (only the ones the process was missing — bun's native `fetch`/
 * `Request`/`Response`/`URL`/… are never shadowed) and `teardownDom()` removes
 * precisely those again. A DOM spec calls `ensureDom()` at module load and
 * registers `teardownDom` in an `afterAll`, so the next file starts on the bare
 * bun globals.
 */
import { GlobalWindow } from "happy-dom";

/** DOM globals the render harness needs that bun does NOT provide; these are
 * always taken from happy-dom while a DOM spec runs. */
const FORCE = ["window", "document", "navigator"];

let installed = false;
/** the keys ensureDom() actually set, with their prior values, so teardown is
 * an exact inverse. */
let added: Array<{ key: string; had: boolean; prev: unknown }> = [];

/** Install a happy-dom `Window` onto the process globals. Idempotent within a
 * file; pair with teardownDom() in an afterAll so nothing leaks. */
export function ensureDom(): void {
  if (installed) return;
  const target = globalThis as Record<string, unknown>;
  const win = new GlobalWindow() as unknown as Record<string, unknown>;
  added = [];
  for (const key of Object.getOwnPropertyNames(win)) {
    const force = FORCE.includes(key);
    // Only fill gaps — never shadow bun's native runtime globals (fetch,
    // Request, Response, URL, Headers, Blob, File, …) the daemon suites use —
    // except the DOM roots we always want from happy-dom.
    if (!force && typeof target[key] !== "undefined") continue;
    const had = Object.prototype.hasOwnProperty.call(target, key);
    try {
      added.push({ key, had, prev: target[key] });
      target[key] = win[key];
    } catch {
      // some window props are getter-only on the prototype; skip them
      added.pop();
    }
  }
  installed = true;
}

/** Remove exactly the globals ensureDom() added, restoring any prior values,
 * so server-only suites run against the bare bun globals afterward. */
export function teardownDom(): void {
  if (!installed) return;
  const target = globalThis as Record<string, unknown>;
  for (const entry of added) {
    if (entry.had) {
      target[entry.key] = entry.prev;
    } else {
      delete target[entry.key];
    }
  }
  added = [];
  installed = false;
}
