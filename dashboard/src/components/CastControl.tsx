import { Check, ChevronDown, Copy, Smartphone, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { isImeComposing } from '../lib/ime';
import { errorDetailOf } from '../lib/errors';
import { useLocale } from '../hooks/useLocale';
import { notices } from '../stores/noticeStore';
import { reportThrottledFailure } from '../stores/workspaceStore';
import { AppPopover } from './AppPopover';
import {
  useGetCastInterfacesQuery,
  useGetCastStatusQuery,
  useStartCastMutation,
  useStopCastMutation,
} from '../stores/api';

type Stage = 'config' | 'running' | 'confirm';
type CopyState = 'idle' | 'copying' | 'copied';

const CopyFeedbackMs = 1500;

export function CastControl() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('config');
  const {
    data: status = { enabled: false, connected: 0 },
    refetch: load,
    error: statusError,
  } = useGetCastStatusQuery(undefined, {
    pollingInterval: open ? 2000 : 0,
  });
  const { data: interfaceData, error: interfacesError } = useGetCastInterfacesQuery();
  const [startCast] = useStartCastMutation();
  const [stopCast] = useStopCastMutation();
  const [address, setAddress] = useState('');
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [requesting, setRequesting] = useState<'start' | 'stop' | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const addressField = useRef<HTMLSpanElement>(null);
  const addressToggle = useRef<HTMLButtonElement>(null);
  const copyLocked = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setStage((current) =>
      current === 'confirm' ? current : status.enabled ? 'running' : 'config',
    );
  }, [status.enabled]);
  useEffect(() => {
    if (!interfaceData) return;
    setInterfaces(interfaceData.addresses ?? []);
    setAddress((current) => current || interfaceData.addresses[0] || '');
  }, [interfaceData]);
  useEffect(() => {
    if (statusError) reportThrottledFailure('cast_status_poll_failed', errorDetailOf(statusError));
    if (interfacesError)
      reportThrottledFailure('cast_interfaces_failed', errorDetailOf(interfacesError));
  }, [statusError, interfacesError]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const close = () => {
    setOpen(false);
    // Abandoning the stop confirmation always lands back on the running panel; the next status
    // load reconciles the stage with reality.
    setStage((current) => (current === 'confirm' ? 'running' : current));
    triggerButton.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (suggestOpen) {
          setSuggestOpen(false);
          addressToggle.current?.focus();
          return;
        }
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, suggestOpen]);

  const start = async () => {
    if (requesting) return;
    setRequesting('start');
    try {
      await startCast({ address: address.trim() }).unwrap();
      setStage('running');
    } catch (reason) {
      const data =
        reason && typeof reason === 'object' && 'data' in reason ? reason.data : undefined;
      const body =
        data && typeof data === 'object' ? (data as { code?: string; detail?: string }) : {};
      {
        notices.push(
          body.code === 'mobile_address_invalid'
            ? t('cast.addressInvalid')
            : body.code === 'mobile_port_in_use'
              ? t('cast.portInUse', { port: body.detail ?? '' })
              : t('cast.startFailed'),
        );
      }
    } finally {
      setRequesting(null);
    }
  };

  const stop = async () => {
    if (requesting) return;
    setRequesting('stop');
    try {
      await stopCast().unwrap();
      setStage('config');
      close();
    } catch {
      notices.push(t('cast.stopFailed'));
    } finally {
      setRequesting(null);
    }
  };

  const copy = async () => {
    if (!status.url || copyLocked.current) return;
    copyLocked.current = true;
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(status.url);
      setCopyState('copied');
      notices.push(t('cast.copied'), undefined, 'success');
      copyTimer.current = window.setTimeout(() => {
        copyLocked.current = false;
        copyTimer.current = undefined;
        setCopyState('idle');
      }, CopyFeedbackMs);
    } catch {
      copyLocked.current = false;
      setCopyState('idle');
      notices.push(t('cast.copyFailed'));
    }
  };

  return (
    <>
      <button
        className={`cast-trigger ${status.enabled ? 'connected' : ''}`}
        ref={triggerButton}
        type="button"
        aria-label={t('cast.trigger')}
        title={t('cast.trigger')}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Smartphone size={20} />
      </button>
      {open && (
        <div
          className="cast-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="cast-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('cast.trigger')}
            ref={dialog}
          >
            <button
              ref={closeButton}
              className="cast-dialog-close"
              type="button"
              aria-label={t('cast.close')}
              title={t('cast.close')}
              onClick={close}
            >
              <X size={18} />
            </button>
            {stage === 'config' ? (
              <>
                <h2>{t('cast.configTitle')}</h2>
                <label htmlFor="cast-address">
                  {t('cast.address')}
                  <span className="cast-address-field" ref={addressField}>
                    <input
                      id="cast-address"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                    />
                    {interfaces.length > 0 && (
                      <button
                        className="cast-address-toggle"
                        type="button"
                        aria-label={t('cast.pickAddress')}
                        title={t('cast.pickAddress')}
                        aria-expanded={suggestOpen}
                        ref={addressToggle}
                        onClick={() => setSuggestOpen((current) => !current)}
                      >
                        <ChevronDown size={14} />
                      </button>
                    )}
                  </span>
                </label>
                {suggestOpen && (
                  <AppPopover
                    open={suggestOpen}
                    reference={addressField}
                    placement="bottom-start"
                    className="cast-address-popover"
                    matchReferenceWidth
                    onDismiss={() => setSuggestOpen(false)}
                  >
                    <div
                      className="cast-address-list"
                      role="listbox"
                      aria-label={t('cast.pickAddress')}
                    >
                      {interfaces.map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="option"
                          aria-selected={value === address}
                          className={value === address ? 'selected' : ''}
                          onClick={() => {
                            setAddress(value);
                            setSuggestOpen(false);
                          }}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </AppPopover>
                )}
                <button
                  className="cast-primary"
                  type="button"
                  disabled={!address.trim() || requesting !== null}
                  onClick={() => void start()}
                >
                  {requesting === 'start' ? t('cast.starting') : t('cast.start')}
                </button>
              </>
            ) : stage === 'running' ? (
              <>
                <h2>{t('cast.runningTitle')}</h2>
                {status.url && (
                  <QRCodeSVG className="cast-qr" value={status.url} size={192} includeMargin />
                )}
                <p className="cast-address">{status.url}</p>
                <button
                  className={`cast-copy ${copyState === 'copied' ? 'copied' : ''}`}
                  type="button"
                  disabled={copyState !== 'idle'}
                  onClick={() => void copy()}
                >
                  {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
                  {t(
                    copyState === 'copied'
                      ? 'cast.copied'
                      : copyState === 'copying'
                        ? 'cast.copying'
                        : 'cast.copyAddress',
                  )}
                </button>
                <button
                  className="cast-danger"
                  type="button"
                  disabled={requesting !== null}
                  onClick={() => setStage('confirm')}
                >
                  {t('cast.stop')}
                </button>
              </>
            ) : (
              <>
                <h2>{t('cast.stopTitle')}</h2>
                <p>{t('cast.stopDescription')}</p>
                <div className="cast-actions">
                  <button
                    className="cast-danger"
                    type="button"
                    disabled={requesting !== null}
                    onClick={() => void stop()}
                  >
                    {requesting === 'stop' ? t('cast.stopping') : t('cast.confirmStop')}
                  </button>
                  <button
                    type="button"
                    disabled={requesting !== null}
                    onClick={() => setStage('running')}
                  >
                    {t('cast.cancel')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
