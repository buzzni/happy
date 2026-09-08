import ExcelJS from 'exceljs'
import { z } from 'zod'
import { formulaPattern, GENERATOR, scalarCell, xlsxSchema } from './contracts'
import { openGeneratedOffice } from './ooxml'
import { resolveDocumentStyle } from './style'

function recalculate(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    const pending = new Set<string>()
    const results = new Map<string, number>()
    const resolveCell = (address: string): number => {
      const match = /^([A-H])([1-9]\d{0,2})$/.exec(address)
      if (!match || Number(match[2]) > sheet.rowCount || match[1].charCodeAt(0) - 64 > sheet.columnCount) {
        throw new Error('수식 셀 참조가 데이터 범위를 벗어났습니다.')
      }
      if (pending.has(address)) throw new Error('순환 수식은 지원하지 않습니다.')
      if (results.has(address)) return results.get(address)!
      const cell = sheet.getCell(address)
      if (!cell.formula) {
        if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) throw new Error('수식은 숫자 셀만 참조할 수 있습니다.')
        return cell.value
      }
      const formula = cell.formula
      if (!formulaPattern.test(formula)) throw new Error('허용되지 않은 수식입니다.')
      pending.add(address)
      let result: number
      if (formula.startsWith('SUM(')) {
        const [, startColumn, startRow, endColumn, endRow] = /^SUM\(([A-H])(\d+):([A-H])(\d+)\)$/.exec(formula)!
        if (startColumn > endColumn || Number(startRow) > Number(endRow)) throw new Error('수식 범위 순서가 잘못됐습니다.')
        result = 0
        for (let row = Number(startRow); row <= Number(endRow); row++) {
          for (let column = startColumn.charCodeAt(0); column <= endColumn.charCodeAt(0); column++) {
            result += resolveCell(`${String.fromCharCode(column)}${row}`)
          }
        }
      } else {
        const [a, b] = formula.split('*')
        result = resolveCell(a) * resolveCell(b)
      }
      if (!Number.isFinite(result)) throw new Error('수식 결과가 유효한 숫자가 아닙니다.')
      pending.delete(address)
      results.set(address, result)
      cell.value = { formula, result }
      return result
    }
    sheet.eachRow((row) => row.eachCell((cell) => { if (cell.formula) resolveCell(cell.address) }))
  }
}

async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  await openGeneratedOffice(bytes, 'xlsx')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  if (workbook.worksheets.length > 4 || workbook.worksheets.some((sheet) => sheet.rowCount > 101 || sheet.columnCount > 8)) {
    throw new Error('이번 XLSX 모듈의 시트·행·열 제한을 초과했습니다.')
  }
  for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.formula && !formulaPattern.test(cell.formula)) throw new Error('허용되지 않은 수식입니다.')
  }))
  return workbook
}

const alignmentRangeSchema = z.string().regex(/^[A-H][1-9]\d{0,2}:[A-H][1-9]\d{0,2}$/)
  .refine((range) => {
    const [start, end] = range.split(':')
    return start[0] <= end[0] && Number(start.slice(1)) <= Number(end.slice(1))
  }, '정렬 범위 순서가 잘못됐습니다.')
const xlsxAlignmentPlanSchema = z.object({
  schemaVersion: z.literal('1.0'),
  format: z.literal('xlsx-alignment'),
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(31),
    ranges: z.array(z.object({
      range: alignmentRangeSchema,
      horizontal: z.enum(['left', 'center', 'right']),
      vertical: z.enum(['top', 'middle', 'bottom']),
      wrapText: z.boolean(),
    }).strict()).min(1).max(16),
  }).strict()).min(1).max(4),
}).strict().refine(
  (plan) => new Set(plan.sheets.map((sheet) => sheet.name.toLowerCase())).size === plan.sheets.length,
  '정렬할 시트 이름이 중복됩니다.',
)

export type XlsxAlignmentPlan = z.infer<typeof xlsxAlignmentPlanSchema>

function decodeRange(range: string) {
  const [start, end] = range.split(':')
  return {
    startColumn: start.charCodeAt(0) - 64,
    startRow: Number(start.slice(1)),
    endColumn: end.charCodeAt(0) - 64,
    endRow: Number(end.slice(1)),
  }
}

function rangesOverlap(a: ReturnType<typeof decodeRange>, b: ReturnType<typeof decodeRange>) {
  return a.startColumn <= b.endColumn && b.startColumn <= a.endColumn
    && a.startRow <= b.endRow && b.startRow <= a.endRow
}

export function parseXlsxAlignmentPlan(text: string): XlsxAlignmentPlan {
  if (text.length > 30_000) throw new Error('XLSX 정렬 계획은 30,000자 이하여야 합니다.')
  const trimmed = text.trim()
  const json = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed)?.[1] ?? trimmed
  return xlsxAlignmentPlanSchema.parse(JSON.parse(json))
}

export async function inspectXlsxAlignment(bytes: Buffer) {
  const workbook = await loadWorkbook(bytes)
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    usedRange: `A1:${String.fromCharCode(64 + sheet.columnCount)}${sheet.rowCount}`,
    rows: sheet.rowCount,
    columns: sheet.columnCount,
    cells: Array.from({ length: sheet.rowCount }, (_, rowIndex) => (
      Array.from({ length: sheet.columnCount }, (_, columnIndex) => {
        const cell = sheet.getCell(rowIndex + 1, columnIndex + 1)
        return {
          address: cell.address,
          role: rowIndex === 0 ? 'header' : 'data',
          valueType: cell.formula ? 'formula' : cell.value === null ? 'blank' : typeof cell.value,
          horizontal: cell.alignment.horizontal ?? null,
          vertical: cell.alignment.vertical ?? null,
          wrapText: cell.alignment.wrapText ?? false,
        }
      })
    )).flat(),
  }))
}

export async function applyXlsxAlignmentPlan(input: {
  bytes: Buffer
  plan: XlsxAlignmentPlan
}): Promise<Buffer> {
  const plan = xlsxAlignmentPlanSchema.parse(input.plan)
  const workbook = await loadWorkbook(input.bytes)
  for (const requestedSheet of plan.sheets) {
    const sheet = workbook.getWorksheet(requestedSheet.name)
    if (!sheet) throw new Error(`정렬할 시트 ${requestedSheet.name}을 찾지 못했습니다.`)
    const ranges = requestedSheet.ranges.map((range) => ({ ...range, decoded: decodeRange(range.range) }))
    for (const range of ranges) {
      if (range.decoded.endColumn > sheet.columnCount || range.decoded.endRow > sheet.rowCount) {
        throw new Error(`정렬 범위 ${range.range}가 ${requestedSheet.name}의 사용 범위를 벗어났습니다.`)
      }
    }
    for (let current = 0; current < ranges.length; current++) {
      for (let previous = 0; previous < current; previous++) {
        if (rangesOverlap(ranges[current].decoded, ranges[previous].decoded)) {
          throw new Error(`정렬 범위 ${ranges[current].range}와 ${ranges[previous].range}가 겹칩니다.`)
        }
      }
    }
    for (const range of ranges) {
      const { startColumn, startRow, endColumn, endRow } = range.decoded
      for (let row = startRow; row <= endRow; row++) {
        for (let column = startColumn; column <= endColumn; column++) {
          const cell = sheet.getCell(row, column)
          cell.alignment = {
            ...cell.alignment,
            horizontal: range.horizontal,
            vertical: range.vertical,
            wrapText: range.wrapText,
          }
        }
      }
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function createXlsx(value: unknown): Promise<Buffer> {
  const input = xlsxSchema.parse(value)
  const style = resolveDocumentStyle(input.design)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SayCode'
  workbook.subject = GENERATOR
  workbook.title = input.title
  workbook.calcProperties.fullCalcOnLoad = true
  for (const data of input.sheets) {
    const sheet = workbook.addWorksheet(data.name, {
      properties: { tabColor: { argb: `FF${style.primaryColor}` } },
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      headerFooter: { oddFooter: `&L${input.title}&R페이지 &P / &N` },
    })
    sheet.addRow(data.columns)
    data.rows.forEach((row) => sheet.addRow(row))
    sheet.columns.forEach((column, index) => {
      column.width = index === 0 ? style.xlsxFirstColumnWidth : style.xlsxColumnWidth
    })
    sheet.eachRow((row, index) => {
      const source = index > 1 ? data.rows[index - 2] : undefined
      const wrappedLines = source?.reduce<number>((maximum, value, columnIndex) => {
        const text = value && typeof value === 'object' ? value.formula : String(value ?? '')
        const displayWidth = [...text].reduce((sum, character) => sum + (character.codePointAt(0)! > 0xFF ? 2 : 1), 0)
        const available = (columnIndex === 0 ? style.xlsxFirstColumnWidth : style.xlsxColumnWidth) - 4
        return Math.max(maximum, Math.ceil(displayWidth / available))
      }, 1) ?? 1
      row.height = index === 1 ? style.xlsxHeaderHeight : Math.max(style.xlsxRowHeight, wrappedLines * 22 + 8)
      row.eachCell({ includeEmpty: true }, (cell) => {
        const numeric = typeof cell.value === 'number' || Boolean(cell.formula)
        cell.font = { name: style.fontFamily, size: style.xlsxFontSize,
          bold: index === 1 || (numeric && style.emphasizeNumbers),
          color: { argb: `FF${index === 1 ? style.foregroundOnPrimary : numeric ? style.accentColor : style.textColor}` } }
        cell.alignment = { vertical: 'middle', horizontal: numeric ? 'right' : 'left', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: {
          argb: `FF${index === 1 ? style.primaryColor : index % 2 === 0 ? style.surfaceColor : 'FFFFFF'}`,
        } }
        if (numeric) cell.numFmt = '#,##0.##'
      })
    })
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.rows.length + 1, column: data.columns.length } }
    sheet.pageSetup.printArea = `A1:${String.fromCharCode(64 + data.columns.length)}${data.rows.length + 1}`
  }
  recalculate(workbook)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function readXlsx(bytes: Buffer) {
  const workbook = await loadWorkbook(bytes)
  return workbook.worksheets.map((sheet) => {
    const cells: Record<string, ExcelJS.CellValue> = {}
    sheet.eachRow((row) => row.eachCell((cell) => { cells[cell.address] = cell.value }))
    return { name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, cells }
  })
}

export async function editXlsxCell(input: { bytes: Buffer; sheet: string; address: string; value: unknown }): Promise<Buffer> {
  const value = scalarCell.parse(input.value)
  const workbook = await loadWorkbook(input.bytes)
  const sheet = workbook.getWorksheet(input.sheet)
  const address = /^([A-H])([1-9]\d{0,2})$/.exec(input.address)
  if (!sheet || !address || Number(address[2]) < 2 || Number(address[2]) > sheet.rowCount || address[1].charCodeAt(0) - 64 > sheet.columnCount) {
    throw new Error('편집할 시트 또는 데이터 셀을 찾지 못했습니다.')
  }
  const cell = sheet.getCell(input.address)
  if (cell.formula) throw new Error('수식 셀 대신 입력 셀을 수정하세요.')
  cell.value = value
  recalculate(workbook)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
