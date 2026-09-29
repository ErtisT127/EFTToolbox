import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { messages, defaultLocale } from '../../../contracts/ts/messages.gen';

void i18n.use(initReactI18next).init({
  resources: messages,
  lng: defaultLocale,
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
});

export default i18n;
