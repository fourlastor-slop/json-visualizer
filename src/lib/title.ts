import { useEffect } from 'react';

const APP_NAME = 'JSON Explorer';

/** Names the browser tab after what is open in it, so several tabs can be told apart. */
export function useDocumentTitle(name: string | undefined): void {
  useEffect(() => {
    if (name === undefined) return;
    document.title = `${name} · ${APP_NAME}`;
    return () => {
      document.title = APP_NAME;
    };
  }, [name]);
}
