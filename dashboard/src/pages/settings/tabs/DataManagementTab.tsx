import { useState } from 'react';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { useLocale, type LocaleKey } from '../../../hooks/useLocale';
import { errorKeyOf } from '../../../lib/errors';
import { multiplayer } from '../../../stores/multiplayerStore';
import { notices } from '../../../stores/noticeStore';
import { workspace } from '../../../stores/workspaceStore';
import { api } from '../../../stores/api';
import { store } from '../../../stores/store';

const dataKinds = [
  'map-preferences',
  'annotations',
  'calibration',
  'marker-preferences',
  'items-settings',
  'multiplayer',
] as const;

type DataKind = (typeof dataKinds)[number];

export function DataManagementTab() {
  const { t } = useLocale();
  const [confirm, setConfirm] = useState<DataKind>();
  const [busy, setBusy] = useState<DataKind>();

  const reset = async () => {
    const kind = confirm;
    if (!kind) return;
    setConfirm(undefined);
    setBusy(kind);
    try {
      if (kind === 'annotations') await workspace.waitForSaves();
      await store.dispatch(api.endpoints.resetData.initiate(kind)).unwrap();
      if (kind === 'annotations') await workspace.reloadAfterAnnotationReset();
      else if (kind === 'map-preferences' || kind === 'calibration') await workspace.initialize();
      if (kind === 'marker-preferences' || kind === 'multiplayer') await multiplayer.reload();
      notices.push(t('settings.dataManagement.resetDone'), undefined, 'success');
    } catch (error) {
      const code = errorKeyOf(error, 'errors.data_reset_failed');
      notices.push(
        t(
          (code === 'errors.multiplayer_reset_in_room'
            ? code
            : 'errors.data_reset_failed') as LocaleKey,
        ),
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="data-management">
      {dataKinds.map((kind) => (
        <section className="data-management-row" key={kind}>
          <div>
            <h2>{t(`settings.dataManagement.cards.${kind}.title` as LocaleKey)}</h2>
            <p>{t(`settings.dataManagement.cards.${kind}.description` as LocaleKey)}</p>
          </div>
          <button disabled={busy !== undefined} onClick={() => setConfirm(kind)}>
            {busy === kind
              ? t('settings.dataManagement.resetting')
              : t('settings.dataManagement.reset')}
          </button>
        </section>
      ))}
      <ConfirmDialog
        open={confirm !== undefined}
        title={confirm ? t(`settings.dataManagement.cards.${confirm}.title` as LocaleKey) : ''}
        message={confirm ? t(`settings.dataManagement.cards.${confirm}.confirm` as LocaleKey) : ''}
        confirmLabel={t('settings.dataManagement.confirm')}
        danger
        onConfirm={() => void reset()}
        onCancel={() => setConfirm(undefined)}
      />
    </div>
  );
}
