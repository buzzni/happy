import { createRequire } from 'node:module'
import type PptxGenJS from 'pptxgenjs'
import { GENERATOR, pptxSchema } from './contracts'
import { openGeneratedOffice, replaceOneText, textRuns } from './ooxml'
import { resolveDocumentStyle } from './style'

// 4.0.1의 ESM export는 Node/tsx에서 생성자가 아닌 namespace로 로드된다.
// 이 모듈은 Node 전용이므로 패키지가 공개한 require entry를 사용한다.
const PptxConstructor: typeof PptxGenJS = createRequire(import.meta.url)('pptxgenjs')

export async function createPptx(value: unknown): Promise<Buffer> {
  const input = pptxSchema.parse(value)
  const style = resolveDocumentStyle(input.design)
  const pptx = new PptxConstructor()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'SayCode'
  pptx.subject = GENERATOR
  pptx.title = input.title
  pptx.theme = { headFontFace: style.fontFamily, bodyFontFace: style.fontFamily }
  input.slides.forEach((item, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: style.backgroundColor }
    if (item.layout === 'title') {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: 7.5,
        line: { color: style.primaryColor, transparency: 100 }, fill: { color: style.primaryColor } })
      slide.addShape(pptx.ShapeType.line, { x: style.slideMargin, y: 3.42, w: 1.35, h: 0,
        line: { color: style.accentColor, width: 4 } })
      slide.addText(item.title, { x: style.slideMargin, y: 1.3, w: 12.1 - style.slideMargin, h: 2.0,
        fontSize: style.slideTitleSize, bold: true, color: style.primaryColor, margin: 0, breakLine: false })
      slide.addText(item.subtitle, { x: style.slideMargin, y: 3.65, w: 12.1 - style.slideMargin, h: 1.5,
        fontSize: 24, color: style.mutedColor, margin: 0, valign: 'top' })
    } else {
      slide.addShape(pptx.ShapeType.line, { x: style.slideMargin, y: 1.58, w: 11.8 - style.slideMargin, h: 0,
        line: { color: style.accentColor, width: 2 } })
      slide.addText(item.title, { x: style.slideMargin, y: 0.7, w: 12.0 - style.slideMargin, h: 0.8,
        fontSize: style.slideHeadingSize, bold: true, color: style.primaryColor, margin: 0 })
      item.bullets.forEach((text, i) => slide.addText(text, {
        x: style.slideMargin + 0.1, y: style.slideContentTop + i * style.slideBulletGap,
        w: 11.9 - style.slideMargin, h: style.slideBulletGap - 0.08,
        fontSize: style.slideBodySize,
        color: i === 0 && style.emphasizeFirstContent ? style.accentColor : style.textColor,
        bold: i === 0 && style.emphasizeFirstContent, margin: 0, valign: 'top',
        bullet: { indent: 22 }, paraSpaceAfter: 8,
      }))
    }
    slide.addText(`${index + 1} / ${input.slides.length}`, { x: 11, y: 6.95, w: 1.4, h: 0.3,
      fontSize: 12, color: style.mutedColor, align: 'right', margin: 0 })
  })
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }) as Buffer)
}

async function slideParts(bytes: Buffer) {
  const zip = await openGeneratedOffice(bytes, 'pptx')
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]))
  if (parts.length < 1 || parts.length > 10) throw new Error('슬라이드 수가 모듈 제한을 벗어났습니다.')
  return { zip, parts }
}

export async function readPptx(bytes: Buffer): Promise<string[][]> {
  const { zip, parts } = await slideParts(bytes)
  return Promise.all(parts.map(async (part) => textRuns(await zip.file(part)!.async('string'), 'a:t').map((run) => run.text)))
}

export async function editPptxText(input: { bytes: Buffer; from: string; to: string }): Promise<Buffer> {
  const { parts } = await slideParts(input.bytes)
  return replaceOneText({ ...input, format: 'pptx', parts, tag: 'a:t' })
}
