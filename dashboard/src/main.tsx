import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './stores/store';
import './i18n';
import { AppShell as App } from './app/AppShell';
import 'leaflet/dist/leaflet.css';
import './styles/fonts.css';
import './styles/app.css';
import './styles/cast.css';
import './styles/multiplayer.css';
import './styles/map-display.gen.css';
import './styles/map.css';
import './styles/calibrator.css';
import './styles/items.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
