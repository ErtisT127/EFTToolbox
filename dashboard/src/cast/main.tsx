import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../i18n';
import 'leaflet/dist/leaflet.css';
import '../styles/fonts.css';
import '../styles/app.css';
import '../styles/map-display.gen.css';
import '../styles/map.css';
import '../styles/cast.css';
import { CastApp } from './CastApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CastApp />
  </StrictMode>,
);
