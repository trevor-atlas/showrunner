/**
 * Select (issue #36) — a token-styled dropdown wrapping the remix/ui select
 * primitive.
 *
 * Verified rendering (node_modules/@remix-run/ui/dist/select/index.{d.ts,js}):
 * the primitive renders IN PLACE — a `<button>` trigger followed by an inline
 * `popover.Context` surface `<div>` holding the option list, plus a hidden
 * `<input>` when `name` is set. remix/ui's popover uses NO portal (no
 * document.body append, no createPortal — it positions an anchored surface at
 * runtime), so the whole widget is a normal element subtree that SSR-renders
 * safely; the listbox opens after hydration. Selection state is internal to
 * the primitive's context; pass `name` to surface the value as a hidden form
 * input.
 *
 * We layer token styles LAST in the trigger's mix array, so they override the
 * primitive's built-in trigger colors (the primitive hardcodes light-dark
 * literals; we re-skin with var(--input)/var(--foreground)/…). Options are
 * declared as data so callers never touch the primitive directly.
 *
 * Browser-bundle-safe (public/, remix/ui only), tokens only.
 */
import { css, type Handle } from "remix/ui";
import { Option as OptionPrimitive, Select as SelectPrimitive } from "remix/ui/select";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  /** the label shown before a value is chosen */
  defaultLabel: string;
  defaultValue?: string | null;
  /** when set, the chosen value is surfaced as a hidden form input */
  name?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Select(handle: Handle<SelectProps>) {
  return () => {
    const { options, defaultLabel, defaultValue, name, disabled, ariaLabel } = handle.props;
    return (
      <SelectPrimitive
        data-component="select"
        defaultLabel={defaultLabel}
        defaultValue={defaultValue}
        name={name}
        disabled={disabled}
        aria-label={ariaLabel}
        mix={triggerTokenStyle}
      >
        {options.map((option) => (
          <OptionPrimitive
            key={option.value}
            value={option.value}
            label={option.label}
            disabled={option.disabled}
            mix={optionTokenStyle}
          >
            {option.label}
          </OptionPrimitive>
        ))}
      </SelectPrimitive>
    );
  };
}

const triggerTokenStyle = css({
  boxShadow: "none",
  border: "1px solid var(--input)",
  borderRadius: "8px",
  background: "var(--background)",
  color: "var(--foreground)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-md)",
  textShadow: "none",
  "&:hover, &:focus-visible, &[aria-expanded=\"true\"]": {
    background: "var(--background)",
    color: "var(--foreground)",
  },
  "&:focus-visible, &[aria-expanded=\"true\"]": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
    boxShadow: "none",
  },
});

const optionTokenStyle = css({
  color: "var(--popover-foreground)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-md)",
});
