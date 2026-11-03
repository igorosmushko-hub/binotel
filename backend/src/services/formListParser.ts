import * as XLSX from 'xlsx'

const NUMBER_HEADER = /номер\s*анкет|form\s*number/i
const ID_HEADER     = /id\s*анкет|form\s*id/i

/**
 * Извлекает номера и ID анкет из загруженного файла (XLSX/CSV).
 * Ищет колонки по заголовкам «Номер Анкеты» / «ID Анкеты» (файлы выгрузок
 * SimpleForms содержат два ряда заголовков — повторы заголовков в данных пропускаются).
 */
export function parseFormListFile(buf: Buffer): { numbers: string[], ids: string[] } {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const numbers = new Set<string>()
  const ids = new Set<string>()

  for (const sheetName of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true })

    // Ищем колонки в первых 10 строках
    let numCol = -1, idCol = -1, headerRow = -1
    for (let i = 0; i < Math.min(rows.length, 10) && numCol === -1 && idCol === -1; i++) {
      const row = rows[i] ?? []
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] ?? '').trim()
        if (numCol === -1 && NUMBER_HEADER.test(cell)) { numCol = j; headerRow = i }
        if (idCol === -1 && ID_HEADER.test(cell))      { idCol = j;  headerRow = i }
      }
    }
    if (headerRow === -1) continue

    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i] ?? []
      if (numCol !== -1) {
        const v = String(row[numCol] ?? '').trim()
        if (v && !NUMBER_HEADER.test(v)) numbers.add(v)
      }
      if (idCol !== -1) {
        const v = String(row[idCol] ?? '').trim()
        if (v && !ID_HEADER.test(v)) ids.add(v)
      }
    }
  }

  return { numbers: [...numbers], ids: [...ids] }
}
