import { Crown, UserRoundX } from 'lucide-react';
import { useLocale, type Translate } from '../hooks/useLocale';
import type { MultiplayerStatus } from '../../../contracts/ts/ipc.gen';

export type MemberRow = {
  peerId: string;
  name: string;
  color: string;
  role?: string;
  latencyMs?: number;
  state: string;
  self?: boolean;
};

// A guest measures its RTT to the host, so both sides of that connection show the same value.
export function memberRows(status: MultiplayerStatus): MemberRow[] {
  if (!status.self) return [];
  const ownLatency = status.self.latencyMs;
  const self: MemberRow = { ...status.self, self: true, latencyMs: ownLatency };
  const members = (status.members || []).map((member) =>
    member.role === 'host' && status.role === 'guest' && ownLatency !== undefined
      ? { ...member, latencyMs: ownLatency }
      : { ...member },
  );
  return [self, ...members];
}

// Shared by the map-page preview and room info so both surfaces render the same roster.
export function MemberList({
  rows,
  slots,
  canKick = false,
  onKick,
}: {
  rows: MemberRow[];
  slots?: number;
  canKick?: boolean;
  onKick?: (row: MemberRow) => void;
}) {
  const { t } = useLocale();
  const visibleRows = slots ? Array.from({ length: slots }, (_, index) => rows[index]) : rows;
  return (
    <ul className="mp-member-list">
      {visibleRows.map((row, index) =>
        row ? (
          <li key={row.peerId}>
            <i className="owner-dot" style={{ background: row.color }} aria-hidden="true" />
            <span className="mp-member-name" title={row.name}>
              {row.name}
            </span>
            {row.role === 'host' ? (
              <span
                className="mp-member-host"
                role="img"
                aria-label={t('multiplayer.hostBadge')}
                title={t('multiplayer.hostBadge')}
              >
                <Crown size={13} aria-hidden="true" />
              </span>
            ) : (
              canKick && (
                <button
                  type="button"
                  className="mp-member-kick"
                  aria-label={t('multiplayer.kickMember', { name: row.name })}
                  title={t('multiplayer.kickMember', { name: row.name })}
                  onClick={() => onKick?.(row)}
                >
                  <UserRoundX size={13} aria-hidden="true" />
                </button>
              )
            )}
            <span className={`mp-member-latency ${latencyClass(displayLatency(row), row.self)}`}>
              {latencyLabel(displayLatency(row), t, row.self)}
            </span>
          </li>
        ) : (
          <li key={`empty-${index}`} className="mp-member-empty" aria-hidden="true" />
        ),
      )}
    </ul>
  );
}

function displayLatency(row: MemberRow) {
  if (row.self && row.latencyMs === undefined) return undefined;
  return row.state === 'unstable' || row.state === 'lost' ? 997 : row.latencyMs;
}

function latencyClass(latencyMs: number | undefined, self?: boolean) {
  if (latencyMs === undefined && self) return 'neutral';
  if (latencyMs === undefined || latencyMs >= 997) return 'timeout';
  if (latencyMs < 100) return 'good';
  if (latencyMs <= 299) return 'fair';
  return 'bad';
}

function latencyLabel(latencyMs: number | undefined, t: Translate, self?: boolean) {
  if (latencyMs === undefined && self) return '—';
  return latencyMs === undefined || latencyMs >= 997 ? t('multiplayer.timeout') : `${latencyMs}ms`;
}
