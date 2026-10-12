/** Hash-based routing: works on any static host, with no server configuration. */
import { useSyncExternalStore } from 'react';

export type Route =
  | { page: 'projects' }
  | { page: 'project'; projectId: string }
  | { page: 'editor'; projectId: string; vizId: string }
  /** A visualization on its own, filling the window: as configured, or as the rows behind it. */
  | { page: 'view'; projectId: string; vizId: string; table: boolean }
  | { page: 'templates' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'templates') return { page: 'templates' };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 'v' && parts[3]) {
      if (parts[4] === 'view') return { page: 'view', projectId: parts[1], vizId: parts[3], table: parts[5] === 'table' };
      return { page: 'editor', projectId: parts[1], vizId: parts[3] };
    }
    return { page: 'project', projectId: parts[1] };
  }
  return { page: 'projects' };
}

export function hrefFor(route: Route): string {
  switch (route.page) {
    case 'project':
      return `#/p/${route.projectId}`;
    case 'editor':
      return `#/p/${route.projectId}/v/${route.vizId}`;
    case 'view':
      return `#/p/${route.projectId}/v/${route.vizId}/view${route.table ? '/table' : ''}`;
    case 'templates':
      return '#/templates';
    default:
      return '#/';
  }
}

/**
 * Goes to a route. With `replace` the current history entry is swapped instead of a new
 * one being added: for switching how the same thing is shown, which Back should not undo
 * step by step.
 */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  if (replace) window.location.replace(hrefFor(route));
  else window.location.hash = hrefFor(route);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** The current route. The hash string is the snapshot, so equal hashes do not re-render. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
