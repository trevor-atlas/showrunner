/**
 * Table (issue #36) — a token-styled table shell plus header/row/cell helpers.
 * `TableHeader` supports sortable columns: it emits the ARIA `aria-sort` state
 * ("ascending" | "descending" | "none") and reserves an indicator glyph slot
 * so a caller can drop a ▲/▼ marker; when `onSort` is set the header content is
 * a real `<button>` so it's keyboard-operable. Browser-bundle-safe (public/,
 * remix/ui only), tokens only, SSR-safe.
 */
import { css, on, type Handle, type RemixNode } from "remix/ui";

export type SortDirection = "ascending" | "descending" | "none";

export interface TableProps {
  children?: RemixNode;
}

export interface TableSectionProps {
  children?: RemixNode;
}

export interface TableRowProps {
  children?: RemixNode;
}

export interface TableCellProps {
  /** render as a row header cell (`<th scope="row">`) instead of `<td>` */
  rowHeader?: boolean;
  align?: "start" | "center" | "end";
  children?: RemixNode;
}

export interface TableHeaderProps {
  /** the column's sort state; presence of a non-undefined value marks the
   * column sortable and drives `aria-sort` */
  sort?: SortDirection;
  align?: "start" | "center" | "end";
  onSort?: () => void;
  /** the ▲/▼ (or any) indicator glyph rendered after the label */
  indicator?: RemixNode;
  children?: RemixNode;
}

export function Table(handle: Handle<TableProps>) {
  return () => (
    <table data-component="table" mix={tableStyle}>
      {handle.props.children}
    </table>
  );
}

export function TableHead(handle: Handle<TableSectionProps>) {
  return () => <thead mix={theadStyle}>{handle.props.children}</thead>;
}

export function TableBody(handle: Handle<TableSectionProps>) {
  return () => <tbody>{handle.props.children}</tbody>;
}

export function TableRow(handle: Handle<TableRowProps>) {
  return () => (
    <tr data-table-row mix={rowStyle}>
      {handle.props.children}
    </tr>
  );
}

export function TableCell(handle: Handle<TableCellProps>) {
  return () => {
    const { rowHeader = false, align = "start", children } = handle.props;
    if (rowHeader) {
      return (
        <th scope="row" mix={[cellStyle, alignStyle[align]]}>
          {children}
        </th>
      );
    }
    return (
      <td mix={[cellStyle, alignStyle[align]]}>
        {children}
      </td>
    );
  };
}

export function TableHeader(handle: Handle<TableHeaderProps>) {
  return () => {
    const { sort, align = "start", onSort, indicator, children } = handle.props;
    const sortable = sort !== undefined;
    const label = sortable ? (
      <button
        type="button"
        data-table-sort
        mix={[sortButtonStyle, onSort != null ? on("click", () => onSort()) : null]}
      >
        <span>{children}</span>
        <span data-sort-indicator mix={indicatorStyle} aria-hidden="true">
          {indicator}
        </span>
      </button>
    ) : (
      children
    );
    return (
      <th
        scope="col"
        aria-sort={sortable ? sort : undefined}
        mix={[headerStyle, alignStyle[align]]}
      >
        {label}
      </th>
    );
  };
}

const tableStyle = css({
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--font-size-md)",
  fontFamily: "var(--font-sans)",
  color: "var(--foreground)",
});

const theadStyle = css({
  borderBottom: "1px solid var(--border)",
});

const headerStyle = css({
  padding: "0.4rem 0.6rem",
  fontSize: "var(--font-size-sm)",
  fontWeight: 600,
  color: "var(--muted-foreground)",
  whiteSpace: "nowrap",
});

const rowStyle = css({
  borderBottom: "1px solid var(--border)",
});

const cellStyle = css({
  padding: "0.4rem 0.6rem",
  verticalAlign: "top",
});

const alignStyle: Record<"start" | "center" | "end", ReturnType<typeof css>> = {
  start: css({ textAlign: "left" }),
  center: css({ textAlign: "center" }),
  end: css({ textAlign: "right" }),
};

const sortButtonStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  background: "transparent",
  border: 0,
  padding: 0,
  margin: 0,
  cursor: "pointer",
  color: "inherit",
  font: "inherit",
  fontWeight: 600,
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const indicatorStyle = css({
  display: "inline-flex",
  width: "0.75rem",
  justifyContent: "center",
  color: "var(--muted-foreground)",
});
