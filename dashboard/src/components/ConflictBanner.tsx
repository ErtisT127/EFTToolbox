import { useSelector } from 'react-redux';
import { useLocale } from '../hooks/useLocale';
import { clearConflict } from '../stores/clientState';
import { conflictActionsFor, useConflictActionsVersion } from '../stores/conflictActions';
import { store, type RootState } from '../stores/store';

/**
 * The window-level revision-conflict prompt. Rendered once by the notice host so it shares the top
 * edge with the other notices and never stacks a dialog on whatever dialog raised it. "Keep local"
 * is always available (clearing the conflict keeps the draft); the page-scoped choices appear only
 * while the owning page has registered them.
 */
export function ConflictBanner() {
  const { t } = useLocale();
  const conflicts = useSelector((state: RootState) => state.client.conflicts);
  useConflictActionsVersion();
  if (!conflicts.length) return null;
  return (
    <>
      {conflicts.map((conflict) => {
        const actions = conflictActionsFor(conflict.key);
        return (
          <div className="conflict-banner" role="alert" key={conflict.key}>
            <span className="conflict-banner-message">{t('errors.revision_conflict')}</span>
            <div className="conflict-banner-actions">
              <button type="button" onClick={() => store.dispatch(clearConflict(conflict.key))}>
                {t('errors.conflict_keep_local')}
              </button>
              {actions && (
                <button type="button" onClick={actions.loadRemote}>
                  {t('errors.conflict_load_remote')}
                </button>
              )}
              {actions && (
                <button type="button" className="primary" onClick={actions.retry}>
                  {t('errors.conflict_retry')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
