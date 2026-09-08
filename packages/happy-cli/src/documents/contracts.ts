import { z } from 'zod'

export const GENERATOR = 'SayCode document-module PoC v1'
export const textValue = z.string().trim().min(1).max(4000)
  .refine((value) => [...value].every((character) => {
    const code = character.codePointAt(0)!
    return code >= 32 || code === 9 || code === 10 || code === 13
  }), 'XML 제어 문자는 지원하지 않습니다.')

const hexColor = z.string().regex(/^[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase())
export const designSchema = z.object({
  audience: z.enum(['general', 'executive', 'client', 'operator']),
  mood: z.enum(['neutral', 'refined', 'calm', 'bold', 'warm']),
  density: z.enum(['compact', 'balanced', 'spacious']),
  emphasis: z.enum(['balanced', 'conclusion', 'metrics', 'comparison', 'process']),
  accessibility: z.enum(['standard', 'high-contrast']),
  brand: z.object({
    primaryColor: hexColor,
    accentColor: hexColor,
    fontFamily: textValue.max(50),
  }).strict().optional(),
}).strict()
export type DocumentDesign = z.infer<typeof designSchema>

export const docxSchema = z.object({
  schemaVersion: z.literal('1.0'), format: z.literal('docx'), title: textValue.max(80),
  design: designSchema.optional(),
  blocks: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2)]), text: textValue.max(80) }).strict(),
    z.object({ type: z.literal('paragraph'), text: textValue }).strict(),
    z.object({ type: z.literal('bulletList'), items: z.array(textValue.max(300)).min(1).max(10) }).strict(),
    z.object({ type: z.literal('table'), columns: z.array(textValue.max(40)).min(1).max(6),
      rows: z.array(z.array(textValue.max(160)).min(1).max(6)).min(1).max(20),
    }).strict().refine((table) => table.rows.every((row) => row.length === table.columns.length), '표의 열 개수가 다릅니다.'),
  ])).min(1).max(40),
}).strict()

export const scalarCell = z.union([
  z.literal(''),
  textValue.max(240),
  z.number().finite().min(-1e12).max(1e12),
  z.boolean(),
  z.null(),
])
export const formulaPattern = /^(?:SUM\([A-H][1-9]\d{0,2}:[A-H][1-9]\d{0,2}\)|[A-H][1-9]\d{0,2}\*[A-H][1-9]\d{0,2})$/
export const xlsxSchema = z.object({
  schemaVersion: z.literal('1.0'), format: z.literal('xlsx'), title: textValue.max(80),
  design: designSchema.optional(),
  sheets: z.array(z.object({
    name: textValue.max(31).regex(/^[^\\/*?:[\]']+$/),
    columns: z.array(textValue.max(40)).min(1).max(8),
    rows: z.array(z.array(z.union([scalarCell, z.object({ formula: z.string().regex(formulaPattern) }).strict()])).min(1).max(8)).min(1).max(100),
  }).strict().refine((sheet) => sheet.rows.every((row) => row.length === sheet.columns.length), '시트의 열 개수가 다릅니다.')).min(1).max(4),
}).strict().refine((book) => new Set(book.sheets.map((s) => s.name.toLowerCase())).size === book.sheets.length, '시트 이름이 중복됩니다.')

export const pptxSchema = z.object({
  schemaVersion: z.literal('1.0'), format: z.literal('pptx'), title: textValue.max(80),
  design: designSchema.optional(),
  slides: z.array(z.discriminatedUnion('layout', [
    z.object({ layout: z.literal('title'), title: textValue.max(32), subtitle: textValue.max(80) }).strict(),
    z.object({ layout: z.literal('title-and-content'), title: textValue.max(22), bullets: z.array(textValue.max(80)).min(1).max(5) }).strict(),
  ])).min(1).max(10),
}).strict()

export function parseDocumentInput(text: string, format: string) {
  if (text.length > 100_000) throw new Error('문서 입력은 100,000자 이하로 제한합니다.')
  const trimmed = text.trim()
  const json = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed)?.[1] ?? trimmed
  const result = z.union([docxSchema, xlsxSchema, pptxSchema]).parse(JSON.parse(json))
  if (result.format !== format) throw new Error('요청한 문서 형식과 응답 형식이 다릅니다.')
  return result
}
