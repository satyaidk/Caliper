interface Props {
  size?: number;
  className?: string;
}

/* Every glyph is drawn on a 20×20 grid with a 1.5px stroke so the tool rail
   reads as one instrument rather than a collection of borrowed icons. */
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconShaded = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 2.6l6.4 3.7v7.4L10 17.4 3.6 13.7V6.3z" />
    <path d="M10 10l6.4-3.7M10 10v7.4M10 10L3.6 6.3" opacity=".55" />
  </svg>
);

export const IconWire = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 2.6l6.4 3.7v7.4L10 17.4 3.6 13.7V6.3z" />
    <path d="M3.6 6.3l6.4 3.7 6.4-3.7M10 10v7.4M3.6 13.7L10 10l6.4 3.7" />
  </svg>
);

export const IconEdges = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1" />
    <path d="M7.4 7.4h9.2v9.2H7.4z" opacity=".45" />
  </svg>
);

export const IconXray = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 2.6l6.4 3.7v7.4L10 17.4 3.6 13.7V6.3z" strokeDasharray="2.4 2" />
    <circle cx="10" cy="10" r="2.4" />
  </svg>
);

export const IconNormals = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 13.5l4.5-4.5 3 3L17 5.5" />
    <path d="M13.5 5.5H17V9" />
  </svg>
);

export const IconGrid = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M2.6 7.2h14.8M2.6 12.8h14.8M7.2 2.6v14.8M12.8 2.6v14.8" />
  </svg>
);

export const IconAxes = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 17V7" />
    <path d="M10 12L3.4 15.6M10 12l6.6 3.6" />
    <circle cx="10" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSection = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 2.6l6.4 3.7v7.4L10 17.4 3.6 13.7V6.3z" opacity=".4" />
    <path d="M10 2.6L3.6 6.3v7.4L10 17.4z" />
    <path d="M10 1.4v17.2" strokeDasharray="2 2" />
  </svg>
);

export const IconExplode = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <rect x="7.6" y="7.6" width="4.8" height="4.8" rx=".6" />
    <path d="M10 5.6V2.4M10 14.4v3.2M5.6 10H2.4M14.4 10h3.2" />
  </svg>
);

export const IconSpin = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M16.6 10a6.6 6.6 0 1 1-2.3-5" />
    <path d="M16.8 2.6v3.6h-3.6" />
  </svg>
);

export const IconFit = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 7V3.6h3.4M13.6 3h3.4v3.4M17 13.6V17h-3.4M6.4 17H3v-3.4" />
    <rect x="7.4" y="7.4" width="5.2" height="5.2" rx=".8" opacity=".55" />
  </svg>
);

export const IconOpen = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M2.8 15.2V5.4a1 1 0 0 1 1-1h3.9l1.5 1.9h6a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1z" />
    <path d="M10 8.4v4.4M7.9 10.5L10 8.4l2.1 2.1" />
  </svg>
);

export const IconCamera = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <rect x="2.6" y="5.4" width="14.8" height="10.2" rx="1.6" />
    <circle cx="10" cy="10.5" r="2.9" />
    <path d="M7.2 5.4l1-1.8h3.6l1 1.8" />
  </svg>
);

export const IconPanel = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="1.6" />
    <path d="M12.6 3.6v12.8" />
  </svg>
);

export const IconSun = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <circle cx="10" cy="10" r="3.4" />
    <path d="M10 1.8v2.2M10 16v2.2M3.2 3.2l1.6 1.6M15.2 15.2l1.6 1.6M1.8 10H4M16 10h2.2M3.2 16.8l1.6-1.6M15.2 4.8l1.6-1.6" />
  </svg>
);

export const IconMoon = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M16.4 12.4A7 7 0 0 1 7.6 3.6a7 7 0 1 0 8.8 8.8z" />
  </svg>
);

export const IconEye = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M1.8 10S4.9 4.6 10 4.6 18.2 10 18.2 10 15.1 15.4 10 15.4 1.8 10 1.8 10z" />
    <circle cx="10" cy="10" r="2.2" />
  </svg>
);

export const IconEyeOff = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M7.6 5.1A7.9 7.9 0 0 1 10 4.6c5.1 0 8.2 5.4 8.2 5.4a15 15 0 0 1-2.6 3.2M4.6 6.1A15.3 15.3 0 0 0 1.8 10S4.9 15.4 10 15.4c1.1 0 2-.2 2.9-.6" />
    <path d="M2.6 2.6l14.8 14.8" />
  </svg>
);

export const IconChevron = ({ size = 12 }: Props) => (
  <svg {...base(size)}>
    <path d="M7.5 4.5L13 10l-5.5 5.5" />
  </svg>
);

export const IconClose = ({ size = 14 }: Props) => (
  <svg {...base(size)}>
    <path d="M4.6 4.6l10.8 10.8M15.4 4.6L4.6 15.4" />
  </svg>
);

export const IconSearch = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <circle cx="8.8" cy="8.8" r="5.6" />
    <path d="M13 13l4 4" />
  </svg>
);

export const IconCube = ({ size = 22 }: Props) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 2.4l8.4 4.85v9.7L12 21.8l-8.4-4.85v-9.7z"
      stroke="var(--accent)"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M12 12.1l8.4-4.85M12 12.1v9.7M12 12.1L3.6 7.25"
      stroke="var(--accent)"
      strokeWidth="1.1"
      opacity=".6"
    />
  </svg>
);
