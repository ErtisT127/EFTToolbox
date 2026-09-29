import { useState } from 'react';
import { useMultiplayer, MultiplayerError, multiplayer } from '../../stores/multiplayerStore';
import { MemberList, memberRows, type MemberRow } from '../../components/MemberList';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useLocale, type LocaleKey } from '../../hooks/useLocale';
import { notices } from '../../stores/noticeStore';

// Quick preview on the map page: fed by the /ws push (zero polling) and the same row mapper as the
// room info page.
export function MembersPanel() {
  const { t } = useLocale();
  const mp = useMultiplayer();
  const [kickTarget, setKickTarget] = useState<MemberRow | null>(null);
  const [pending, setPending] = useState(false);
  const status = mp.status;
  if (!status.enabled || !status.self || !mp.showMembersPanel) return null;

  const rows = memberRows(status);

  const confirmKick = async () => {
    if (!kickTarget || pending) return;
    setPending(true);
    try {
      await multiplayer.kick(kickTarget.peerId);
      setKickTarget(null);
      notices.push(t('multiplayer.kicked'), undefined, 'success');
    } catch (failure) {
      const code = failure instanceof MultiplayerError ? failure.code : 'request_failed';
      notices.push(t(`errors.${code}` as LocaleKey), undefined, 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <aside className="mp-members">
        <div className="mp-members-header">
          <span>{t('multiplayer.membersTitle')}</span>
        </div>
        <MemberList rows={rows} slots={5} canKick={status.role === 'host'} onKick={setKickTarget} />
      </aside>
      <ConfirmDialog
        open={kickTarget !== null}
        title={t('multiplayer.kickTitle')}
        message={t('multiplayer.confirmKick', { name: kickTarget?.name || '' })}
        confirmLabel={t('multiplayer.kick')}
        danger
        onConfirm={() => void confirmKick()}
        onCancel={() => {
          if (!pending) setKickTarget(null);
        }}
      />
    </>
  );
}
