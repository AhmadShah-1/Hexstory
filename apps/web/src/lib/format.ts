const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

export function timeAgo(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

/** Average area of one base-resolution (res 5) hex. */
const BASE_CELL_KM2 = 252.9;

/** "About 12,000 km²": friendlier than a hex count, since hexes look different sizes at different zooms. */
export function areaKm2(baseCellCount: number): string {
  const km2 = baseCellCount * BASE_CELL_KM2;
  const rounded = km2 < 1_000 ? Math.round(km2 / 10) * 10 : Number(km2.toPrecision(2));
  return `${rounded.toLocaleString()} km²`;
}
