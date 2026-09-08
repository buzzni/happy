import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, LevelFormat, AlignmentType, BorderStyle,
} from 'docx'
import { docxSchema, GENERATOR } from './contracts'
import { openGeneratedOffice, replaceOneText, textRuns } from './ooxml'
import { resolveDocumentStyle } from './style'

export async function createDocx(value: unknown): Promise<Buffer> {
  const input = docxSchema.parse(value)
  const style = resolveDocumentStyle(input.design)
  const contentWidth = 12240 - style.pageMargin * 2
  const children: Array<Paragraph | Table> = [new Paragraph({ text: input.title, heading: HeadingLevel.TITLE })]
  let firstParagraph = true
  for (const block of input.blocks) {
    if (block.type === 'heading') children.push(new Paragraph({ text: block.text, heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2 }))
    if (block.type === 'paragraph') {
      const emphasized = firstParagraph && style.emphasizeFirstContent
      children.push(new Paragraph({
        children: [new TextRun({ text: block.text, bold: emphasized })],
        shading: emphasized ? { fill: style.surfaceColor } : undefined,
        border: emphasized ? { left: { style: BorderStyle.SINGLE, color: style.accentColor, size: 16, space: 8 } } : undefined,
        indent: emphasized ? { left: 180, right: 120 } : undefined,
        spacing: emphasized ? { before: 100, after: style.paragraphAfter + 40 } : undefined,
      }))
      firstParagraph = false
    }
    if (block.type === 'bulletList') for (const item of block.items) {
      children.push(new Paragraph({ text: item, numbering: { reference: 'bullets', level: 0 } }))
    }
    if (block.type === 'table') {
      const widths = block.columns.map((_, i) => Math.floor(contentWidth / block.columns.length) + (i === 0 ? contentWidth % block.columns.length : 0))
      children.push(new Table({
        width: { size: contentWidth, type: WidthType.DXA }, columnWidths: widths,
        indent: { size: 120, type: WidthType.DXA },
        rows: [block.columns, ...block.rows].map((row, rowIndex) => new TableRow({
          tableHeader: rowIndex === 0,
          children: row.map((text, i) => new TableCell({
            width: { size: widths[i], type: WidthType.DXA },
            margins: { top: style.cellPadding, bottom: style.cellPadding, left: 120, right: 120 },
            shading: { fill: rowIndex === 0 ? style.primaryColor : rowIndex % 2 === 0 ? style.surfaceColor : 'FFFFFF' },
            children: [new Paragraph({ children: [new TextRun({
              text, bold: rowIndex === 0, color: rowIndex === 0 ? style.foregroundOnPrimary : style.textColor,
            })] })],
          })),
        })),
      }), new Paragraph({ text: '' }))
    }
  }
  const doc = new Document({
    creator: 'SayCode', subject: GENERATOR, title: input.title,
    styles: {
      default: { document: { run: { font: style.fontFamily, size: style.bodySize, color: style.textColor }, paragraph: { spacing: { after: style.paragraphAfter, line: style.lineSpacing } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: style.fontFamily, size: style.titleSize, bold: true, color: style.primaryColor }, paragraph: { spacing: { after: 260 }, keepNext: true,
          border: { bottom: { style: BorderStyle.SINGLE, color: style.accentColor, size: 8, space: 8 } } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', run: { font: style.fontFamily, size: style.heading1Size, bold: true, color: style.primaryColor }, paragraph: { spacing: { before: 260, after: 140 }, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', run: { font: style.fontFamily, size: style.heading2Size, bold: true, color: style.primaryColor }, paragraph: { spacing: { before: 180, after: 100 }, keepNext: true } },
      ],
    },
    numbering: { config: [{ reference: 'bullets', levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360, hanging: 180 } } },
    }] }] },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: {
      top: style.pageMargin, bottom: style.pageMargin, left: style.pageMargin, right: style.pageMargin,
    } } }, children }],
  })
  return Packer.toBuffer(doc)
}

export async function readDocx(bytes: Buffer): Promise<string[]> {
  const zip = await openGeneratedOffice(bytes, 'docx')
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('DOCX 본문이 없습니다.')
  return textRuns(xml, 'w:t').map((run) => run.text)
}

export async function editDocxText(input: { bytes: Buffer; from: string; to: string }): Promise<Buffer> {
  return replaceOneText({ ...input, format: 'docx', parts: ['word/document.xml'], tag: 'w:t' })
}
