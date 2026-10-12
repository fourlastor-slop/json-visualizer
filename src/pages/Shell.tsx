/** The frame around every page: the top bar with breadcrumbs, and the page body. */
import type { ReactNode } from 'react';
import { hrefFor } from '../lib/router';
import { type ThemePreference, setThemePreference, useThemePreference } from '../lib/theme';
import { Icon, type IconName } from '../ui/Icon';

export interface Crumb {
  label: ReactNode;
  href?: string;
}

const THEMES: Record<ThemePreference, { icon: IconName; label: string; next: ThemePreference }> = {
  system: { icon: 'monitor', label: 'Theme: follows your system', next: 'light' },
  light: { icon: 'sun', label: 'Theme: light', next: 'dark' },
  dark: { icon: 'moon', label: 'Theme: dark', next: 'system' },
};

interface Props {
  crumbs?: Crumb[];
  /** Controls shown at the right of the top bar, before the global ones. */
  actions?: ReactNode;
  /** Lets the body fill the window instead of scrolling in a centered column. */
  fill?: boolean;
  children: ReactNode;
}

export function Shell({ crumbs = [], actions, fill = false, children }: Props) {
  const theme = THEMES[useThemePreference()];
  return (
    <div className={fill ? 'shell is-fill' : 'shell'}>
      <header className="topbar">
        <a className="brand" href={hrefFor({ page: 'projects' })} aria-label="JSON Explorer: all projects">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--text)" />
            <path d="M7 22l6-8 5 4 7-10" fill="none" stroke="var(--surface)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>JSON Explorer</span>
        </a>
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            <span key={i} className="crumb">
              <Icon name="chevronRight" size={13} />
              {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current="page">{typeof crumb.label === 'string' ? <span className="crumb-text">{crumb.label}</span> : crumb.label}</span>}
            </span>
          ))}
        </nav>
        <div className="topbar-actions">
          {actions}
          <a className="button is-quiet" href={hrefFor({ page: 'templates' })}>
            <Icon name="layers" />
            <span>Templates</span>
          </a>
          <button type="button" className="icon-button" onClick={() => setThemePreference(theme.next)} title={`${theme.label}. Click to change.`} aria-label={theme.label}>
            <Icon name={theme.icon} />
          </button>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
