interface Props {
  size?: number;
  className?: string;
}

/* Every glyph is drawn on a 20×20 grid with a 1.5px stroke so the tool rail
   reads as one instrument rather than a collection of borrowed icons. The two
   measuring glyphs carry the witness-tick motif the annotations use on stage,
   so the tool and its mark are recognisably the same idea. */
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

/* --- render modes --------------------------------------------------------- */

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

/* --- stage ---------------------------------------------------------------- */

export const IconGrid = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M2.6 7.2h14.8M2.6 12.8h14.8M7.2 2.6v14.8M12.8 2.6v14.8" />
  </svg>
);

export const IconShadow = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <circle cx="8.4" cy="8.4" r="5" />
    <path d="M11.4 13.2a5 5 0 1 0 1.8-9.2" opacity=".5" />
    <ellipse cx="10" cy="16.4" rx="6.4" ry="1.4" opacity=".45" />
  </svg>
);

export const IconFit = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 7V3.6h3.4M13.6 3h3.4v3.4M17 13.6V17h-3.4M6.4 17H3v-3.4" />
    <rect x="7.4" y="7.4" width="5.2" height="5.2" rx=".8" opacity=".55" />
  </svg>
);

/* --- measuring -----------------------------------------------------------
   A witness tick at each end of a span is how a dimension is drawn on paper;
   it is the through-line for this pair. */

export const IconDistance = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M4 5.6v8.8M16 5.6v8.8" />
    <path d="M4 10h12" />
    <path d="M6.6 7.8L4 10l2.6 2.2M13.4 7.8L16 10l-2.6 2.2" />
  </svg>
);

export const IconDiameter = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <circle cx="10" cy="10" r="6.4" />
    <path d="M5.2 5.2l9.6 9.6" />
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconUndo = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M3.4 9.2h9a4 4 0 0 1 0 8H8.6" />
    <path d="M6.4 5.8L3 9.2l3.4 3.4" />
  </svg>
);

export const IconTrash = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M3.6 5.6h12.8M8 5.6V3.8h4v1.8" />
    <path d="M5.2 5.6l.8 10.2h8l.8-10.2" />
  </svg>
);

/* --- chrome --------------------------------------------------------------- */

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

export const IconClose = ({ size = 14 }: Props) => (
  <svg {...base(size)}>
    <path d="M4.6 4.6l10.8 10.8M15.4 4.6L4.6 15.4" />
  </svg>
);

/**
 * The wordmark. Two jaws closing on a span, with the span itself picked out in
 * amber — the app's whole proposition at 22 pixels.
 */
export const IconCaliper = ({ size = 22 }: Props) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4.6 4.5v15M19.4 4.5v15"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      opacity=".85"
    />
    <path d="M4.6 12h14.8" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
    <path
      d="M8.2 9.2L5.2 12l3 2.8M15.8 9.2l3 2.8-3 2.8"
      stroke="var(--accent)"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity=".75"
    />
  </svg>
);
