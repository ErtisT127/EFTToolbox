import { computePosition, flip, offset, shift, autoUpdate, type Placement } from '@floating-ui/dom';
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

type TooltipProps = {
  content: string;
  children?: ReactNode;
  boundaryRef?: RefObject<HTMLElement | null>;
  className?: string;
  placement?: Placement;
};

function FloatingTooltip({
  content,
  children,
  boundaryRef,
  className = '',
  placement,
  mark,
}: TooltipProps & { mark: boolean }) {
  const reference = useRef<HTMLElement>(null);
  const floating = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !reference.current || !floating.current) return;
    const boundary = boundaryRef?.current || document.documentElement;
    let cancelled = false;
    const update = () => {
      if (!reference.current || !floating.current) return;
      void computePosition(reference.current, floating.current, {
        placement: placement || (mark ? 'right-start' : 'top-start'),
        middleware: [
          offset(6),
          flip({ fallbackAxisSideDirection: 'start', boundary }),
          shift({ padding: 8, boundary }),
        ],
      }).then(({ x, y, placement }) => {
        if (cancelled || !floating.current) return;
        floating.current.style.left = `${x}px`;
        floating.current.style.top = `${y}px`;
        floating.current.dataset.placement = placement;
      });
    };
    update();
    const cleanup = autoUpdate(reference.current, floating.current, update);
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [boundaryRef, mark, open, placement]);

  const tooltip = (
    <span
      ref={floating}
      id={id}
      className={`hint-tip ${className}`.trim()}
      role="tooltip"
      aria-hidden={!open}
      data-open={open || undefined}
    >
      {content}
    </span>
  );
  const portal = typeof document === 'undefined' ? null : createPortal(tooltip, document.body);

  return (
    <span
      className={`${mark ? 'hint-tooltip' : 'app-tooltip'} ${className}`.trim()}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {mark ? (
        <>
          {children}
          <button
            ref={(node) => {
              reference.current = node;
            }}
            type="button"
            className="hint-mark"
            aria-label={content}
            aria-describedby={open ? id : undefined}
          >
            ?
          </button>
        </>
      ) : (
        <span
          ref={(node) => {
            reference.current = node;
          }}
          className="app-tooltip-reference"
          tabIndex={0}
          aria-describedby={open ? id : undefined}
        >
          {children}
        </span>
      )}
      {portal}
    </span>
  );
}

export function HintTooltip(props: TooltipProps) {
  return <FloatingTooltip {...props} mark />;
}

export function AppTooltip(props: TooltipProps) {
  return <FloatingTooltip {...props} mark={false} />;
}
