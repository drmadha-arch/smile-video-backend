import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 28, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.8-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.2" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" />
  </Svg>
);
export const ReplayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z" />
  </Svg>
);
export const Back10Icon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z" />
    <text x="12" y="16.2" fontSize="6.5" fontWeight="700" textAnchor="middle" fontFamily="system-ui, sans-serif">10</text>
  </Svg>
);
export const Fwd10Icon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8Z" />
    <text x="12" y="16.2" fontSize="6.5" fontWeight="700" textAnchor="middle" fontFamily="system-ui, sans-serif">10</text>
  </Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 10v4a1 1 0 0 0 1 1h3l4.3 3.6a1 1 0 0 0 1.7-.8V6.2a1 1 0 0 0-1.7-.8L7 9H4a1 1 0 0 0-1 1Zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z" />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 10v4a1 1 0 0 0 1 1h3l4.3 3.6a1 1 0 0 0 1.7-.8V6.2a1 1 0 0 0-1.7-.8L7 9H4a1 1 0 0 0-1 1Zm17.6 2 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4Z" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4Z" />
  </Svg>
);
export const ChevronDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="m12 15.4-6.7-6.7 1.4-1.4 5.3 5.3 5.3-5.3 1.4 1.4Z" />
  </Svg>
);
export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.7h4l.4-2.7a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.4ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" transform="translate(-1 0)" />
  </Svg>
);
export const FullscreenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 4h6v2H6v4H4Zm10 0h6v6h-2V6h-4ZM4 14h2v4h4v2H4Zm14 0h2v6h-6v-2h4Z" />
  </Svg>
);
export const ExitFullscreenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 4h2v6H4V8h4Zm6 0h2v4h4v2h-6ZM4 14h6v6H8v-4H4Zm10 0h6v2h-4v4h-2Z" />
  </Svg>
);
export const HdIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm2.5 4v6H8v-2.3h2V15h1.5V9H10v2.2H8V9Zm7 0v6H16a3 3 0 0 0 0-6Zm1.5 1.5h1a1.5 1.5 0 0 1 0 3h-1Z" fillRule="evenodd" />
  </Svg>
);
export const InfoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 8v7h2v-7Zm0-3v2h2V7Z" />
  </Svg>
);
export const ExpandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 3h7v7h-2V6.4l-5.3 5.3-1.4-1.4L17.6 5H14ZM3 14h2v3.6l5.3-5.3 1.4 1.4L6.4 19H10v2H3Z" />
  </Svg>
);
export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 3h6l1 2h4v2H4V5h4Zm-3 6h12l-1 12H7Z" />
  </Svg>
);

export function Spinner({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" className="spinner" aria-label="Loading">
      <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="5" />
      <path d="M25 5a20 20 0 0 1 20 20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
