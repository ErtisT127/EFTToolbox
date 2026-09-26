import { Crown, UserRoundX } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';
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

// A guest measures its RTT to the host, so both sides of that connection show the same value;
// the host's own row is 0ms because it has no network hop to itself.
export function memberRows(status: MultiplayerStatus): MemberRow[] {
  if (!status.self) return [];
  const ownLatency = status.self.role === 'host' ? 0 : status.self.latencyMs;
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
                <Crown size={12} aria-hidden="true" />
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
            <span
              className={`mp-member-latency ${latencyClass(
                row.state === 'unstable' || row.state === 'lost' ? 997 : row.latencyMs,
              )}`}
            >
              {latencyLabel(
                row.state === 'unstable' || row.state === 'lost' ? 997 : row.latencyMs,
                t,
              )}
            </span>
          </li>
        ) : (
          <li key={`empty-${index}`} className="mp-member-empty" aria-hidden="true" />
        ),
      )}
    </ul>
  );
}

function latencyClass(latencyMs?: number) {
  if (latencyMs === undefined || latencyMs >= 997) return 'timeout';
  if (latencyMs < 100) return 'good';
  if (latencyMs <= 299) return 'fair';
  return 'bad';
}

function latencyLabel(latencyMs: number | undefined, t: (key: string) => string) {
  return latencyMs === undefined || latencyMs >= 997 ? t('multiplayer.timeout') : `${latencyMs}ms`;
}
