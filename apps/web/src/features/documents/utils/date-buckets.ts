/** Labels for the "group by date" axis. Server returns YYYY-MM-DD day ids;
 *  this turns them into friendly labels. Pure, no React. */

/** Local calendar-day key, `YYYY-MM-DD`. */
function keyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Friendly label for a day key: "Today" / "Yesterday" for the two most recent
 * days, otherwise an absolute date like "Jun 4, 2026".
 */
export function dayLabel(key: string): string {
  const now = new Date();
  const todayKey = keyFromDate(now);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = keyFromDate(yesterday);

  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";

  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
