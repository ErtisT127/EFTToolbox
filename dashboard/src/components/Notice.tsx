import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { notices, useNotices, type Notice as NoticeMessage } from '../stores/noticeStore';
import { useLocale } from '../hooks/useLocale';

// Long enough to read and act on, short enough that it clears itself out of the way.
const LifetimeMs = 5000;

function NoticeItem({ notice }: { notice: NoticeMessage }) {
  const { t } = useLocale();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => notices.dismiss(notice.id), LifetimeMs);
    return () => clearTimeout(timer);
  }, [notice.id, paused]);
  return (
    <div
      className={`notice notice-${notice.severity}`}
      role={notice.severity === 'success' ? 'status' : 'alert'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{notice.message}</span>
      {notice.retry && (
        <button
          className="notice-action"
          onClick={() => {
            notice.retry?.();
            notices.dismiss(notice.id);
          }}
        >
          {t('common.retry')}
        </button>
      )}
      <button
        className="notice-close"
        aria-label={t('common.dismiss')}
        onClick={() => notices.dismiss(notice.id)}
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Error surfacing lives at the top edge of the window, not inside the page that happened to fail. */
export function NoticeHost() {
  const store = useNotices();
  if (!store.notices.length) return null;
  return (
    <div className="notice-host">
      {store.notices.map((notice) => (
        <NoticeItem key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
