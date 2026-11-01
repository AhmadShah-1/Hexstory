/**
 * Historical dates are stored as separate year/month/day parts so we can represent
 * "1848", "March 2011" or "15 March 44 BCE" without inventing precision.
 * Years are historical: negative = BCE, there is no year 0.
 */
export interface DateParts {
  year: number;
  month?: number | null;
  day?: number | null;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function daysInMonth(year: number, month: number): number {
  // Proleptic Gregorian is close enough for validation; year 0 never occurs.
  const astronomical = year < 0 ? year + 1 : year;
  const leap = (astronomical % 4 === 0 && astronomical % 100 !== 0) || astronomical % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function formatDateParts({ year, month, day }: DateParts): string {
  const y = year < 0 ? `${-year} BCE` : `${year}`;
  if (!month) return y;
  if (!day) return `${MONTHS[month - 1]} ${y}`;
  return `${day} ${MONTHS[month - 1]} ${y}`;
}

export interface EventDate {
  start: DateParts;
  end?: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
}

export function formatEventDate({ start, end, isOngoing, isApprox }: EventDate): string {
  const prefix = isApprox ? 'c. ' : '';
  const startText = prefix + formatDateParts(start);
  if (isOngoing) return `${startText} – ongoing`;
  if (end) return `${startText} – ${formatDateParts(end)}`;
  return startText;
}

/** Mirrors the generated sort_key column in Postgres; higher = more recent. */
export function sortKey({ year, month, day }: DateParts): number {
  return year * 10_000 + (month ?? 0) * 100 + (day ?? 0);
}

export function compareDateParts(a: DateParts, b: DateParts): number {
  return sortKey(a) - sortKey(b);
}
