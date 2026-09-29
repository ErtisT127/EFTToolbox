import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Download,
  Dices,
  Gauge,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import type { MultiplayerHostRequest, MultiplayerStatus } from '../../../contracts/ts/ipc.gen';
import { multiplayer, MultiplayerError, useMultiplayer } from '../stores/multiplayerStore';
import { formatInviteText, parseInviteText, type ParsedInvite } from '../lib/invite';
import { notices } from '../stores/noticeStore';
import { reportThrottledFailure } from '../stores/workspaceStore';
import { AppPopover } from './AppPopover';
import { MemberList, memberRows, type MemberRow } from './MemberList';
import { useLocale, type LocaleKey } from '../hooks/useLocale';
import i18n from '../i18n';
import {
  api,
  useCheckNatMutation,
  useGetMultiplayerInterfacesQuery,
  useGetStunServersQuery,
  useProbeStunServersMutation,
  useRefreshStunServersMutation,
} from '../stores/api';
import { store as reduxStore, type RootState } from '../stores/store';
import { pauseConflict } from '../stores/clientState';

// Backend multiplayer error codes → errors.* copy; the {{port}} placeholder is
// inferred over this key set.
type MultiplayerErrorKey = Extract<LocaleKey, `errors.${string}`>;

type View = 'root' | 'create' | 'join' | 'joinStun' | 'stun' | 'info' | 'confirm' | 'kickConfirm';
type Probe = { state: 'probing' } | { state: 'done'; latencyMs?: number };

const CopyFeedbackMs = 1500;
const ProbeChunk = 16;

// High-separation squad colors: teammates must read apart at a glance on the map and in the
// member panel, so the set avoids near-duplicates instead of reusing the marker palette.
const squadPalette = [
  '#E0B84C',
  '#5FD3C4',
  '#7FB2E5',
  '#D98CCB',
  '#8BD450',
  '#C4554B',
  '#B8A6E8',
  '#E8E6E3',
];

const randomKey = () => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export function MultiplayerControl() {
  const { t } = useLocale();
  const mp = useMultiplayer();
  const identityConflict = useSelector((state: RootState) =>
    state.client.conflicts.find((item) => item.key === 'multiplayer-settings'),
  );
  const markerConflict = useSelector((state: RootState) =>
    state.client.conflicts.find((item) => item.key === 'marker-preferences'),
  );
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('root');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('');
  const [password, setPassword] = useState('');
  const [joinAddress, setJoinAddress] = useState('');
  const [joinPort, setJoinPort] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [stunJoinAddress, setStunJoinAddress] = useState('');
  const [stunJoinServer, setStunJoinServer] = useState('');
  const [stunJoinPassword, setStunJoinPassword] = useState('');
  const [pasteInvite, setPasteInvite] = useState('');
  const [kickTarget, setKickTarget] = useState<MemberRow | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  const status = mp.status;
  const interfacesQuery = useGetMultiplayerInterfacesQuery(undefined, { skip: !open });
  const interfaces = useMemo(() => interfacesQuery.data?.addresses || [], [interfacesQuery.data]);

  useEffect(() => {
    void multiplayer.initialize();
  }, []);

  // Seed the name input once the identity loads; afterwards the user's typing wins. The backend
  // fills an unnamed profile with its own Chinese default, so the name equal to that default counts
  // as unset and is seeded in the interface language instead.
  useEffect(() => {
    if (name) return;
    const id = mp.selfId.slice(0, 4);
    const backendDefault = i18n.t('multiplayer.defaultPlayerName', { id, lng: 'zh-CN' });
    if (mp.selfName && mp.selfName !== backendDefault) setName(mp.selfName);
    else if (id) setName(t('multiplayer.defaultPlayerName', { id }));
  }, [mp.selfName, mp.selfId, name, t]);

  useEffect(() => {
    if (interfacesQuery.isError)
      reportThrottledFailure('multiplayer_interfaces_failed', String(interfacesQuery.error));
  }, [interfacesQuery.error, interfacesQuery.isError]);

  useEffect(() => {
    if (interfaces.length) setAddress((current) => current || interfaces[0]);
  }, [interfaces]);

  const close = () => {
    setOpen(false);
    setView('root');
    setError(null);
    triggerButton.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
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
  }, [open]);

  // The status push owns the truth: a room that ends while the info view is open lands back on
  // the root, whose entries follow the room state at render time.
  useEffect(() => {
    if (!pending && !status.enabled && view === 'info') setView('root');
  }, [status.enabled, pending, view]);

  const failureMessage = (failure: unknown) => {
    const code = failure instanceof MultiplayerError ? failure.code : 'request_failed';
    const detail = failure instanceof MultiplayerError ? failure.detail : '';
    if (view === 'root' || view === 'info' || view === 'confirm' || view === 'kickConfirm') {
      // No form to show an inline error on; the shared notice pipeline carries it.
      notices.push(
        t(`errors.${code}` as MultiplayerErrorKey, { port: detail }),
        undefined,
        'error',
      );
      return;
    }
    setError({ code, detail });
    // focus-management: after a failed submit, put the cursor on the field to fix.
    const fieldByCode: Record<string, string> = {
      multiplayer_address_invalid: view === 'join' ? 'mp-join-address' : 'mp-address',
      multiplayer_share_invalid: view === 'join' ? 'mp-join-address' : 'mp-address',
      multiplayer_port_in_use: 'mp-port',
      multiplayer_port_invalid: 'mp-port',
      multiplayer_key_invalid: view === 'join' ? 'mp-join-password' : 'mp-password',
      multiplayer_signaling_timeout: view === 'join' ? 'mp-join-address' : 'mp-address',
      multiplayer_connection_failed: view === 'join' ? 'mp-join-address' : 'mp-address',
    };
    const fieldId = fieldByCode[code];
    if (fieldId) dialog.current?.querySelector<HTMLElement>(`#${fieldId}`)?.focus();
  };

  const saveIdentity = (changes: {
    playerName?: string;
    playerColor?: string;
    showMembersPanel?: boolean;
  }) => {
    void multiplayer.saveIdentity(changes).catch(() => {
      notices.push(t('multiplayer.identitySaveFailed'), undefined, 'warning');
    });
  };

  const host = async (overrides?: Partial<MultiplayerHostRequest>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (name.trim() && name.trim() !== mp.selfName)
        await multiplayer.saveIdentity({ playerName: name.trim() });
      await multiplayer.host({
        mode: 'custom',
        address: address.trim(),
        port: port.trim(),
        key: password.trim() || randomKey(),
        ...overrides,
      });
      setView('info');
      notices.push(t('multiplayer.notices.created'), undefined, 'success');
    } catch (failure) {
      failureMessage(failure);
    } finally {
      setPending(false);
    }
  };

  const join = async (request: {
    mode: 'custom' | 'stun';
    address: string;
    port: string;
    stunServer?: string;
    key: string;
  }) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (name.trim() && name.trim() !== mp.selfName)
        await multiplayer.saveIdentity({ playerName: name.trim() });
      await multiplayer.join(request);
      setView('info');
      notices.push(t('multiplayer.notices.joinedRoom'), undefined, 'success');
    } catch (failure) {
      failureMessage(failure);
    } finally {
      setPending(false);
    }
  };

  const leave = async () => {
    if (pending) return;
    setPending(true);
    try {
      await multiplayer.leave();
      close();
    } catch (failure) {
      failureMessage(failure);
    } finally {
      setPending(false);
    }
  };

  // Pasting a host's invite fills the matching join form; STUN invites also switch the view.
  const parsedInvite = useMemo(() => parseInviteText(pasteInvite.trim()), [pasteInvite]);
  const applyParsedInvite = (parsed: ParsedInvite) => {
    setError(null);
    if (parsed.mode === 'stun') {
      setStunJoinAddress(parsed.address);
      if (parsed.stunServer) setStunJoinServer(parsed.stunServer);
      setStunJoinPassword(parsed.key);
      setView('joinStun');
    } else {
      setJoinAddress(parsed.address);
      setJoinPort(parsed.port);
      setJoinPassword(parsed.key);
    }
    setPasteInvite('');
  };

  const kick = async () => {
    if (!kickTarget || pending) return;
    setPending(true);
    try {
      await multiplayer.kick(kickTarget.peerId);
      setKickTarget(null);
      setView('info');
      notices.push(t('multiplayer.kicked'), undefined, 'success');
    } catch (failure) {
      failureMessage(failure);
    } finally {
      setPending(false);
    }
  };

  const identity = (
    <>
      {identityConflict && (
        <div className="mp-error" role="alert">
          <span>{t('errors.revision_conflict')}</span>
          <button
            type="button"
            onClick={() => reduxStore.dispatch(pauseConflict('multiplayer-settings'))}
          >
            {t('errors.conflict_keep_local')}
          </button>
          <button
            type="button"
            onClick={() => {
              mp.discardIdentityConflict();
              void reduxStore.dispatch(
                api.endpoints.getMultiplayerSettings.initiate(undefined, { forceRefetch: true }),
              );
            }}
          >
            {t('errors.conflict_load_remote')}
          </button>
          <button
            type="button"
            onClick={() =>
              void mp
                .retryIdentityConflict()
                .catch(() =>
                  notices.push(t('multiplayer.identitySaveFailed'), undefined, 'warning'),
                )
            }
          >
            {t('errors.conflict_retry')}
          </button>
        </div>
      )}
      <IdentitySection
        name={name}
        selfName={mp.selfName}
        selfColor={mp.selfColor}
        onName={setName}
        onSave={saveIdentity}
      />
    </>
  );

  const title =
    view === 'create'
      ? t('multiplayer.createTitle')
      : view === 'join'
        ? t('multiplayer.joinTitle')
        : view === 'joinStun'
          ? t('multiplayer.joinStunTitle')
          : view === 'stun'
            ? t('multiplayer.stunTitle')
            : view === 'confirm'
              ? status.role === 'host'
                ? t('multiplayer.dissolve')
                : t('multiplayer.leave')
              : view === 'kickConfirm'
                ? t('multiplayer.kickTitle')
                : view === 'info'
                  ? t('multiplayer.infoTitle')
                  : t('multiplayer.configTitle');
  const backTarget: View | null =
    view === 'create' || view === 'join'
      ? 'root'
      : view === 'joinStun'
        ? 'join'
        : view === 'stun'
          ? 'create'
          : null;

  return (
    <>
      <button
        className={`mp-trigger ${status.enabled ? 'connected' : ''} ${
          status.enabled && (status.members?.length || 0) > 0 ? 'live' : ''
        }`}
        ref={triggerButton}
        type="button"
        aria-label={t('multiplayer.trigger')}
        title={t('multiplayer.trigger')}
        onClick={() => {
          setOpen(true);
          setError(null);
          // In a room the panel opens straight onto the room info; root is entry-only.
          setView(status.enabled ? 'info' : 'root');
          void multiplayer.refreshStatus().catch(() => {});
        }}
      >
        <Users size={20} />
      </button>
      {open && (
        <div
          className="mp-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="mp-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('multiplayer.trigger')}
            ref={dialog}
          >
            {/* Anchored top-right exactly like the cast dialog's close button. */}
            <button
              ref={closeButton}
              className="mp-dialog-close"
              type="button"
              aria-label={t('multiplayer.close')}
              title={t('multiplayer.close')}
              onClick={close}
            >
              <X size={18} />
            </button>
            <div className="mp-title-row">
              {backTarget !== null && (
                <button
                  className="mp-back"
                  type="button"
                  aria-label={t('multiplayer.back')}
                  title={t('multiplayer.back')}
                  onClick={() => {
                    setError(null);
                    setView(backTarget);
                  }}
                >
                  <ArrowLeft size={17} />
                </button>
              )}
              <h2>{title}</h2>
            </div>
            {markerConflict && (
              <div className="mp-error" role="alert">
                <span>{t('errors.revision_conflict')}</span>
                <button
                  type="button"
                  onClick={() => reduxStore.dispatch(pauseConflict('marker-preferences'))}
                >
                  {t('errors.conflict_keep_local')}
                </button>
                <button type="button" onClick={() => mp.discardMarkerConflict()}>
                  {t('errors.conflict_load_remote')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void mp
                      .retryMarkerConflict()
                      .catch(() => notices.push(t('errors.preferences_save_failed')))
                  }
                >
                  {t('errors.conflict_retry')}
                </button>
              </div>
            )}
            {pending ? (
              <div className="mp-connecting">
                <span className="spinner" />
                <p>{t('multiplayer.connecting')}</p>
              </div>
            ) : view === 'confirm' && status.enabled ? (
              <ConfirmPanel
                host={status.role === 'host'}
                pending={pending}
                onConfirm={() => void leave()}
                onCancel={() => setView('info')}
              />
            ) : view === 'kickConfirm' && status.enabled && kickTarget ? (
              <KickConfirmPanel
                name={kickTarget.name}
                pending={pending}
                onConfirm={() => void kick()}
                onCancel={() => {
                  if (!pending) {
                    setKickTarget(null);
                    setView('info');
                  }
                }}
              />
            ) : view === 'info' && status.enabled ? (
              <InfoPanel
                status={status}
                showMembersPanel={mp.showMembersPanel}
                onShowMembersPanel={(value) => saveIdentity({ showMembersPanel: value })}
                canKick={status.role === 'host'}
                onKick={(row) => {
                  setKickTarget(row);
                  setView('kickConfirm');
                }}
                onLeave={() => setView('confirm')}
              />
            ) : view === 'stun' ? (
              <StunPanel onHost={(overrides) => void host(overrides)} />
            ) : view === 'root' && !status.enabled ? (
              <>
                <EntryButton
                  kind="primary"
                  label={t('multiplayer.createEntry')}
                  onClick={() => setView('create')}
                />
                <EntryButton
                  kind="secondary"
                  label={t('multiplayer.joinEntry')}
                  onClick={() => setView('join')}
                />
              </>
            ) : view === 'create' ? (
              <>
                {identity}
                <div className="mp-field-row">
                  <div className="mp-field">
                    <label htmlFor="mp-address">{t('multiplayer.localAddress')}</label>
                    <AddressField
                      id="mp-address"
                      value={address}
                      options={interfaces}
                      onChange={setAddress}
                    />
                  </div>
                  <div className="mp-field">
                    <label htmlFor="mp-port">{t('multiplayer.port')}</label>
                    <input
                      id="mp-port"
                      value={port}
                      placeholder={t('multiplayer.portAutoHint')}
                      onChange={(event) => setPort(event.target.value)}
                    />
                  </div>
                </div>
                <label htmlFor="mp-password">{t('multiplayer.password')}</label>
                <PasswordField
                  id="mp-password"
                  value={password}
                  placeholder={t('multiplayer.passwordPlaceholder')}
                  onChange={setPassword}
                  generate
                />
                <button
                  className="mp-primary"
                  type="button"
                  disabled={!address.trim()}
                  onClick={() => void host()}
                >
                  {t('multiplayer.createRoom')}
                </button>
                <div className="mp-divider" role="separator" />
                <button
                  className="mp-secondary"
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView('stun');
                  }}
                >
                  {t('multiplayer.useStun')}
                </button>
              </>
            ) : view === 'join' ? (
              <>
                {identity}
                <div className="mp-field-row">
                  <div className="mp-field">
                    <label htmlFor="mp-join-address">{t('multiplayer.hostAddress')}</label>
                    <input
                      id="mp-join-address"
                      value={joinAddress}
                      onChange={(event) => setJoinAddress(event.target.value)}
                    />
                  </div>
                  <div className="mp-field">
                    <label htmlFor="mp-join-port">{t('multiplayer.port')}</label>
                    <input
                      id="mp-join-port"
                      value={joinPort}
                      placeholder={t('multiplayer.hostPortPlaceholder')}
                      onChange={(event) => setJoinPort(event.target.value)}
                    />
                  </div>
                </div>
                <label htmlFor="mp-join-password">{t('multiplayer.password')}</label>
                <PasswordField
                  id="mp-join-password"
                  value={joinPassword}
                  placeholder={t('multiplayer.joinPasswordPlaceholder')}
                  onChange={setJoinPassword}
                />
                <button
                  className="mp-primary"
                  type="button"
                  disabled={!joinAddress.trim() || !joinPort.trim() || !joinPassword.trim()}
                  onClick={() =>
                    void join({
                      mode: 'custom',
                      address: joinAddress.trim(),
                      port: joinPort.trim(),
                      key: joinPassword.trim(),
                    })
                  }
                >
                  {t('multiplayer.joinRoom')}
                </button>
                <div className="mp-divider" role="separator" />
                <button
                  className="mp-secondary"
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView('joinStun');
                  }}
                >
                  {t('multiplayer.joinWithStun')}
                </button>
                <label htmlFor="mp-paste-invite">{t('multiplayer.pasteInvite')}</label>
                <textarea
                  id="mp-paste-invite"
                  className="mp-paste-invite"
                  rows={4}
                  value={pasteInvite}
                  onChange={(event) => setPasteInvite(event.target.value)}
                  placeholder={t('multiplayer.pasteInvitePlaceholder')}
                />
                <button
                  className="mp-secondary"
                  type="button"
                  disabled={!parsedInvite}
                  onClick={() => parsedInvite && applyParsedInvite(parsedInvite)}
                >
                  {t('multiplayer.pasteParse')}
                </button>
              </>
            ) : view === 'joinStun' ? (
              <>
                {identity}
                <label htmlFor="mp-stun-join-address">{t('multiplayer.hostPublicAddress')}</label>
                <input
                  id="mp-stun-join-address"
                  value={stunJoinAddress}
                  placeholder={t('multiplayer.hostPublicAddressPlaceholder')}
                  onChange={(event) => setStunJoinAddress(event.target.value)}
                />
                <label htmlFor="mp-stun-join-server">{t('multiplayer.stunServer')}</label>
                <input
                  id="mp-stun-join-server"
                  value={stunJoinServer}
                  placeholder={t('multiplayer.stunServerPlaceholder')}
                  onChange={(event) => setStunJoinServer(event.target.value)}
                />
                <label htmlFor="mp-stun-join-password">{t('multiplayer.password')}</label>
                <PasswordField
                  id="mp-stun-join-password"
                  value={stunJoinPassword}
                  placeholder={t('multiplayer.joinPasswordPlaceholder')}
                  onChange={setStunJoinPassword}
                />
                <button
                  className="mp-primary"
                  type="button"
                  disabled={
                    !stunJoinAddress.trim() || !stunJoinServer.trim() || !stunJoinPassword.trim()
                  }
                  onClick={() =>
                    void join({
                      mode: 'stun',
                      address: stunJoinAddress.trim(),
                      port: '',
                      stunServer: stunJoinServer.trim(),
                      key: stunJoinPassword.trim(),
                    })
                  }
                >
                  {t('multiplayer.joinRoom')}
                </button>
              </>
            ) : null}
            {error && view !== 'root' && view !== 'info' && view !== 'confirm' && (
              <p className="mp-error" role="alert">
                {t(`errors.${error.code}` as MultiplayerErrorKey, {
                  port: error.detail,
                })}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function EntryButton({
  kind,
  label,
  onClick,
}: {
  kind: 'primary' | 'secondary';
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`mp-entry mp-${kind}`} type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function IdentitySection({
  name,
  selfName,
  selfColor,
  onName,
  onSave,
}: {
  name: string;
  selfName: string;
  selfColor: string;
  onName: (value: string) => void;
  onSave: (changes: { playerName?: string; playerColor?: string }) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <label htmlFor="mp-name">{t('multiplayer.name')}</label>
      <input
        id="mp-name"
        value={name}
        maxLength={40}
        placeholder={t('multiplayer.namePlaceholder')}
        onChange={(event) => onName(event.target.value)}
        onBlur={() => {
          if (name.trim() && name.trim() !== selfName) onSave({ playerName: name.trim() });
        }}
      />
      <label>{t('multiplayer.colorLabel')}</label>
      <ColorSwatches color={selfColor} onChange={(color) => onSave({ playerColor: color })} />
    </>
  );
}

function ColorSwatches({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const { t } = useLocale();
  const normalized = color.toUpperCase();
  const customActive = !squadPalette.includes(normalized);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="mp-colors" role="radiogroup" aria-label={t('multiplayer.colorLabel')}>
      {squadPalette.map((swatch) => (
        <button
          key={swatch}
          type="button"
          role="radio"
          aria-checked={normalized === swatch}
          aria-label={t('multiplayer.colorSwatch', { color: swatch })}
          title={t('multiplayer.colorSwatch', { color: swatch })}
          className={`mp-color ${normalized === swatch ? 'selected' : ''}`}
          style={{ background: swatch }}
          onClick={() => onChange(swatch)}
        >
          {normalized === swatch && <Check size={12} />}
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={customActive}
        aria-label={t('multiplayer.colorCustom')}
        title={t('multiplayer.colorCustom')}
        className={`mp-color mp-color-custom ${customActive ? 'selected' : ''}`}
        style={customActive ? { background: color } : undefined}
        onClick={() => picker.current?.showPicker?.()}
      >
        {customActive ? <Check size={12} /> : <Plus size={12} />}
      </button>
      {/* Hidden native picker; the custom swatch opens it so "custom" has a visible affordance. */}
      <input
        ref={picker}
        type="color"
        value={color}
        aria-label={t('multiplayer.colorCustom')}
        className="mp-color-input"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function AddressField({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span className="cast-address-field" ref={field}>
        <input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
        {options.length > 0 && (
          <button
            className="cast-address-toggle"
            type="button"
            aria-label={t('multiplayer.pickAddress')}
            title={t('multiplayer.pickAddress')}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </span>
      {open && (
        <AppPopover
          open={open}
          reference={field}
          placement="bottom-start"
          className="cast-address-popover"
          matchReferenceWidth
        >
          <div
            className="cast-address-list"
            role="listbox"
            aria-label={t('multiplayer.pickAddress')}
          >
            {options.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                className={option === value ? 'selected' : ''}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </AppPopover>
      )}
    </>
  );
}

function PasswordField({
  id,
  value,
  placeholder,
  onChange,
  generate = false,
}: {
  id: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Only the host form generates a password; a join field holds the host's password. */
  generate?: boolean;
}) {
  const { t } = useLocale();
  return (
    <span className="mp-password-field">
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="mp-input-button"
          aria-label={t('multiplayer.clearPassword')}
          title={t('multiplayer.clearPassword')}
          onClick={() => onChange('')}
        >
          <X size={14} />
        </button>
      ) : generate ? (
        <button
          type="button"
          className="mp-input-button"
          aria-label={t('multiplayer.randomPassword')}
          title={t('multiplayer.randomPassword')}
          onClick={() => onChange(randomKey())}
        >
          <Dices size={14} />
        </button>
      ) : null}
    </span>
  );
}

type InviteField = { kind: 'mode' | 'host' | 'stun' | 'password'; value: string };

function InfoPanel({
  status,
  showMembersPanel,
  onShowMembersPanel,
  canKick,
  onKick,
  onLeave,
}: {
  status: MultiplayerStatus;
  showMembersPanel: boolean;
  onShowMembersPanel: (value: boolean) => void;
  canKick: boolean;
  onKick: (row: MemberRow) => void;
  onLeave: () => void;
}) {
  const { t, locale } = useLocale();
  const [copiedKey, setCopiedKey] = useState('');
  const copyLocked = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const host = status.role === 'host';

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyText = async (key: string, text: string) => {
    if (copyLocked.current) return;
    copyLocked.current = true;
    setCopiedKey(key);
    try {
      await navigator.clipboard.writeText(text);
      notices.push(t('multiplayer.copied'), undefined, 'success');
    } catch {
      notices.push(t('multiplayer.copyFailed'));
    } finally {
      copyTimer.current = window.setTimeout(() => {
        copyLocked.current = false;
        setCopiedKey('');
      }, CopyFeedbackMs);
    }
  };

  const fields = useMemo<InviteField[]>(() => {
    if (!status.invite) return [];
    const fields: InviteField[] = [
      { kind: 'mode', value: status.invite.mode },
      { kind: 'host', value: status.invite.host },
    ];
    if (status.invite.stunServer) fields.push({ kind: 'stun', value: status.invite.stunServer });
    fields.push({ kind: 'password', value: status.invite.key });
    return fields;
  }, [status.invite]);
  const fieldLabel = (field: InviteField) =>
    t(
      field.kind === 'mode'
        ? 'multiplayer.invite.mode'
        : field.kind === 'host'
          ? 'multiplayer.invite.host'
          : field.kind === 'stun'
            ? 'multiplayer.invite.stun'
            : 'multiplayer.invite.password',
    );
  const fieldValue = (field: InviteField) =>
    field.kind === 'mode'
      ? field.value === 'stun'
        ? t('multiplayer.stunTitle')
        : t('multiplayer.lanMode')
      : field.value;

  const localizedShareText = () => (status.invite ? formatInviteText(status.invite, locale) : '');

  const rows = memberRows(status);
  return (
    <>
      {host && (
        <div className="mp-invite">
          <div className="mp-invite-head">
            <span>{t('multiplayer.inviteTitle')}</span>
            <button
              type="button"
              className="mp-copy-inline mp-copy-all"
              disabled={!status.invite || copiedKey === 'all'}
              onClick={() => void copyText('all', localizedShareText())}
            >
              {copiedKey === 'all' ? <Check size={13} /> : <Copy size={13} />}
              {t('multiplayer.copyAll')}
            </button>
          </div>
          {fields.map((field) => (
            <div className="mp-invite-row" key={field.kind}>
              <span className="mp-invite-label">{fieldLabel(field)}</span>
              <span className="mp-invite-value" title={field.value}>
                {fieldValue(field)}
              </span>
              {field.kind !== 'mode' && (
                <button
                  type="button"
                  className="mp-copy-inline"
                  aria-label={t('multiplayer.copyValue', { field: fieldLabel(field) })}
                  title={t('multiplayer.copyValue', { field: fieldLabel(field) })}
                  disabled={copiedKey === field.kind}
                  onClick={() => void copyText(field.kind, field.value)}
                >
                  {copiedKey === field.kind ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}
            </div>
          ))}
          {!fields.length && status.invite && (
            <pre className="mp-share">{localizedShareText()}</pre>
          )}
        </div>
      )}
      <label className="mp-check-row">
        <input
          type="checkbox"
          checked={showMembersPanel}
          onChange={(event) => onShowMembersPanel(event.target.checked)}
        />
        <span>{t('multiplayer.showMembersPanel')}</span>
      </label>
      <div className="mp-members-section">
        <span className="mp-members-title">{t('multiplayer.membersTitle')}</span>
        <MemberList rows={rows} canKick={canKick} onKick={onKick} />
      </div>
      <div className="mp-divider" role="separator" />
      <div className="mp-danger-zone">
        <button className="mp-danger" type="button" onClick={onLeave}>
          {host ? t('multiplayer.dissolve') : t('multiplayer.leave')}
        </button>
      </div>
    </>
  );
}

function ConfirmPanel({
  host,
  pending,
  onConfirm,
  onCancel,
}: {
  host: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="mp-confirm-panel">
      <p className="mp-room-note" role="alert">
        {host ? t('multiplayer.confirmDissolve') : t('multiplayer.confirmLeave')}
      </p>
      <div className="mp-actions">
        <button className="mp-danger" type="button" disabled={pending} onClick={onConfirm}>
          {t('multiplayer.confirmYes')}
        </button>
        <button type="button" disabled={pending} onClick={onCancel}>
          {t('multiplayer.cancel')}
        </button>
      </div>
    </div>
  );
}

function KickConfirmPanel({
  name,
  pending,
  onConfirm,
  onCancel,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="mp-confirm-panel">
      <p className="mp-room-note" role="alert">
        {t('multiplayer.confirmKick', { name })}
      </p>
      <div className="mp-actions">
        <button className="mp-danger" type="button" disabled={pending} onClick={onConfirm}>
          {t('multiplayer.kick')}
        </button>
        <button type="button" disabled={pending} onClick={onCancel}>
          {t('multiplayer.cancel')}
        </button>
      </div>
    </div>
  );
}

type StunEntry = { server: string; probe?: Probe };

function StunPanel({ onHost }: { onHost: (overrides: Partial<MultiplayerHostRequest>) => void }) {
  const { t } = useLocale();
  const { data: stunList, error: stunError } = useGetStunServersQuery();
  const [probeStun] = useProbeStunServersMutation();
  const [refreshStun] = useRefreshStunServersMutation();
  const [checkNatMutation] = useCheckNatMutation();
  const [servers, setServers] = useState<StunEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [nat, setNat] = useState<'cone' | 'symmetric' | 'unknown' | null>(null);
  const [natPending, setNatPending] = useState(false);
  const [sort, setSort] = useState<'az' | 'latency'>('az');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [probingAll, setProbingAll] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const selectedRow = useRef<HTMLLIElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (stunError) reportThrottledFailure('multiplayer_stun_servers_failed', String(stunError));
    if (!stunList) return;
    setServers((current) => {
      const probes = new Map(current.map((entry) => [entry.server, entry.probe]));
      return stunList.servers.map((server) => ({ server, probe: probes.get(server) }));
    });
  }, [stunList, stunError]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [query, searchOpen]);

  const probe = async (targets: string[]) => {
    setServers((current) =>
      current.map((entry) =>
        targets.includes(entry.server) ? { ...entry, probe: { state: 'probing' } } : entry,
      ),
    );
    // Progressive chunks keep the UI filling in without one huge burst on the network.
    for (let index = 0; index < targets.length; index += ProbeChunk) {
      if (!alive.current) return;
      const chunk = targets.slice(index, index + ProbeChunk);
      try {
        const { results } = await probeStun({ servers: chunk }).unwrap();
        setServers((current) =>
          current.map((entry) => {
            const result = results.find((r) => r.server === entry.server);
            return result
              ? { server: entry.server, probe: { state: 'done', latencyMs: result.latencyMs } }
              : entry;
          }),
        );
      } catch (error) {
        reportThrottledFailure('multiplayer_stun_probe_failed', String(error));
        setServers((current) =>
          current.map((entry) =>
            chunk.includes(entry.server)
              ? { server: entry.server, probe: { state: 'done' } }
              : entry,
          ),
        );
      }
    }
  };

  const probeAll = async () => {
    if (probingAll) return;
    setProbingAll(true);
    try {
      await probe(servers.map((entry) => entry.server));
    } finally {
      setProbingAll(false);
    }
  };

  const probeOne = (server: string) => {
    if (servers.find((entry) => entry.server === server)?.probe?.state === 'probing') return;
    void probe([server]);
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const value = await refreshStun().unwrap();
      const fresh = value.servers || [];
      setServers((current) => {
        const probed = new Map(
          current
            .filter((entry) => entry.probe?.state === 'done')
            .map((entry) => [entry.server, entry.probe]),
        );
        return fresh.map((server) => ({ server, probe: probed.get(server) }));
      });
      setSelected((current) => (fresh.includes(current) ? current : ''));
    } catch {
      notices.push(t('multiplayer.stunDownloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const natCheck = async () => {
    if (natPending) return;
    setNatPending(true);
    try {
      const value = await checkNatMutation().unwrap();
      setNat(value.kind);
    } catch (error) {
      reportThrottledFailure('multiplayer_nat_check_failed', String(error));
      setNat('unknown');
    } finally {
      setNatPending(false);
    }
  };

  const visible = useMemo(() => {
    const filtered = debounced
      ? servers.filter((entry) => entry.server.toLowerCase().includes(debounced))
      : servers;
    const latency = (entry: StunEntry) =>
      entry.probe?.state === 'done' && entry.probe.latencyMs !== undefined
        ? entry.probe.latencyMs
        : null;
    if (sort === 'latency') {
      return [...filtered].sort((a, b) => {
        const la = latency(a);
        const lb = latency(b);
        if (la === null && lb === null) return a.server.localeCompare(b.server);
        if (la === null) return 1;
        if (lb === null) return -1;
        return la - lb;
      });
    }
    return [...filtered].sort((a, b) => a.server.localeCompare(b.server));
  }, [servers, sort, debounced]);

  const latencyLabel = (entry: StunEntry) => {
    if (entry.probe?.state === 'probing') return '…';
    if (entry.probe?.state === 'done') {
      if (entry.probe.latencyMs === undefined || entry.probe.latencyMs >= 997)
        return t('multiplayer.stunTimeout');
      return `${entry.probe.latencyMs}ms`;
    }
    return '—';
  };

  const latencyClass = (entry: StunEntry) => {
    if (entry.probe?.state === 'probing') return 'probing';
    if (entry.probe?.state === 'done') {
      if (entry.probe.latencyMs === undefined || entry.probe.latencyMs >= 997) return 'timeout';
      if (entry.probe.latencyMs < 100) return 'good';
      if (entry.probe.latencyMs <= 299) return 'fair';
      return 'bad';
    }
    return '';
  };

  return (
    <>
      <div className="mp-nat">
        <button type="button" disabled={natPending} onClick={() => void natCheck()}>
          {natPending ? t('multiplayer.natChecking') : t('multiplayer.natCheck')}
        </button>
        {nat === 'cone' && <p className="mp-nat-result">{t('multiplayer.natCone')}</p>}
        {nat === 'symmetric' && (
          <p className="mp-nat-result bad">{t('multiplayer.natSymmetric')}</p>
        )}
        {nat === 'unknown' && <p className="mp-nat-result bad">{t('multiplayer.natUnknown')}</p>}
      </div>
      <div className="mp-toolbar">
        <button
          type="button"
          title={t('multiplayer.currentNode')}
          aria-label={t('multiplayer.currentNode')}
          disabled={!selected}
          onClick={() =>
            selectedRow.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        >
          <Crosshair size={16} />
        </button>
        <button
          type="button"
          title={t('multiplayer.probeAll')}
          aria-label={t('multiplayer.probeAll')}
          disabled={probingAll || !servers.length}
          onClick={() => void probeAll()}
        >
          <Gauge size={16} />
        </button>
        <button
          type="button"
          title={t('multiplayer.sort')}
          aria-label={t('multiplayer.sort')}
          onClick={() => setSort((current) => (current === 'az' ? 'latency' : 'az'))}
        >
          <ArrowUpDown size={16} />
          <small>{sort === 'az' ? 'A-Z' : t('multiplayer.sortLatency')}</small>
        </button>
        <button
          type="button"
          title={t('multiplayer.search')}
          aria-label={t('multiplayer.search')}
          aria-expanded={searchOpen}
          className={searchOpen ? 'active' : ''}
          onClick={() => {
            setSearchOpen((current) => !current);
            setQuery('');
            setDebounced('');
          }}
        >
          <Search size={16} />
        </button>
        <button
          type="button"
          title={t('multiplayer.download')}
          aria-label={t('multiplayer.download')}
          disabled={downloading}
          onClick={() => void download()}
        >
          <Download size={16} className={downloading ? 'spin' : ''} />
        </button>
      </div>
      {searchOpen && (
        <input
          className="mp-search"
          value={query}
          placeholder={t('multiplayer.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      )}
      <ul className="mp-stun-list">
        {visible.map((entry) => (
          <li
            key={entry.server}
            ref={entry.server === selected ? selectedRow : undefined}
            className={entry.server === selected ? 'selected' : ''}
          >
            <button type="button" onClick={() => setSelected(entry.server)} title={entry.server}>
              <span className="mp-stun-address">{entry.server}</span>
            </button>
            <button
              type="button"
              className={`mp-stun-latency ${latencyClass(entry)}`}
              title={t('multiplayer.probeOne')}
              onClick={() => probeOne(entry.server)}
            >
              {latencyLabel(entry)}
            </button>
          </li>
        ))}
        {!visible.length && <li className="mp-stun-empty">{t('multiplayer.stunEmpty')}</li>}
      </ul>
      <p className="mp-selected-info">
        {selected
          ? t('multiplayer.selectedNode', { server: selected })
          : t('multiplayer.noSelectedNode')}
      </p>
      <button
        className="mp-primary"
        type="button"
        disabled={!selected}
        onClick={() =>
          onHost({
            mode: 'stun',
            stunServer: selected,
            address: '',
          })
        }
      >
        {t('multiplayer.useServerCreate')}
      </button>
    </>
  );
}
