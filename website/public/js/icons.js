// Interface icons, drawn in the spirit of the United Nations visual identity: plain line pictograms on a
// 24-unit grid, one even stroke with rounded ends, no fills or ornaments. They take the colour of the text
// around them (currentColor), so UN blue on links and buttons, and follow the light/dark theme.
// Built as inline SVG (no file to load, nothing the Content-Security-Policy would block).

const SVG = 'http://www.w3.org/2000/svg';

// Each icon: a list of SVG elements [tag, attributes]. Coordinates on a 24 × 24 grid.
const ICONS = {
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5' }], ['path', { d: 'M12 7.5v.01' }]],
  move: [['path', { d: 'M4 8h13' }], ['path', { d: 'M14 4.5 17.5 8 14 11.5' }], ['path', { d: 'M20 16H7' }], ['path', { d: 'M10 12.5 6.5 16l3.5 3.5' }]],
  edit: [['path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z' }], ['path', { d: 'm13.5 6.5 4 4' }]],
  trash: [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V4.5h6V7' }], ['path', { d: 'M6.5 7l1 13h9l1-13' }], ['path', { d: 'M10 11v5.5M14 11v5.5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  check: [['path', { d: 'M5 12.5 10 17.5 19 7' }]],
  error: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm9 9 6 6M15 9l-6 6' }]],
  warning: [['path', { d: 'M12 3.5 2.5 20h19L12 3.5z' }], ['path', { d: 'M12 10v4.5' }], ['path', { d: 'M12 17.5v.01' }]],
  eye: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  external: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4 11 13' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 1.5 }], ['path', { d: 'M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8' }]],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4' }]],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]],
  'chevron-left': [['path', { d: 'M15 5 8 12l7 7' }]],
  'chevron-right': [['path', { d: 'm9 5 7 7-7 7' }]],
  'arrow-up': [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  'arrow-down': [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
};

/** An icon as an <svg> element. Decorative by default (hidden from screen readers): the button or link
 *  carrying it keeps its text or aria-label. Pass {label} for an icon that stands alone and means something. */
export function icon(name, { label = null, size = null } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (size) svg.style.setProperty('--icon-size', size);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}
