import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../stores/store';
import i18n from '../i18n';
import 'leaflet/dist/leaflet.css';
import '../styles/fonts.css';
import '../styles/app.css';
import '../styles/map-display.gen.css';
import '../styles/map.css';
import '../styles/cast.css';
import { CastApp, castLocale } from './CastApp';

// The cast mirrors the dashboard map page, but it runs on another device: the LAN handler keeps
// user settings on the host, so the language the app is set to arrives with the mobile snapshot
// (CastApp's applyLanguage) and the map data reloads into it. The phone browser language is only
// what the phone shows until that snapshot lands.
void i18n.changeLanguage(castLocale()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <CastApp />
      </Provider>
    </StrictMode>,
  );
});
