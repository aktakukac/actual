import * as dateFns from 'date-fns';

import * as monthUtils from '#shared/months';

export function limitBankSyncStartDate(
  startDate: string,
  historyDays: string,
  today: string,
): string {
  if (historyDays !== '30' && historyDays !== '90') {
    throw new Error('Bank sync history window must be 30 or 90 days.');
  }

  if (historyDays === '90') {
    return startDate;
  }

  const earliestDate = monthUtils.subDays(today, 29);
  return monthUtils.dayFromDate(
    dateFns.max([
      monthUtils.parseDate(startDate),
      monthUtils.parseDate(earliestDate),
    ]),
  );
}
