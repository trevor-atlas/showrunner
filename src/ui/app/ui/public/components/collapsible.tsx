/**
 * Collapsible (issue #36) — a single expand/collapse section.
 *
 * Wraps the remix/ui accordion primitive (verified in-place, div-based, no
 * portal, SSR-safe: `Accordion`/`AccordionItem`/`AccordionTrigger`/
 * `AccordionContent` at node_modules/@remix-run/ui/dist/accordion/index.d.ts).
 * Uses the single + `collapsible` mode with ONE item so the trigger toggles a
 * single panel and emits the accordion's `aria-expanded`/region semantics for
 * free. `defaultOpen` maps to the accordion's `defaultValue`, so the panel
 * SSR-renders in the right initial state; the interactive toggle activates
 * after hydration (this is a clientEntry component).
 *
 * (Native `<details>` is the accepted fallback where accordion semantics don't
 * fit — see event-feed.tsx — but a labelled single section is exactly what the
 * accordion single/collapsible mode models, so we default to the primitive per
 * the ticket and layer token styles over it.)
 *
 * Browser-bundle-safe (public/, remix/ui only), tokens only.
 */
import { css, type Handle, type RemixNode } from "remix/ui";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "remix/ui/accordion";

/** The single item's stable value inside the wrapped accordion. */
const ITEM = "collapsible";

export interface CollapsibleProps {
  title: RemixNode;
  defaultOpen?: boolean;
  children?: RemixNode;
}

export function Collapsible(handle: Handle<CollapsibleProps>) {
  return () => {
    const { title, defaultOpen = false, children } = handle.props;
    return (
      <Accordion
        data-component="collapsible"
        type="single"
        collapsible
        defaultValue={defaultOpen ? ITEM : null}
        mix={rootStyle}
      >
        <AccordionItem value={ITEM} mix={itemStyle}>
          <AccordionTrigger mix={triggerStyle}>{title}</AccordionTrigger>
          <AccordionContent mix={contentStyle}>{children}</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  };
}

const rootStyle = css({
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  color: "var(--card-foreground)",
});

const itemStyle = css({
  border: 0,
});

const triggerStyle = css({
  width: "100%",
  fontSize: "var(--font-size-md)",
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  color: "var(--foreground)",
  padding: "0.5rem 0.7rem",
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const contentStyle = css({
  fontSize: "var(--font-size-md)",
  color: "var(--card-foreground)",
  padding: "0 0.7rem 0.6rem",
});
