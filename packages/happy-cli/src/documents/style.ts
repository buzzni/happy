import type { DocumentDesign } from './contracts'

const DEFAULT_DESIGN: DocumentDesign = {
  audience: 'general',
  mood: 'neutral',
  density: 'balanced',
  emphasis: 'balanced',
  accessibility: 'standard',
}

const PALETTES = {
  neutral: { primary: '17324D', accent: '1565C0', surface: 'F1F5F8', background: 'F8FAFC', text: '25364A', muted: '62758A' },
  refined: { primary: '26324B', accent: '7357D9', surface: 'F1EFFA', background: 'FAF9FC', text: '25283A', muted: '6D7082' },
  calm: { primary: '1F5C5B', accent: '4C9A8A', surface: 'EAF4F1', background: 'F8FBFA', text: '1F3435', muted: '607677' },
  bold: { primary: '312E81', accent: 'F97316', surface: 'F2F0FF', background: 'FBFAFF', text: '1F2340', muted: '65658A' },
  warm: { primary: '6B3F2B', accent: 'C76A3A', surface: 'FBF1E9', background: 'FFF9F5', text: '3B2B24', muted: '806E64' },
} as const

function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

function readableForeground(background: string): '000000' | 'FFFFFF' {
  return contrastRatio(background, 'FFFFFF') >= contrastRatio(background, '000000') ? 'FFFFFF' : '000000'
}

export function resolveDocumentStyle(value?: DocumentDesign) {
  const design = value ?? DEFAULT_DESIGN
  const palette = PALETTES[design.mood]
  const primaryColor = design.brand?.primaryColor ?? palette.primary
  const accentColor = design.brand?.accentColor ?? palette.accent
  const highContrast = design.accessibility === 'high-contrast'
  const density = {
    compact: {
      pageMargin: 1080, bodySize: 20, paragraphAfter: 90, lineSpacing: 270,
      titleSize: 40, heading1Size: 28, heading2Size: 23, cellPadding: 70,
      xlsxRowHeight: 30, xlsxHeaderHeight: 26, xlsxFirstColumnWidth: 26, xlsxColumnWidth: 20, xlsxFontSize: 11,
      slideTitleSize: 46, slideHeadingSize: 34, slideBodySize: 18, slideMargin: 0.7, slideContentTop: 1.7, slideBulletGap: 0.78,
    },
    balanced: {
      pageMargin: 1440, bodySize: 22, paragraphAfter: 140, lineSpacing: 300,
      titleSize: 44, heading1Size: 30, heading2Size: 25, cellPadding: 100,
      xlsxRowHeight: 38, xlsxHeaderHeight: 30, xlsxFirstColumnWidth: 30, xlsxColumnWidth: 24, xlsxFontSize: 12,
      slideTitleSize: 50, slideHeadingSize: 35, slideBodySize: 20, slideMargin: 0.9, slideContentTop: 1.9, slideBulletGap: 0.91,
    },
    spacious: {
      pageMargin: 1620, bodySize: 23, paragraphAfter: 180, lineSpacing: 320,
      titleSize: 48, heading1Size: 32, heading2Size: 26, cellPadding: 130,
      xlsxRowHeight: 44, xlsxHeaderHeight: 34, xlsxFirstColumnWidth: 34, xlsxColumnWidth: 28, xlsxFontSize: 12,
      slideTitleSize: 54, slideHeadingSize: 38, slideBodySize: 22, slideMargin: 1.1, slideContentTop: 2.0, slideBulletGap: 1.0,
    },
  }[design.density]
  return {
    ...design,
    ...density,
    fontFamily: design.brand?.fontFamily ?? 'Noto Sans CJK KR',
    primaryColor,
    accentColor,
    surfaceColor: highContrast ? 'F3F4F6' : palette.surface,
    backgroundColor: highContrast ? 'FFFFFF' : palette.background,
    textColor: highContrast ? '111111' : palette.text,
    mutedColor: highContrast ? '444444' : palette.muted,
    foregroundOnPrimary: readableForeground(primaryColor),
    foregroundOnAccent: readableForeground(accentColor),
    emphasizeFirstContent: design.emphasis === 'conclusion' || design.audience === 'executive',
    emphasizeNumbers: design.emphasis === 'metrics' || design.audience === 'executive',
  }
}

export type ResolvedDocumentStyle = ReturnType<typeof resolveDocumentStyle>
