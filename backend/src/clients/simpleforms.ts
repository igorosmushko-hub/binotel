import axios, { AxiosInstance } from 'axios'
import https from 'https'
import AdmZip from 'adm-zip'
import { config } from '../config'
import { Project, SimpleForms_Form } from '../types'

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('8') && digits.length === 11) return '7' + digits.slice(1)
  if (digits.startsWith('7') && digits.length === 11) return digits
  return digits // fallback
}

export class SimpleformsClient {
  private http: AxiosInstance

  constructor() {
    this.http = axios.create({
      baseURL: config.simpleforms.apiBase,
      headers: {
        'X-API-Key': config.simpleforms.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
      // SF API возвращает неполную цепочку SSL
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    })
  }

  private params(extra?: Record<string, unknown>): Record<string, unknown> {
    const p: Record<string, unknown> = { 'api-version': config.simpleforms.apiVersion }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) p[k] = v
      }
    }
    return p
  }

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await this.http.get<T>(path, { params: this.params(params) })
        return res.data
      } catch (err: any) {
        if (err?.response?.status === 503 && attempt < 4) {
          await sleep(3000 * (attempt + 1)) // экспоненциальная задержка: 3, 6, 9, 12 сек
          continue
        }
        throw err
      }
    }
    throw new Error(`GET ${path} failed after 5 attempts`)
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const res = await this.http.post<T>(path, body, { params: this.params() })
    return res.data
  }

  private async getAllPages<T>(path: string, params?: Record<string, unknown>, pageSize = 50): Promise<T[]> {
    const all: T[] = []
    let pageIndex = 0
    while (true) {
      const result = await this.get<{ data: T[]; totalPages: number }>(path, {
        ...params,
        pageSize,
        pageIndex,
      })
      all.push(...(result.data ?? []))
      if (pageIndex + 1 >= (result.totalPages ?? 1)) break
      pageIndex++
      await sleep(300)
    }
    return all
  }

  // ── Projects ──────────────────────────────────────────────────

  async getProjects(status?: number): Promise<Project[]> {
    return this.getAllPages<Project>('/api/projects', status !== undefined ? { status } : undefined)
  }

  async getProject(projectId: string): Promise<Project> {
    return this.get<Project>(`/api/projects/${projectId}`)
  }

  // ── Global Orders ─────────────────────────────────────────────

  async getGlobalOrders(projectId: string): Promise<any[]> {
    return this.getAllPages('/api/globalorders', { projectId })
  }

  // ── Reports (ZIP → columnar JSON) ─────────────────────────────

  /**
   * Создать отчёт по globalOrder.
   * entityType=1 (globalOrder) — единственный рабочий вариант.
   * timeZone НЕ передаём — вызывает 400.
   */
  async createReport(globalOrderId: string): Promise<string> {
    const result = await this.post<{ id: string }>('/api/reports/surveyReport/toJson', {
      objectId: globalOrderId,
      entityType: 1,
      includeServiceData: true,
      includeQuestionDuration: false,
      includeIncompleteSurveys: true,
      includeScreenerSurveys: true,
      includeDeclinedSurveys: true,
    })
    return result.id
  }

  async getReport(reportId: string): Promise<any> {
    return this.get(`/api/reports/${reportId}`)
  }

  async waitForReport(reportId: string, timeoutMs = 120_000, pollMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const report = await this.getReport(reportId)
      if (report.isCompleted) return report
      if (report.isFailed) throw new Error(`Report ${reportId} failed`)
      await sleep(pollMs)
    }
    throw new Error(`Report ${reportId} not ready within ${timeoutMs}ms`)
  }

  /**
   * Скачать ZIP отчёта и вернуть распарсенный JSON.
   * Формат: { columns: [{name}], data: [[...], ...] }
   */
  async downloadReportZip(zipUrl: string): Promise<{ columns: string[]; rows: any[][] }> {
    const res = await axios.get<ArrayBuffer>(zipUrl, {
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 120_000,
    })

    const zip = new AdmZip(Buffer.from(res.data))
    const entry = zip.getEntries().find(e => e.entryName.endsWith('.json'))
    if (!entry) throw new Error('JSON not found in report ZIP')

    const raw = entry.getData().toString('utf-8').replace(/^\uFEFF/, '') // strip BOM
    const parsed = JSON.parse(raw)

    const columns: string[] = (parsed.columns ?? []).map((c: any) => c.name ?? c)
    const rows: any[][] = parsed.data ?? []
    return { columns, rows }
  }

  /**
   * Получить анкеты проекта как нормализованные SimpleForms_Form.
   * Итерирует по всем globalOrders проекта.
   */
  async getForms(projectId: string, projectName: string): Promise<SimpleForms_Form[]> {
    const globalOrders = await this.getGlobalOrders(projectId)
    const allForms: SimpleForms_Form[] = []

    for (const go of globalOrders) {
      try {
        const reportId = await this.createReport(go.id)
        const report = await this.waitForReport(reportId)
        const zipUrl: string = report.links?.[0]
        if (!zipUrl) continue

        const { columns, rows } = await this.downloadReportZip(zipUrl)
        const forms = parseColumnarForms(rows, columns, projectId, projectName)
        allForms.push(...forms)
      } catch (err: any) {
        console.error(`Report error for globalOrder ${go.id}:`, err.message)
      }
    }

    return allForms
  }
}

// ── Парсинг колончатого формата ───────────────────────────────────────────────

function parseColumnarForms(
  rows: any[][],
  columns: string[],
  projectId: string,
  projectName: string
): SimpleForms_Form[] {
  const idx = (name: string) => columns.findIndex(c => c === name)

  const idxFormId     = 0                              // "ID Анкеты"
  // Case-insensitive поиск — SF может возвращать "Номер Анкеты" или "Номер анкеты"
  const idxFormNumber = columns.findIndex(c => c.toLowerCase() === 'номер анкеты')
  const idxTargeted   = idx('Целевая')                 // Да / Нет / Незавершённая
  const idxCheck      = idx('Проверка')                // Забракована / Принята / Не проверена
  const idxDate       = idx('Дата-время поступления на сервер (UTC)')
  const idxDateStart  = idx('Время начала')
  const idxPhone      = idx('Телефон')
  const idxId         = idx('ID')                      // для CAWI: содержит телефон
  const idxLink       = idx('Ссылка на заполнение')

  return rows.map(row => {
    const rawPhone = extractPhone(row, idxPhone, idxId, idxLink)
    const rawDate  = row[idxDate] || row[idxDateStart] || ''

    return {
      id:          String(row[idxFormId] ?? ''),
      formNumber:  idxFormNumber >= 0 ? String(row[idxFormNumber] ?? '') : '',
      projectId,
      projectName,
      phone:       formatPhone(normalizePhone(rawPhone)),
      status:      mapStatus(row[idxTargeted], row[idxCheck]),
      createdAt:   parseRuDate(rawDate),
    }
  }).filter(f => f.id)
}

/**
 * Вычислить итоговый статус анкеты из колонок "Целевая" и "Проверка".
 *
 * Значения из SF:
 *   Целевая: 'Да' | 'Нет' | 'Незавершённая'
 *   Проверка: 'Принята (автоматически)' | 'Не проверена' | 'Забракована'
 *
 * Итоговые статусы:
 *   'targeted'    — Целевая (Да)
 *   'nontargeted' — Нецелевая (Нет, не забракована)
 *   'incomplete'  — Незавершённая
 *   'defect'      — Брак (Проверка=Забракована)
 */
function mapStatus(targeted: any, check: any): string {
  const t = String(targeted ?? '').trim()
  const c = String(check ?? '').trim()
  if (c === 'Забракована') return 'defect'
  if (t === 'Да') return 'targeted'
  if (t === 'Нет') return 'nontargeted'
  if (t === 'Незавершённая') return 'incomplete'
  return 'unknown'
}

/**
 * Извлечь телефон из строки отчёта:
 * 1. Колонка "Телефон" (CATI)
 * 2. Колонка "ID" если похожа на номер (CAWI)
 * 3. Параметр Tell= из "Ссылка на заполнение" (CAWI)
 */
function extractPhone(row: any[], idxPhone: number, idxId: number, idxLink: number): string {
  if (idxPhone >= 0 && row[idxPhone]) return String(row[idxPhone])

  if (idxId >= 0 && row[idxId]) {
    const val = String(row[idxId]).replace(/\D/g, '')
    if (val.length >= 10 && val.length <= 12) return val
  }

  if (idxLink >= 0 && row[idxLink]) {
    const m = String(row[idxLink]).match(/Tell=(\d+)/)
    if (m) return m[1]
  }

  return ''
}

/**
 * Парсит русский формат даты "DD.MM.YYYY HH:MM:SS" → ISO string (UTC).
 */
function parseRuDate(raw: string): string {
  if (!raw) return ''
  // Формат: "08.07.2026 09:26:43"
  const m = String(raw).match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return raw
  const [, dd, mm, yyyy, hh, min, ss] = m
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`).toISOString()
}

function formatPhone(normalized: string): string {
  if (normalized.length === 11) return '+' + normalized
  if (normalized.length === 10) return '+7' + normalized
  return normalized
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
