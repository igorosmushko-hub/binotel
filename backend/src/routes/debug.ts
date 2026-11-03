import { Router } from 'express'
import axios from 'axios'
import { SimpleformsClient } from '../clients/simpleforms'
import { config } from '../config'

const router = Router()
const sf = new SimpleformsClient()

const SEVEN_LINE_BASE = 'https://1.7line.kz/wp-json/call-records/v1'

// Маскируем персональные данные: любая последовательность из 7+ цифр -> звёздочки (кроме последних 2).
function maskDigits(s: string): string {
  return s.replace(/\d{7,}/g, m => '*'.repeat(m.length - 2) + m.slice(-2))
}

function maskValue(v: unknown): unknown {
  if (typeof v === 'string') return maskDigits(v)
  if (typeof v === 'number') return maskDigits(String(v))
  if (Array.isArray(v)) return v.map(maskValue)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskValue(x)]))
  }
  return v
}

// Для ссылок показываем имена и значения query-параметров (значения замаскированы).
function describeUrl(s: string) {
  try {
    const u = new URL(s)
    return { host: u.host, path: maskDigits(u.pathname), params: Object.fromEntries([...u.searchParams.entries()].map(([k, v]) => [k, maskDigits(v)])) }
  } catch {
    return maskDigits(s)
  }
}

// GET /api/debug/columns?projectId=X — возвращает список столбцов первого globalOrder проекта
router.get('/columns', async (req, res) => {
  const { projectId } = req.query as { projectId?: string }
  if (!projectId) return res.status(400).json({ error: 'projectId required' })

  try {
    const globalOrders = await sf.getGlobalOrders(projectId)
    if (!globalOrders.length) return res.json({ columns: [], message: 'No globalOrders' })

    const go = globalOrders[0]
    const reportId = await sf.createReport(go.id)
    const report = await sf.waitForReport(reportId)
    const zipUrl: string = report.links?.[0]
    if (!zipUrl) return res.json({ columns: [], message: 'No zip URL in report' })

    const { columns } = await (sf as any).downloadReportZip(zipUrl)
    res.json({ globalOrderId: go.id, columns })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/debug/raw-calls?from=2026-10-25&to=2026-10-26&limit=3
// Сырой ответ 7Line /calls: список всех имён полей + первые N записей (телефоны замаскированы).
// Нужен, чтобы увидеть, есть ли в звонке поле вроде session id.
router.get('/raw-calls', async (req, res) => {
  const { from, to, limit } = req.query as { from?: string; to?: string; limit?: string }
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' })
  const n = Math.min(Math.max(parseInt(limit ?? '3', 10) || 3, 1), 10)

  try {
    const r = await axios.get(`${SEVEN_LINE_BASE}/calls`, {
      headers: { 'X-Api-Key': config.binatel.apiKey },
      params: { from, to, per_page: n, page: 1 },
      timeout: 60_000,
    })
    const data = r.data ?? {}
    const items: any[] = Array.isArray(data.items) ? data.items : []
    const keys = [...new Set(items.flatMap(i => Object.keys(i)))].sort()
    res.json({
      topLevelKeys: Object.keys(data),
      total: data.total ?? null,
      hasMore: data.hasMore ?? null,
      itemKeys: keys,
      items: items.slice(0, n).map(maskValue),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message, status: err.response?.status ?? null })
  }
})

// GET /api/debug/raw-form?projectId=X&limit=3
// Служебные колонки первых N анкет из отчёта SimpleForms (колонки вопросов S*/Q* пропускаем),
// телефоны замаскированы, у ссылок показаны имена параметров.
router.get('/raw-form', async (req, res) => {
  const { projectId, limit } = req.query as { projectId?: string; limit?: string }
  if (!projectId) return res.status(400).json({ error: 'projectId required' })
  const n = Math.min(Math.max(parseInt(limit ?? '3', 10) || 3, 1), 10)

  try {
    const globalOrders = await sf.getGlobalOrders(projectId)
    if (!globalOrders.length) return res.json({ message: 'No globalOrders' })

    const go = globalOrders[0]
    const reportId = await sf.createReport(go.id)
    const report = await sf.waitForReport(reportId)
    const zipUrl: string = report.links?.[0]
    if (!zipUrl) return res.json({ message: 'No zip URL in report' })

    const { columns, rows } = await (sf as any).downloadReportZip(zipUrl)
    const service: number[] = columns
      .map((c: string, i: number) => ({ c, i }))
      .filter(({ c }: { c: string }) => !/^(S|Q)\d/i.test(c))
      .map(({ i }: { i: number }) => i)

    const sample = rows.slice(0, n).map((row: any[]) =>
      Object.fromEntries(
        service.map(i => {
          const name = columns[i]
          const v = row[i]
          const out = typeof v === 'string' && /^https?:\/\//i.test(v) ? describeUrl(v) : maskValue(v)
          return [name, out]
        })
      )
    )
    res.json({ globalOrderId: go.id, rowsInReport: rows.length, serviceColumns: service.map(i => columns[i]), sample })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
