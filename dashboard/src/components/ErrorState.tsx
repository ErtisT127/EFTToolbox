import type { LucideIcon } from 'lucide-react';

type ErrorStateAction = {
  label: string;
  onClick: () => void;
  danger?: boolean;
};

export function ErrorState({
  icon: Icon,
  tone,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  tone: 'network' | 'data';
  title: string;
  description: string;
  actions: ErrorStateAction[];
}) {
  return (
    <section className="error-state" role="alert">
      <Icon className={`error-state-icon error-state-icon--${tone}`} size={44} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="error-state-actions">
        {actions.map(({ label, onClick, danger }) => (
          <button
            key={label}
            type="button"
            className={danger ? 'danger-button' : undefined}
            onClick={onClick}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
