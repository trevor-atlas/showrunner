import type { Handle, RemixNode } from "remix/ui";
import { css } from "remix/ui";

import { entryHref, entryPreloads } from "../assets.ts";
import { TOKEN_CSS } from "../ui/tokens.ts";

export interface DocumentProps {
  children?: RemixNode;
  head?: RemixNode;
  title?: string;
}

/**
 * Resolved entry script href/preloads for this document, populated at render
 * time by {@link warmEntryAssets} — never at module-eval. The SSR tree walk
 * is synchronous, so the shared render middleware awaits `warmEntryAssets`
 * before building the tree; the (sync) render fn below reads the cache.
 */
let entryAssets: { href: string; preloads: string[] } | null = null;

/**
 * Resolve the entry script's public href and preloads. Idempotent: the
 * underlying lazy accessors in assets.ts memoize, so repeated calls reuse the
 * same promise. Awaited by `src/server/middleware/render.tsx` before every
 * page render.
 */
export async function warmEntryAssets(): Promise<{ href: string; preloads: string[] }> {
  const [href, preloads] = await Promise.all([entryHref(), entryPreloads()]);
  entryAssets = { href, preloads };
  return entryAssets;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, head, title = "Showrunner" } = handle.props;
    if (entryAssets === null) {
      throw new Error(
        "Document rendered before warmEntryAssets() resolved the entry assets — " +
          "the render middleware must await warmEntryAssets() first",
      );
    }
    const { href, preloads } = entryAssets;

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="dark" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <style>{TOKEN_CSS}</style>
          <title>{title}</title>
          {head}
          {preloads.map((href) => (
            <link key={href} rel="modulepreload" href={href} />
          ))}
          <script type="module" src={href}></script>
        </head>
        <body mix={bodyStyle}>{children}</body>
      </html>
    );
  };
}

const bodyStyle = css({
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-body)",
  lineHeight: 1.5,
  color: "var(--foreground)",
  background: "var(--background)",
  WebkitFontSmoothing: "antialiased",
});
