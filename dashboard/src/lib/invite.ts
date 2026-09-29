import type { MultiplayerInvite } from '../../../contracts/ts/ipc.gen';
import { messages, type Locale } from '../../../contracts/ts/messages.gen.ts';

const multiplayerMessages = (locale: Locale) => messages[locale].translation.multiplayer;

// The invite copy is assembled on the Dashboard from the structured backend invite, using the
// same generated message bundle the panel renders, so copied text matches the active language.
export function formatInviteText(invite: MultiplayerInvite, locale: Locale): string {
  const mp = multiplayerMessages(locale);
  return [
    mp.shareHeader,
    `${mp.invite.mode}: ${invite.mode === 'stun' ? mp.stunTitle : mp.lanMode}`,
    `${mp.invite.host}: ${invite.host}`,
    ...(invite.stunServer ? [`${mp.invite.stun}: ${invite.stunServer}`] : []),
    `${mp.invite.password}: ${invite.key}`,
  ].join('\n');
}

export type ParsedInvite = {
  mode: 'custom' | 'stun';
  // Custom joins keep address and port separate; STUN joins take the host's public
  // "address:port" as one string, mirroring the join request shapes of both flows.
  address: string;
  port: string;
  stunServer?: string;
  key: string;
};

// Parses invite text produced in any UI language: labels from every locale bundle are matched,
// so a Chinese invite pastes correctly into an English session and vice versa. Returns null
// unless the host splits into address:port and a key is present.
export function parseInviteText(text: string): ParsedInvite | null {
  const locales = Object.keys(messages) as Locale[];
  const fieldByLabel = new Map<string, 'mode' | 'host' | 'stun' | 'password'>();
  const modeByValue = new Map<string, 'custom' | 'stun'>();
  for (const locale of locales) {
    const mp = multiplayerMessages(locale);
    fieldByLabel.set(mp.invite.mode, 'mode');
    fieldByLabel.set(mp.invite.host, 'host');
    fieldByLabel.set(mp.invite.stun, 'stun');
    fieldByLabel.set(mp.invite.password, 'password');
    modeByValue.set(mp.stunTitle, 'stun');
    modeByValue.set(mp.lanMode, 'custom');
  }

  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const field = fieldByLabel.get(line.slice(0, separator).trim());
    if (field) values.set(field, line.slice(separator + 1).trim());
  }

  const host = values.get('host') ?? '';
  const key = values.get('password') ?? '';
  if (!host || !key) return null;

  let address: string;
  let port: string;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0 || host[end + 1] !== ':') return null;
    address = host.slice(1, end);
    port = host.slice(end + 2);
  } else {
    const separator = host.lastIndexOf(':');
    if (separator <= 0) return null;
    address = host.slice(0, separator);
    port = host.slice(separator + 1);
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;

  const stunServer = values.get('stun');
  // An explicit mode line wins; otherwise the presence of a STUN server decides the flow.
  const mode =
    (values.get('mode') ? modeByValue.get(values.get('mode') ?? '') : undefined) ??
    (stunServer ? 'stun' : 'custom');

  return {
    mode,
    address: mode === 'stun' ? host : address,
    port: mode === 'stun' ? '' : port,
    ...(stunServer ? { stunServer } : {}),
    key,
  };
}
