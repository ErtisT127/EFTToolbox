import type { MultiplayerInvite } from '../../../contracts/ts/ipc.gen';
import { messages, type Locale } from '../../../contracts/ts/messages.gen.ts';

const multiplayerMessages = (locale: Locale) => messages[locale].translation.multiplayer;

// The invite copy is assembled on the Dashboard from the structured backend invite, using the
// same generated message bundle the panel renders, so copied text matches the active language.
// The host copies this text out of band; the joiner fills the join fields in by hand.
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
