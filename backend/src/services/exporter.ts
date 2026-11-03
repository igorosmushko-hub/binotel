import * as XLSX from 'xlsx'
import { MatchedRecord } from '../types'

const HEADERS = [
  'ID анкеты',
  'Номер анкеты',
  'ID проекта',
  'Проект',
  'Телефон',
  'Статус анкеты',
  'Дата анкеты',
  'ID звонка',
  'Ссылка на запись',
  'Дата звонка',
  'Оператор',
  'Длительность (сек)',
]

function toRow(r: MatchedRecord): (string | number | null)[] {
  return [
    r.formId,
    r.formNumber,
    r.projectId,
    r.projectName,
    r.phone,
    r.formStatus,
    r.formCreatedAt,
    r.callId,
    r.recordingUrl,
    r.callDate,
    r.operator,
    r.duration,
  ]
}

export function exportToCsv(records: MatchedRecord[]): Buffer {
  const rows = [HEADERS, ...records.map(toRow)]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Данные')
  return XLSX.write(wb, { type: 'buffer', bookType: 'csv' })
}

export function exportToXlsx(records: MatchedRecord[]): Buffer {
  const rows = [HEADERS, ...records.map(toRow)]
  const sheet = XLSX.utils.aoa_to_sheet(rows)

  // Ширина колонок
  sheet['!cols'] = [
    { wch: 36 }, // ID анкеты
    { wch: 14 }, // Номер анкеты
    { wch: 36 }, // ID проекта
    { wch: 30 }, // Проект
    { wch: 16 }, // Телефон
    { wch: 14 }, // Статус
    { wch: 20 }, // Дата анкеты
    { wch: 36 }, // ID звонка
    { wch: 50 }, // Ссылка
    { wch: 20 }, // Дата звонка
    { wch: 24 }, // Оператор
    { wch: 18 }, // Длительность
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Данные')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}
