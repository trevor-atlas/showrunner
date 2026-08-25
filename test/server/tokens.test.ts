process.env.SHOWRUNNER_FAKE = "1"; // hermetic: no real pi (matches the other UI tests)
/**
 * Design-token gate (issue #31): TOKEN_CSS is the single source of truth for
 * the UI's visual language — a dark-only token block injected on `:root` (and
 * a `.dark` block carrying identical values today). This pins the token values
 * the ticket froze (do NOT re-derive them) and proves the block is actually
 * emitted into the served HTML head.
 *
 * Hermetic: the SSR assertion drives the home page through the app router with
 * a scratch in-process daemon (the test/ui/run-list.test.ts pattern); nothing
 * is written to the repo or ~/.showrunner.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemon, type DaemonHandle } from "../../src/server/lifecycle.ts";
import { router } from "../../src/server/router.ts";
import { routes } from "../../src/server/routes.ts";
import { TOKEN_CSS } from "../../src/server/ui/tokens.ts";

describe("design tokens (issue #31)", () => {
  it("pins the frozen token values — the block is the spec, not re-derived", () => {
    // core semantic tokens (background/card/border/primary/muted/destructive/chart-1)
    expect(TOKEN_CSS).toContain("--background: oklch(0.145 0 0);");
    expect(TOKEN_CSS).toContain("--card: oklch(0.205 0 0);");
    expect(TOKEN_CSS).toContain("--border: oklch(1 0 0 / 10%);");
    expect(TOKEN_CSS).toContain("--primary: oklch(0.922 0 0);");
    expect(TOKEN_CSS).toContain("--muted: oklch(0.269 0 0);");
    expect(TOKEN_CSS).toContain("--destructive: oklch(0.704 0.191 22.216);");
    expect(TOKEN_CSS).toContain("--chart-1: oklch(0.488 0.243 264.376);");

    // the five font-size tokens (18px base type scale)
    expect(TOKEN_CSS).toContain("--font-size-xs: 12px");
    expect(TOKEN_CSS).toContain("--font-size-sm: 13px");
    expect(TOKEN_CSS).toContain("--font-size-md: 14px");
    expect(TOKEN_CSS).toContain("--font-size-body: 18px");
    expect(TOKEN_CSS).toContain("--font-size-title: 18px");

    // dark-only: color-scheme dark + a .dark block present
    expect(TOKEN_CSS).toContain("color-scheme: dark");
    expect(TOKEN_CSS).toContain(".dark");
  });

  it("centralizes the status accents verbatim (visual parity, no tuning)", () => {
    expect(TOKEN_CSS).toContain("--status-running: #3573f6;");
    expect(TOKEN_CSS).toContain("--status-success: #15803d;");
    expect(TOKEN_CSS).toContain("--status-failed: #b91c1c;");
    expect(TOKEN_CSS).toContain("--status-interrupted: #b45309;");
    expect(TOKEN_CSS).toContain("--status-paused: #92400e;");
    expect(TOKEN_CSS).toContain("--status-muted: #6b7280;");
    expect(TOKEN_CSS).toContain("--status-queued: #9ca3af;");
  });

  it("carries identical --background in :root and .dark (light theme later flips :root only)", () => {
    const occurrences = TOKEN_CSS.split("--background: oklch(0.145 0 0);").length - 1;
    expect(occurrences).toBe(2);
  });

  it("emits the token style block + dark color-scheme into the served HTML head (SSR)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "showrunner-ui-tokens-"));
    const saved = process.env.SHOWRUNNER_DATA_DIR;
    process.env.SHOWRUNNER_DATA_DIR = dir;
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const response = await router.fetch(new Request("http://localhost" + routes.home.href()));
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("<style>");
      expect(html).toContain("color-scheme: dark");
      expect(html).toContain("--background: oklch(0.145 0 0);");
      expect(html).toContain('content="dark"');
    } finally {
      await daemon?.close();
      if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
      else process.env.SHOWRUNNER_DATA_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
