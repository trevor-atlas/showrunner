import { clientEntry, css, on } from "remix/ui";
import type { Handle, SerializableProps } from "remix/ui";

/**
 * The run-list toolbar: status filter + refresh (spec §16.6). A plain GET
 * form — `refresh` re-fetches GET /runs server-side and the status select
 * narrows the list — progressively enhanced: with the client runtime on,
 * changing the status submits the form (auto-submit on change) and the
 * refresh button shows a pending state; without it the form still works as a
 * normal document GET navigation.
 *
 * Client-entry props are serializable (string / string[] / string) — the
 * daemon stays server-side; the browser only navigates back to `/`.
 */
export interface RunFilterFormProps extends SerializableProps {
  /** href of the run list route (`routes.home.href()`) */
  action: string;
  /** filter values: "all" followed by RUN_STATUSES */
  statuses: string[];
  /** the current filter (search param), "all" when unset */
  current: string;
}

export const RunFilterForm = clientEntry(
  import.meta.url,
  function RunFilterForm(handle: Handle<RunFilterFormProps>) {
    // Setup scope — runs once. Local UI state lives here, updated via handle.update().
    let refreshing = false;

    return () => {
      const { action, statuses, current } = handle.props;

      return (
        <form
          action={action}
          method="get"
          mix={[
            formStyle,
            on("submit", () => {
              refreshing = true;
              handle.update();
            }),
          ]}
        >
          <label mix={labelStyle}>
            status
            <select
              name="status"
              mix={on("change", (event) => {
                // auto-submit the filter (requestSubmit fires the form's
                // submit event, which flips the pending state above)
                event.currentTarget.form?.requestSubmit();
              })}
            >
              {statuses.map((status) => (
                <option key={status} value={status} selected={status === current ? true : undefined}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <button disabled={refreshing} type="submit" mix={refreshButtonStyle}>
            {refreshing ? "refreshing…" : "refresh"}
          </button>
        </form>
      );
    };
  },
);

const formStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
});

const labelStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "12px",
  color: "#6b7280",
  textTransform: "lowercase",
  "& select": {
    font: "inherit",
    padding: "3px 6px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    background: "#ffffff",
  },
});

const refreshButtonStyle = css({
  appearance: "none",
  font: "inherit",
  fontSize: "12px",
  fontWeight: 700,
  padding: "4px 12px",
  borderRadius: "999px",
  border: "1px solid #d1d5db",
  background: "#ffffff",
  color: "#111827",
  cursor: "pointer",
  "&:hover:not(:disabled)": {
    background: "#f3f4f6",
  },
  "&:disabled": {
    opacity: 0.6,
    cursor: "wait",
  },
});
