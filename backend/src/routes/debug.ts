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

// GET /api/debug/session-probe?projectId=X&from=2026-10-26&to=2026-10-27
// Проверка гипотезы: SessionID из "Ссылки на заполнение" анкеты == generalCallId / callId звонка 7Line.
// Показывает статистику по параметрам ссылки и количество совпадений (значения замаскированы).
router.get('/session-probe', async (req, res) => {
  const { projectId, from, to } = req.query as { projectId?: string; from?: string; to?: string }
  if (!projectId || !from || !to) return res.status(400).json({ error: 'projectId, from, to (YYYY-MM-DD) required' })

  try {
    // 1) Анкеты
    const globalOrders = await sf.getGlobalOrders(projectId)
    if (!globalOrders.length) return res.json({ message: 'No globalOrders' })
    const go = globalOrders[0]
    const reportId = await sf.createReport(go.id)
    const report = await sf.waitForReport(reportId)
    const zipUrl: string = report.links?.[0]
    if (!zipUrl) return res.json({ message: 'No zip URL in report' })
    const { columns, rows } = await (sf as any).downloadReportZip(zipUrl)

    const iLink = columns.indexOf('Ссылка на заполнение')
    const iNum = columns.findIndex((c: string) => c.toLowerCase() === 'номер анкеты')
    const paramNames: Record<string, number> = {}
    const sessionIds: string[] = []
    const idValues: string[] = []
    let withLink = 0
    let sessionTest = 0

    for (const row of rows) {
      const link = iLink >= 0 ? row[iLink] : ''
      if (!link || typeof link !== 'string') continue
      withLink++
      let sp: URLSearchParams
      try { sp = new URL(link).searchParams } catch { continue }
      for (const k of sp.keys()) paramNames[k] = (paramNames[k] ?? 0) + 1
      const sid = [...sp.entries()].find(([k]) => k.toLowerCase() === 'sessionid')?.[1]
      const id = [...sp.entries()].find(([k]) => k.toLowerCase() === 'id')?.[1]
      if (sid !== undefined) {
        if (/^test$/i.test(sid) || sid === '') sessionTest++
        else sessionIds.push(sid)
      }
      if (id !== undefined && !/^test$/i.test(id) && id !== '') idValues.push(id)
    }

    const distinct = new Set(sessionIds)
    const nums = sessionIds.map(s => Number(s)).filter(Number.isFinite)
    const lenDist = (arr: string[]) => arr.reduce((m: Record<string, number>, s) => { const k = String(s.length); m[k] = (m[k] ?? 0) + 1; return m }, {})

    // 2) Звонки 7Line за окно
    const calls: any[] = []
    let page = 1
    let hasMore = true
    while (hasMore && page <= 8) {
      const r = await axios.get(`${SEVEN_LINE_BASE}/calls`, {
        headers: { 'X-Api-Key': config.binatel.apiKey },
        params: { from, to, per_page: 2000, page },
        timeout: 60_000,
      })
      const items: any[] = Array.isArray(r.data?.items) ? r.data.items : []
      calls.push(...items)
      hasMore = !!r.data?.hasMore
      page++
    }
    const gen = new Map<string, any>()
    const full = new Map<string, any>()
    for (const c of calls) {
      if (c.generalCallId != null) gen.set(String(c.generalCallId), c)
      if (c.callId != null) full.set(String(c.callId), c)
    }
    let byGeneral = 0, byFull = 0
    const matchedSample: any[] = []
    for (const s of distinct) {
      const hitG = gen.get(s)
      const hitF = full.get(s)
      if (hitG) byGeneral++
      if (hitF) byFull++
      if ((hitG || hitF) && matchedSample.length < 5) {
        const c = hitG || hitF
        matchedSample.push(maskValue({ sessionId: s, callId: c.callId, generalCallId: c.generalCallId, startTime: c.startTime, pbx: c.pbx, project: c.project }))
      }
    }
    const genNums = [...gen.keys()].map(Number).filter(Number.isFinite)

    res.json({
      form: { rowsInReport: rows.length, withLink, paramNames, formNumberColumn: iNum >= 0 },
      sessionId: {
        test: sessionTest,
        real: sessionIds.length,
        distinctReal: distinct.size,
        lengthDistribution: lenDist(sessionIds),
        numericRange: nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null,
        sample: sessionIds.slice(0, 8).map(maskDigits),
      },
      idParam: { real: idValues.length, lengthDistribution: lenDist(idValues), sample: idValues.slice(0, 5).map(maskDigits) },
      calls: {
        window: { from, to },
        fetched: calls.length,
        pagesRead: page - 1,
        truncated: hasMore,
        generalCallIdRange: genNums.length ? { min: Math.min(...genNums), max: Math.max(...genNums) } : null,
        sampleCallIds: calls.slice(0, 3).map(c => c.callId),
      },
      matches: { sessionIdEqualsGeneralCallId: byGeneral, sessionIdEqualsCallId: byFull, outOfDistinctReal: distinct.size },
      matchedSample,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message, status: err.response?.status ?? null })
  }
})

export default router
