import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './stores/store';
import './i18n';
import { AppShell as App } from './app/AppShell';
import { isHosted } from './lib/hostWindow';
import 'leaflet/dist/leaflet.css';
import './styles/fonts.css';
import './styles/app.css';
import './styles/cast.css';
import './styles/multiplayer.css';
import './styles/map-display.gen.css';
import './styles/map.css';
import './styles/calibrator.css';
import './styles/items.css';

if (import.meta.env.PROD && isHosted()) {
  document.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          `textarea,
          [contenteditable]:not([contenteditable="false"]),
          input:not([type]),
          input[type="text" i],
          input[type="search" i],
          input[type="password" i],
          input[type="email" i],
          input[type="url" i],
          input[type="tel" i],
          input[type="number" i]`,
        )
      )
        return;
      event.preventDefault();
    },
    true,
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
