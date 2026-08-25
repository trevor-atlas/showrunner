/**
 * The single source of truth for the UI's visual language (issue #31).
 *
 * `css()` mixins generate scoped class rules and cannot emit global custom
 * properties, so the tokens live here as a raw CSS string injected once into a
 * `<style>` in the Document `<head>` (see actions/document.tsx). Every component
 * references these via `var(--…)` — there are no hardcoded color/font-size
 * literals in the tokenized files.
 *
 * The dashboard is dark-only today: `:root` carries the dark values and
 * `color-scheme: dark`. `.dark` carries the identical values so that a future
 * light theme can flip `:root` to light and leave `.dark` as the dark override
 * without re-touching every component.
 *
 * The `--status-*` tokens centralize the existing status accent hexes/rgba
 * VERBATIM (centralization only — visual parity, no tuning). Their soft
 * backgrounds were tuned for the old light theme; they still read on the dark
 * scaffold but were not re-tuned here.
 */

/** The custom-property declarations shared by `:root` and `.dark` (identical
 * today). Kept as one string so the two blocks are provably in sync. */
const TOKEN_DECLARATIONS = `  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --font-size-xs: 12px;   /* was 11px labels */
  --font-size-sm: 13px;   /* was 12px meta */
  --font-size-md: 14px;   /* was 13px table/card data */
  --font-size-body: 18px; /* was 14px */
  --font-size-title: 18px;
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --status-running: #3573f6;
  --status-running-strong: #1d4ed8;
  --status-running-soft: rgba(53, 115, 246, 0.1);
  --status-running-selected: rgba(53, 115, 246, 0.08);
  --status-success: #15803d;
  --status-success-strong: #166534;
  --status-success-soft: rgba(21, 128, 61, 0.12);
  --status-failed: #b91c1c;
  --status-failed-strong: #991b1b;
  --status-failed-soft: rgba(185, 28, 28, 0.12);
  --status-failed-soft-hover: rgba(185, 28, 28, 0.06);
  --status-interrupted: #b45309;
  --status-interrupted-soft: rgba(180, 83, 9, 0.12);
  --status-paused: #92400e;
  --status-muted: #6b7280;
  --status-muted-soft: rgba(107, 114, 128, 0.12);
  --status-queued: #9ca3af;
  --status-queued-soft: rgba(156, 163, 175, 0.1);
  --danger-border: #fecaca;
  --amber-border: #f3c14a;
  --amber-border-soft: #fcd34d;
  --amber-surface: #fff7ed;
  --amber-ink: #78350f;
  --amber-soft-strong: rgba(243, 193, 74, 0.2);
  --amber-soft: rgba(243, 193, 74, 0.12);
  --amber-soft-faint: rgba(243, 193, 74, 0.1);
  --amber-soft-faintest: rgba(243, 193, 74, 0.07);
  --accent-violet: #6d28d9;
  --accent-teal: #0f766e;
  --accent-sky: #0369a1;
  --shadow-hover: rgba(0, 0, 0, 0.12);
  --stripe-highlight: rgba(255, 255, 255, 0.4);
  --stripe-highlight-clear: rgba(255, 255, 255, 0);`;

/** The full token stylesheet: `:root` (dark, with `color-scheme: dark`) plus a
 * `.dark` block carrying identical values. Injected into the Document head. */
export const TOKEN_CSS = `:root {
  color-scheme: dark;
${TOKEN_DECLARATIONS}
}
.dark {
${TOKEN_DECLARATIONS}
}`;
