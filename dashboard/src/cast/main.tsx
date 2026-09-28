import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from '../i18n';
import 'leaflet/dist/leaflet.css';
import '../styles/fonts.css';
import '../styles/app.css';
import '../styles/map-display.gen.css';
import '../styles/map.css';
import '../styles/cast.css';
import { CastApp, castLocale } from './CastApp';

// Same language the cast page's map requests use, so its copy and its data agree.
void i18n.changeLanguage(castLocale());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CastApp />
  </StrictMode>,
);
