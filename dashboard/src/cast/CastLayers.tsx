import type { RefObject } from 'react';
import type { Annotation, MapData, MapPreference } from '../../../contracts/ts/ipc.gen';
import { AppPopover } from '../components/AppPopover';
import { LayerPanel } from '../pages/map/LayerPanel';
import { useLocale } from '../hooks/useLocale';

export default function CastLayers({
  reference,
  boundaryRef,
  portrait,
  data,
  items,
  preference,
  onPreference,
  onClose,
}: {
  reference: RefObject<HTMLButtonElement | null>;
  boundaryRef: RefObject<HTMLElement | null>;
  portrait: boolean;
  data: MapData;
  items: Annotation[];
  preference: MapPreference;
  onPreference: (changes: Partial<MapPreference>) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <AppPopover
      open
      reference={reference}
      placement={portrait ? 'bottom-start' : 'right-start'}
      boundaryRef={boundaryRef}
      onDismiss={onClose}
    >
      <div
        id="cast-layer-panel"
        className="layer-panel floating cast-layer-panel"
        role="dialog"
        aria-modal="false"
        aria-label={t('map.layers.title')}
      >
        <LayerPanel
          data={data}
          items={items}
          preference={preference}
          readOnly
          onPreference={onPreference}
          onClose={onClose}
        />
      </div>
    </AppPopover>
  );
}
