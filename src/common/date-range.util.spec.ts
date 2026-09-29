import { BadRequestException } from '@nestjs/common';
import {
  addUtcDays,
  addUtcMonths,
  parseIsoDate,
  resolveDateRange,
  startOfUtcDay,
  startOfUtcMonth,
} from './date-range.util';

describe('date-range.util', () => {
  it('parses YYYY-MM-DD as UTC midnight', () => {
    expect(parseIsoDate('2024-03-15').toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('rejects malformed and invalid dates', () => {
    expect(() => parseIsoDate('2024/03/15')).toThrow(BadRequestException);
    expect(() => parseIsoDate('2024-13-45')).toThrow(BadRequestException);
  });

  it('truncates and shifts dates in UTC', () => {
    const value = new Date('2024-01-31T18:45:00.000Z');
    expect(startOfUtcDay(value).toISOString()).toBe('2024-01-31T00:00:00.000Z');
    expect(startOfUtcMonth(value).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(addUtcDays(value, 1).toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(addUtcMonths(value, -1).toISOString()).toBe('2023-12-01T00:00:00.000Z');
  });

  it('resolves an explicit daily range with an exclusive end', () => {
    const range = resolveDateRange('daily', '2024-03-01', '2024-03-10');
    expect(range.start.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2024-03-11T00:00:00.000Z');
  });

  it('resolves an explicit monthly range to whole months', () => {
    const range = resolveDateRange('monthly', '2024-01-15', '2024-03-10');
    expect(range.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });

  it('defaults to the last 30 days and last 12 months', () => {
    const daily = resolveDateRange('daily');
    expect(addUtcDays(daily.start, 30).getTime()).toBe(daily.endExclusive.getTime());

    const monthly = resolveDateRange('monthly');
    expect(addUtcMonths(monthly.start, 12).getTime()).toBe(monthly.endExclusive.getTime());
  });

  it('rejects ranges where dateFrom is after dateTo', () => {
    expect(() => resolveDateRange('daily', '2024-03-10', '2024-03-01')).toThrow(
      BadRequestException,
    );
    expect(() => resolveDateRange('monthly', '2024-05-01', '2024-03-01')).toThrow(
      BadRequestException,
    );
  });
});
