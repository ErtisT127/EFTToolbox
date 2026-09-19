import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import { AppShell as App } from './app/AppShell';
import 'leaflet/dist/leaflet.css';
import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
