import type { ReactNode } from 'react';

/**
 * Small line icons drawn on a 24x24 grid with `currentColor`, so they inherit
 * the green `.icon-badge` foreground. Keyed by name; every feature entry on the
 * site picks one.
 */
const ICONS: Record<string, ReactNode> = {
  box: (
    <>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5M9 13h7M9 17h7" />
    </>
  ),
  graph: (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M7.3 10.8l9.4-4.6M7.3 13.2l9.4 4.6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v4M21 12v3" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12l9-9h8v8l-9 9z" />
      <circle cx="15.5" cy="8.5" r="1.5" />
    </>
  ),
  parallel: (
    <>
      <path d="M6 4v16M12 4v16M18 4v16" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  recycle: (
    <>
      <path d="M5 8l3-4 3 4M8 4v9a3 3 0 003 3h3" />
      <path d="M19 16l-3 4-3-4M16 20v-9a3 3 0 00-3-3H10" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  resume: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8l6 4-6 4z" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  handoff: (
    <>
      <path d="M3 9h13l-4-4M21 15H8l4 4" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V14a4 4 0 004 4h5.5M8.5 6H14a4 4 0 014 4v5.5" />
    </>
  ),
  upgrade: (
    <>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </>
  ),
};

export type FeatureIconName = keyof typeof ICONS;

export default function FeatureIcon({ name }: { name: FeatureIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
