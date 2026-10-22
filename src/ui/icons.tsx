type P = { size?: number };

function Svg({ size = 18, children }: P & { children: preact.ComponentChildren }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Logo = (p: P) => (
  <Svg {...p}>
    <circle cx="6.5" cy="12" r="2" fill="currentColor" stroke="none" />
    <path d="M11 8a5.5 5.5 0 0 1 0 8" />
    <path d="M14.5 5a10 10 0 0 1 0 14" opacity=".7" />
    <path d="M18 2.5a14 14 0 0 1 0 19" opacity=".4" />
  </Svg>
);
export const Lock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const Mic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);
export const Send = (p: P) => (
  <Svg {...p}>
    <path d="M4 12h12M12 6l6 6-6 6" />
  </Svg>
);
export const Pin = (p: P) => (
  <Svg {...p}>
    <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11Z" />
    <circle cx="12" cy="10" r="2.2" />
  </Svg>
);
export const FileIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);
export const WaveFile = (p: P) => (
  <Svg {...p}>
    <path d="M3 12h2l2-5 3 10 3-12 3 14 2-7h3" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m5 12 4.5 4.5L19 7" />
  </Svg>
);
export const Cross = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const Relay = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
    <path d="M7 12h3M14 12h3" />
    <circle cx="12" cy="12" r="2" />
  </Svg>
);
export const Compass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </Svg>
);
export const Upload = (p: P) => (
  <Svg {...p}>
    <path d="M12 20V9M7 14l5-5 5 5M5 4h14" />
  </Svg>
);
