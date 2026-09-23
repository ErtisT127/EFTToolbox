import type { LucideIcon } from 'lucide-react';
import { Redo2, Undo2 } from 'lucide-react';

export type ToolbarTool = {
  id: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

type HistoryAction = {
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
};

export function ToolToolbar({
  tools,
  ariaLabel,
  undo,
  redo,
  className,
}: {
  tools: ToolbarTool[];
  ariaLabel: string;
  undo: HistoryAction;
  redo: HistoryAction;
  className?: string;
}) {
  return (
    <div
      className={`toolbar floating${className ? ` ${className}` : ''}`}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {tools.map(({ id, icon: Icon, label, active, pressed, expanded, disabled, onClick }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={pressed ?? active ?? false}
          aria-expanded={expanded}
          className={active ? 'active' : ''}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon size={20} strokeWidth={1.5} />
        </button>
      ))}
      <div className="tool-divider" />
      <button
        type="button"
        aria-label={undo.label}
        title={undo.title}
        disabled={undo.disabled}
        onClick={undo.onClick}
      >
        <Undo2 size={19} />
      </button>
      <button
        type="button"
        aria-label={redo.label}
        title={redo.title}
        disabled={redo.disabled}
        onClick={redo.onClick}
      >
        <Redo2 size={19} />
      </button>
    </div>
  );
}
