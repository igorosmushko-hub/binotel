import axios, { AxiosInstance } from 'axios'
import { Readable } from 'stream'
import { config } from '../config'
import { BinatelCall } from '../types'

const SEVEN_LINE_BASE = 'https://1.7line.kz/wp-json/call-records/v1'
const MAX_DAYS = 31
const PAGE_CONCURRENCY = 6        // параллельных запросов страниц звонков
const CALLS_CACHE_TTL = 10 * 60_000
const CALLS_PER_PAGE = 2000       // стандартный лимит выдачи 7Line на страницу (максимум 5000 — только по спецсогласованию)

// Кэш списка звонков: при выгрузке архива частями каждый запрос иначе
// заново выкачивал бы все ~400 страниц. Модульный — общий для всех роутов.
let callsCache: { key: string; at: number; data: BinatelCall[] } | null = null

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface IBinatelClient {
  getCalls(dateFrom?: string, dateTo?: string): Promise<BinatelCall[]>
  getCallsByPhone(phone: string): Promise<BinatelCall[]>
  downloadRecording(phone: string): Promise<Readable>
  downloadRecordingByCallId(callId: string): Promise<Readable>
}

// ── Заглушка ──────────────────────────────────────────────────────────────────

export class MockBinatelClient implements IBinatelClient {
  private mockCalls: BinatelCall[] = [
    {
      callId: 'mock-001',
      generalCallId: '1',
      phone: '79001234567',
      recordingUrl: '',
      callDate: new Date().toISOString(),
      operator: 'Иванов И.И.',
      duration: 120,
    },
    {
      callId: 'mock-002',
      generalCallId: '2',
      phone: '79009876543',
      recordingUrl: '',
      callDate: new Date(Date.now() - 86400000).toISOString(),
      operator: 'Петрова А.С.',
      duration: 85,
    },
  ]

  async getCalls(_dateFrom?: string, _dateTo?: string): Promise<BinatelCall[]> {
    return this.mockCalls
  }

  async getCallsByPhone(phone: string): Promise<BinatelCall[]> {
    const normalized = phone.replace(/\D/g, '')
    return this.mockCalls.filter(c => c.phone.replace(/\D/g, '').endsWith(normalized.slice(-10)))
  }

  async downloadRecording(_phone: string): Promise<Readable> {
    const stream = new Readable({ read() {} })
    stream.push(null)
    return stream
  }

  async downloadRecordingByCallId(_callId: string): Promise<Readable> {
    return this.downloadRecording('')
  }
}

// ── 7Line / Фонетик API ───────────────────────────────────────────────────────

export class RealBinatelClient implements IBinatelClient {
  private http: AxiosInstance

  constructor() {
    this.http = axios.create({
      baseURL: SEVEN_LINE_BASE,
      headers: { 'X-Api-Key': config.binatel.apiKey },
      timeout: 60_000,
    })
  }

  /**
   * Получить звонки за диапазон дат.
   * Если диапазон > 31 дня — разбивает на чанки автоматически.
   * Если даты не переданы — берём последние 30 дней.
   * Возвращает только звонки с downloadReady=true.
   */
  async getCalls(dateFrom?: string, dateTo?: string): Promise<BinatelCall[]> {
    const from = dateFrom ? new Date(dateFrom) : daysAgo(30)
    const to   = dateTo   ? new Date(dateTo)   : new Date()

    const cacheKey = `${formatDate(from)}_${formatDate(to)}`
    if (callsCache && callsCache.key === cacheKey && Date.now() - callsCache.at < CALLS_CACHE_TTL) {
      return callsCache.data
    }

    // Если диапазон > 31 дня — разбиваем на чанки
    const chunks = splitDateRange(from, to, MAX_DAYS)
    const results: BinatelCall[] = []

    for (const [chunkFrom, chunkTo] of chunks) {
      const calls = await this.fetchPage(formatDate(chunkFrom), formatDate(chunkTo))
      results.push(...calls)
    }

    callsCache = { key: cacheKey, at: Date.now(), data: results }
    return results
  }

  // 7Line под нагрузкой периодически отвечает 5xx (508) — повторяем с паузой
  private async getCallsPage(from: string, to: string, page: number, attempt = 0): Promise<SevenLineResponse> {
    try {
      const res = await this.http.get<SevenLineResponse>('/calls', {
        params: { from, to, per_page: CALLS_PER_PAGE, page },
      })
      return res.data
    } catch (err) {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt)
        return this.getCallsPage(from, to, page, attempt + 1)
      }
      throw err
    }
  }

  private async fetchPage(from: string, to: string): Promise<BinatelCall[]> {
    const toCalls = (data: SevenLineResponse) =>
      (data.items ?? []).filter(c => c.downloadReady === true).map(mapCall)

    const first = await this.getCallsPage(from, to, 1)
    const all: BinatelCall[] = toCalls(first)

    if (!first.hasMore) return all

    if (first.total > 0) {
      // Знаем общее число страниц — качаем их параллельно
      const totalPages = Math.ceil(first.total / CALLS_PER_PAGE)
      const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2)
      for (let i = 0; i < pages.length; i += PAGE_CONCURRENCY) {
        const batch = pages.slice(i, i + PAGE_CONCURRENCY)
        const results = await Promise.all(batch.map(p => this.getCallsPage(from, to, p)))
        results.forEach(data => all.push(...toCalls(data)))
      }
      return all
    }

    // Фолбэк, если API не вернуло total: постранично по hasMore
    let page = 2
    while (true) {
      const data = await this.getCallsPage(from, to, page)
      all.push(...toCalls(data))
      if (!data.hasMore) break
      page++
    }
    return all
  }

  /**
   * Звонки по конкретному номеру через /records/by-phone.
   */
  async getCallsByPhone(phone: string): Promise<BinatelCall[]> {
    const digits = phone.replace(/\D/g, '')
    const res = await this.http.get<ByPhoneResponse>('/records/by-phone', {
      params: { phone: digits, limit: 100 },
    })
    return (res.data.items ?? []).map(mapCall)
  }

  /**
   * Скачать аудиозапись: GET /recording?phone=XXX → бинарный поток MP3.
   * Если по номеру было несколько звонков, 7Line отдаёт запись самого свежего —
   * при подавляющем большинстве анкет на номер приходится ровно один звонок, так что это ок.
   */
  async downloadRecording(phone: string): Promise<Readable> {
    const res = await this.http.get('/recording', {
      params: { phone: phone.replace(/\D/g, '') },
      responseType: 'stream',
    })
    return res.data as Readable
  }

  /**
   * Скачать аудиозапись конкретного звонка: GET /recording?callId=OKITOKI_342434.
   * Точнее, чем по телефону: по телефону 7Line отдаёт запись самого свежего звонка.
   */
  async downloadRecordingByCallId(callId: string): Promise<Readable> {
    const res = await this.http.get('/recording', {
      params: { callId },
      responseType: 'stream',
    })
    return res.data as Readable
  }
}

// ── Типы ответа 7Line ─────────────────────────────────────────────────────────

interface SevenLineCall {
  callId?: string | number
  generalCallId?: string | number
  id?: string | number
  phone?: string
  startTime?: string          // "2026-10-26 21:28:54" в часовом поясе timeZone
  timeZone?: string
  operatorName?: string
  billsec?: string | number
  talkDurationSec?: string | number
  call_type?: string       // "inbound" | "outbound"
  outboundPrefix?: string
  rawDialedNumber?: string
  date?: string
  callDate?: string
  created_at?: string
  operator?: string
  agent?: string
  agentName?: string
  duration?: number
  downloadReady?: boolean
}

interface SevenLineResponse {
  status: string
  items: SevenLineCall[]
  hasMore: boolean
  total: number
}

interface ByPhoneResponse {
  status: string
  items: SevenLineCall[]
}

// ── helpers ───────────────────────────────────────────────────────────────────

// "2026-10-26 21:28:54" (время в поясе звонка) -> ISO UTC. Пояс берём из конфига (по умолчанию +05:00).
function parseCallStart(c: SevenLineCall): string {
  const raw = String(c.startTime ?? '')
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/)
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${config.simpleforms.timezoneOffset}`)
    if (Number.isFinite(d.getTime())) return d.toISOString()
  }
  return String(c.date ?? c.callDate ?? c.created_at ?? '')
}

export function mapCall(c: SevenLineCall): BinatelCall {
  const id = String(c.callId ?? c.id ?? '')
  // generalCallId — числовой ID звонка в дозвонщике; он же приходит в SessionID анкеты.
  // Если поля нет, берём числовой хвост callId (OKITOKI_342434 -> 342434).
  const general = String(c.generalCallId ?? id.match(/(\d+)$/)?.[1] ?? '')
  return {
    callId:        id,
    generalCallId: general,
    phone:         String(c.phone ?? ''),
    recordingUrl:  `${SEVEN_LINE_BASE}/recording?callId=${id}`,
    callDate:      parseCallStart(c),
    operator:      String(c.operatorName ?? c.operator ?? c.agent ?? c.agentName ?? ''),
    duration:      Number(c.talkDurationSec ?? c.billsec ?? c.duration ?? 0),
  }
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}

/**
 * Разбивает диапазон дат на чанки не длиннее maxDays.
 */
function splitDateRange(from: Date, to: Date, maxDays: number): [Date, Date][] {
  const chunks: [Date, Date][] = []
  let cur = new Date(from)

  while (cur < to) {
    const end = new Date(cur)
    end.setDate(end.getDate() + maxDays - 1)
    if (end > to) end.setTime(to.getTime())
    chunks.push([new Date(cur), new Date(end)])
    cur.setDate(cur.getDate() + maxDays)
  }

  return chunks
}

// ── Фабрика ───────────────────────────────────────────────────────────────────

export function createBinatelClient(): IBinatelClient {
  if (config.binatel.apiKey) {
    return new RealBinatelClient()
  }
  return new MockBinatelClient()
}
