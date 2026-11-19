import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'pt-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** Chakra's `_dark` condition keys off a `dark` class on <html>. */
function apply(mode: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(mode);
  root.style.colorScheme = mode;
}

const Ctx = createContext<{ pref: ThemePref; mode: 'light' | 'dark'; setPref: (p: ThemePref) => void }>({
  pref: 'system',
  mode: 'dark',
  setPref: () => {},
});

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(() => media().matches);
  const mode = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  useEffect(() => {
    const m = media();
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* private mode — the choice just isn't remembered */
    }
  }, [mode, pref]);

  return <Ctx.Provider value={{ pref, mode, setPref }}>{children}</Ctx.Provider>;
}

export const useColorMode = () => useContext(Ctx);
