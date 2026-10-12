/** A small set of line icons, drawn on a 24-unit grid. */
import type { ReactNode } from 'react';

const ICONS = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  back: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  more: <path d="M12 5.5v.01M12 12v.01M12 18.5v.01" strokeWidth="2.6" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  expand: <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />,
  file: <path d="M7 3h7l5 5v13H7zM14 3v5h5" />,
  append: <path d="M7 3h7l5 5v13H7zM14 3v5h5M13 12v6M10 15h6" />,
  replace: <path d="M4 10a8 8 0 0 1 14-4l2 2M20 14a8 8 0 0 1-14 4l-2-2M20 4v4h-4M4 20v-4h4" />,
  line: <path d="M4 19h16M5 15l4-5 4 3 6-8" />,
  area: <path d="M4 19h16M5 19v-5l4-5 4 3 6-7v14" />,
  bar: <path d="M4 20h16M7 20v-7M12 20V6M17 20V10" />,
  scatter: (
    <>
      <path d="M4 20h16" />
      <circle cx="7.5" cy="14.5" r="1.3" />
      <circle cx="11" cy="9" r="1.3" />
      <circle cx="14.5" cy="13" r="1.3" />
      <circle cx="18" cy="6" r="1.3" />
    </>
  ),
  table: <path d="M4 5h16v14H4zM4 10h16M10 5v14" />,
  star: <path d="M12 4l2.4 5 5.6.7-4.1 3.8 1.1 5.5L12 16.3 7 19l1.1-5.5L4 9.7 9.6 9z" />,
  shuffle: <path d="M4 7h3l10 10h3M4 17h3l3-3M14 10l3-3h3M18 4l3 3-3 3M18 14l3 3-3 3" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  monitor: <path d="M4 5h16v11H4zM9 20h6M12 16v4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  alert: <path d="M12 4l9 16H3zM12 10v4M12 17v.01" />,
  code: <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />,
  layers: <path d="M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
  folder: <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8v.01" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
