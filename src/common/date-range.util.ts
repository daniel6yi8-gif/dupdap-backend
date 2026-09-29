import { BadRequestException } from '@nestjs/common';

export type DateRangePeriod = 'daily' | 'monthly';

export interface DateRange {
  start: Date;
  endExclusive: Date;
}

export function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('Dates must use YYYY-MM-DD format');
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }

  return parsed;
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

export function addUtcDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

export function addUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

/**
 * Resolves an optional YYYY-MM-DD range into a half-open UTC range.
 * Defaults to the last 30 days (daily) or last 12 months (monthly).
 */
export function resolveDateRange(
  period: DateRangePeriod,
  dateFrom?: string,
  dateTo?: string,
): DateRange {
  if (period === 'daily') {
    const endInclusive = dateTo ? parseIsoDate(dateTo) : startOfUtcDay(new Date());
    const start = dateFrom ? parseIsoDate(dateFrom) : addUtcDays(endInclusive, -29);

    if (start > endInclusive) {
      throw new BadRequestException('"dateFrom" must be before or equal to "dateTo"');
    }

    return { start, endExclusive: addUtcDays(endInclusive, 1) };
  }

  const endMonth = startOfUtcMonth(dateTo ? parseIsoDate(dateTo) : new Date());
  const startMonth = dateFrom
    ? startOfUtcMonth(parseIsoDate(dateFrom))
    : addUtcMonths(endMonth, -11);

  if (startMonth > endMonth) {
    throw new BadRequestException('"dateFrom" must be before or equal to "dateTo"');
  }

  return { start: startMonth, endExclusive: addUtcMonths(endMonth, 1) };
}
