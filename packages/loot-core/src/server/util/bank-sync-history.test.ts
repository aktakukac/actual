import { describe, expect, test } from 'vitest';

import { limitBankSyncStartDate } from './bank-sync-history';

describe('limitBankSyncStartDate', () => {
  test('limits an older request to 30 calendar days including today', () => {
    expect(limitBankSyncStartDate('2026-07-12', '30', '2026-10-09')).toBe(
      '2026-09-10',
    );
  });

  test('preserves a request that starts inside the window', () => {
    expect(limitBankSyncStartDate('2026-10-01', '30', '2026-10-09')).toBe(
      '2026-10-01',
    );
  });

  test('preserves a request on the earliest allowed day', () => {
    expect(limitBankSyncStartDate('2026-09-10', '30', '2026-10-09')).toBe(
      '2026-09-10',
    );
  });

  test('handles a window crossing a year boundary', () => {
    expect(limitBankSyncStartDate('2025-10-01', '30', '2026-01-10')).toBe(
      '2025-12-12',
    );
  });

  test('handles a leap-year February', () => {
    expect(limitBankSyncStartDate('2024-01-01', '30', '2024-03-01')).toBe(
      '2024-02-01',
    );
  });

  test('preserves existing behavior for the default option', () => {
    expect(limitBankSyncStartDate('2026-07-12', '90', '2026-10-09')).toBe(
      '2026-07-12',
    );
  });

  test.each(['', '0', '-1', '29', '31', 'abc'])(
    'rejects unsupported history setting %j',
    historyDays => {
      expect(() =>
        limitBankSyncStartDate('2026-07-12', historyDays, '2026-10-09'),
      ).toThrow('Bank sync history window must be 30 or 90 days.');
    },
  );
});
