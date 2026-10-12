/** Light and dark themes: follow the system, or the reader's explicit choice. */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'jx-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

let preference = readPreference();

function resolve(): Theme {
  return preference === 'dark' || (preference === 'system' && systemDark.matches) ? 'dark' : 'light';
}

function apply(): void {
  document.documentElement.dataset.theme = resolve();
  for (const listener of listeners) listener();
}

systemDark.addEventListener('change', apply);

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage is unavailable (private mode): the choice lasts for this visit.
  }
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, resolve);
}
