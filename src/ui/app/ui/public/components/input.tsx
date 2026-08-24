/**
 * Input (issue #36) — a token-styled text input. A plain controlled-friendly
 * `<input>`; the caller owns value/change (wired via the `on` mixin) so the
 * component stays stateless and SSR-safe. Browser-bundle-safe (public/,
 * remix/ui only), tokens only.
 */
import { css, on, type Handle } from "remix/ui";

export interface InputProps {
  value?: string;
  placeholder?: string;
  name?: string;
  /** `search` gets a searchbox role + the native clear affordance; anything
   * else is a plain textbox. */
  type?: "text" | "search";
  disabled?: boolean;
  ariaLabel?: string;
  onInput?: (value: string, event: Event) => void;
}

export function Input(handle: Handle<InputProps>) {
  return () => {
    const { value, placeholder, name, type = "text", disabled = false, ariaLabel, onInput } = handle.props;
    const mix = [
      baseStyle,
      onInput != null
        ? on<HTMLInputElement>("input", (event) => onInput((event.target as HTMLInputElement).value, event))
        : null,
    ];
    // Render a concrete literal `type` so the discriminated input-props union
    // resolves (a union-typed variable can't select a branch).
    if (type === "search") {
      return (
        <input
          data-component="input"
          type="search"
          value={value}
          placeholder={placeholder}
          name={name}
          disabled={disabled}
          aria-label={ariaLabel}
          mix={mix}
        />
      );
    }
    return (
      <input
        data-component="input"
        type="text"
        value={value}
        placeholder={placeholder}
        name={name}
        disabled={disabled}
        aria-label={ariaLabel}
        mix={mix}
      />
    );
  };
}

const baseStyle = css({
  boxSizing: "border-box",
  width: "100%",
  height: "32px",
  padding: "0.35rem 0.6rem",
  borderRadius: "8px",
  border: "1px solid var(--input)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: "var(--font-size-md)",
  fontFamily: "var(--font-sans)",
  lineHeight: 1.4,
  "&::placeholder": {
    color: "var(--muted-foreground)",
  },
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
    borderColor: "var(--ring)",
  },
  "&:disabled": {
    opacity: 0.55,
    cursor: "not-allowed",
  },
});
