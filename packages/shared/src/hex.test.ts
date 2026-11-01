import { describe, expect, it } from 'vitest';
import { cellAt, cellRing, compact, indexCells, toBaseCells, uncompact } from './hex.js';
import { formatEventDate, sortKey } from './dates.js';

describe('hex helpers', () => {
  const paris5 = cellAt(48.8566, 2.3522, 5);
  const paris3 = cellAt(48.8566, 2.3522, 3);

  it('expands coarse cells to their base children', () => {
    expect(toBaseCells([paris3])).toHaveLength(49);
    expect(toBaseCells([paris3])).toContain(paris5);
  });

  it('compacts and uncompacts losslessly', () => {
    const base = toBaseCells([paris3]);
    expect(compact(base)).toEqual([paris3]);
    expect(new Set(uncompact([paris3]))).toEqual(new Set(base));
  });

  it('indexes base cells under every display resolution', () => {
    const index = indexCells([paris5]);
    expect(index.map((c) => c.res).sort()).toEqual([2, 3, 4, 5]);
    expect(index.find((c) => c.res === 3)?.cell).toBe(paris3);
  });

  it('keeps antimeridian cells contiguous', () => {
    const ring = cellRing(cellAt(0, 179.99, 2));
    const lngs = ring.map(([lng]) => lng);
    expect(Math.max(...lngs) - Math.min(...lngs)).toBeLessThan(20);
  });
});

describe('dates', () => {
  it('formats precision and BCE', () => {
    expect(formatEventDate({ start: { year: -44, month: 3, day: 15 }, isOngoing: false, isApprox: false }))
      .toBe('15 March 44 BCE');
    expect(formatEventDate({ start: { year: 2011, month: 3 }, isOngoing: true, isApprox: false }))
      .toBe('March 2011 – ongoing');
    expect(formatEventDate({ start: { year: 1848 }, end: { year: 1849 }, isOngoing: false, isApprox: true }))
      .toBe('c. 1848 – 1849');
  });

  it('sorts BCE before CE and later months after earlier ones', () => {
    expect(sortKey({ year: -44, month: 3 })).toBeGreaterThan(sortKey({ year: -44, month: 1 }));
    expect(sortKey({ year: -44 })).toBeGreaterThan(sortKey({ year: -45, month: 12, day: 31 }));
    expect(sortKey({ year: 1 })).toBeGreaterThan(sortKey({ year: -1, month: 12 }));
  });
});
