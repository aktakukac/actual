import { Trans, useTranslation } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

type BankSyncHistoryDaysProps = {
  historyDays: string;
  onChange: (value: string) => void;
};

export function BankSyncHistoryDays({
  historyDays,
  onChange,
}: BankSyncHistoryDaysProps) {
  const { t } = useTranslation();

  return (
    <View style={{ marginTop: 16, gap: 8 }}>
      <label htmlFor="bank-sync-history-days">
        <Trans>Transaction history window</Trans>
      </label>
      <Select
        id="bank-sync-history-days"
        value={historyDays}
        onChange={onChange}
        options={[
          ['30', t('30 days')],
          ['90', t('90 days (default)')],
        ]}
      />
      <Text>
        <Trans>
          Limits how far back bank sync requests transactions. Existing
          transactions are not deleted. Choose 30 days if your bank limits
          transaction history to 30 days.
        </Trans>
      </Text>
    </View>
  );
}
