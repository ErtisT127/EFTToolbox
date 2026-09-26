import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Placement,
} from '@floating-ui/dom';
import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function AppPopover({
  open,
  reference,
  children,
  placement,
  className = '',
  boundaryRef,
  matchReferenceWidth = false,
}: {
  open: boolean;
  reference: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement: Placement;
  className?: string;
  boundaryRef?: RefObject<HTMLElement | null>;
  matchReferenceWidth?: boolean;
}) {
  const floating = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    setReady(false);
    if (!open || !reference.current || !floating.current) return;
    const boundary = boundaryRef?.current || document.documentElement;
    let cancelled = false;
    const update = () => {
      if (!reference.current || !floating.current) return;
      void computePosition(reference.current, floating.current, {
        placement,
        middleware: [
          offset(12),
          flip({ fallbackAxisSideDirection: 'start', boundary }),
          shift({ padding: 8, boundary }),
          size({
            padding: 8,
            boundary,
            apply({ availableHeight, elements, rects }) {
              elements.floating.style.setProperty(
                '--popover-available-height',
                `${availableHeight}px`,
              );
              if (matchReferenceWidth) {
                elements.floating.style.width = `${rects.reference.width}px`;
              }
            },
          }),
        ],
      }).then(({ x, y, placement: resolvedPlacement }) => {
        if (cancelled || !floating.current) return;
        floating.current.style.left = `${x}px`;
        floating.current.style.top = `${y}px`;
        floating.current.dataset.placement = resolvedPlacement;
        setReady(true);
      });
    };
    update();
    const cleanup = autoUpdate(reference.current, floating.current, update);
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [boundaryRef, matchReferenceWidth, open, placement, reference]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={floating}
      className={`app-popover ${className}`.trim()}
      data-ready={ready || undefined}
    >
      {children}
    </div>,
    document.body,
  );
}
