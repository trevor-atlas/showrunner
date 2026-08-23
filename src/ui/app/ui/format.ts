/**
 * Shared formatting helpers (spec §16.10) — reused by the run list today and
 * by the run-detail/drill-in tickets later. Pure functions, no UI.
 */

/** Short run id — the first 6 chars of the run's uuid (§16.6 mockup). */
export function fmtRunId(id: string): string {
  return id.slice(0, 6);
}

/** USD spend, "$0.42" — two decimals, `$` prefix (§16.6 SPEND column). */
export function fmtMoney(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Duration from milliseconds: "08:31" (mm:ss), "1:02:03" past an hour. */
export function fmtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Token counts with thousands separators: "12,480". */
export function fmtTokens(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Started-at timestamp rendered as local clock time, "14:02:11" (§16.6). */
export function fmtStartedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
