import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { messages, type Locale } from './messages';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ initialLocale = 'en', children }: { initialLocale?: Locale; children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key) => {
      const current = messages[locale] as Record<string, string>;
      const fallback = messages.en as Record<string, string>;
      return current[key] ?? fallback[key] ?? key;
    }
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
