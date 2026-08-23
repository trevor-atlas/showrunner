import type { Handle, RemixNode } from "remix/ui";
import { css } from "remix/ui";

import { entryHref, entryPreloads } from "../assets.ts";

export interface DocumentProps {
  children?: RemixNode;
  head?: RemixNode;
  title?: string;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, head, title = "Showrunner" } = handle.props;

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <title>{title}</title>
          {head}
          {entryPreloads.map((href) => (
            <link key={href} rel="modulepreload" href={href} />
          ))}
          <script type="module" src={entryHref}></script>
        </head>
        <body mix={bodyStyle}>{children}</body>
      </html>
    );
  };
}

const bodyStyle = css({
  margin: 0,
  fontFamily:
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSize: "14px",
  lineHeight: 1.5,
  color: "#111827",
  background: "#ffffff",
  WebkitFontSmoothing: "antialiased",
});
