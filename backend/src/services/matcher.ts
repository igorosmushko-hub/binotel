import { SimpleForms_Form, BinatelCall, MatchedRecord } from '../types'
import { normalizePhone } from '../clients/simpleforms'

const RANGE_PADDING_MS = 3 * 86_400_000 // ±3 дня вокруг дат анкет

/**
 * Диапазон дат для загрузки звонков: от самой ранней до самой поздней анкеты
 * с запасом ±3 дня. Позволяет не выкачивать весь месяц звонков (40k+).
 */
export function formsDateRange(forms: SimpleForms_Form[]): { from: string; to: string } | null {
  const times = forms
    .map(f => new Date(f.createdAt).getTime())
    .filter(Number.isFinite)
  if (!times.length) return null
  return {
    from: new Date(Math.min(...times) - RANGE_PADDING_MS).toISOString(),
    to:   new Date(Math.max(...times) + RANGE_PADDING_MS).toISOString(),
  }
}

function normalizePhone10(raw: string): string {
  return normalizePhone(raw).slice(-10)
}

/**
 * Сопоставляет анкеты SF со звонками 7Line.
 *
 * 1. Основной ключ — SessionID из "Ссылки на заполнение" анкеты: он равен generalCallId звонка
 *    (проверено на проде: 190 из 196 звонков за двое суток). Точное совпадение, время не нужно.
 * 2. Если SessionID нет (старые проекты, CATI) — по последним 10 цифрам телефона и ближайшему
 *    по времени звонку, как раньше.
 */
export function matchFormsWithCalls(
  forms: SimpleForms_Form[],
  calls: BinatelCall[]
): MatchedRecord[] {
  // Индекс звонков по generalCallId и по полному callId
  const callsBySession = new Map<string, BinatelCall>()
  for (const call of calls) {
    if (call.generalCallId) callsBySession.set(call.generalCallId, call)
    if (call.callId) callsBySession.set(call.callId, call)
  }

  // Индекс звонков по нормализованному номеру (10 цифр)
  const callsByPhone = new Map<string, BinatelCall[]>()
  for (const call of calls) {
    const key = normalizePhone10(call.phone)
    if (!key) continue
    if (!callsByPhone.has(key)) callsByPhone.set(key, [])
    callsByPhone.get(key)!.push(call)
  }

  return forms.map(form => {
    let bestCall: BinatelCall | null = null
    let matchedBy: 'session' | 'phone' | null = null

    if (form.sessionId) {
      bestCall = callsBySession.get(form.sessionId) ?? null
      if (bestCall) matchedBy = 'session'
    }

    if (!bestCall) {
      const phoneKey = normalizePhone10(form.phone)
      const matchingCalls = phoneKey ? callsByPhone.get(phoneKey) ?? [] : []
      if (matchingCalls.length > 0) {
        const formTime = new Date(form.createdAt).getTime()
        bestCall = matchingCalls.reduce((best, call) => {
          const callTime = new Date(call.callDate).getTime()
          const bestTime = new Date(best.callDate).getTime()
          return Math.abs(callTime - formTime) < Math.abs(bestTime - formTime) ? call : best
        })
        matchedBy = 'phone'
      }
    }

    return {
      formId:        form.id,
      formNumber:    form.formNumber,
      projectId:     form.projectId,
      projectName:   form.projectName,
      phone:         form.phone,
      sessionId:     form.sessionId || null,
      matchedBy,
      formStatus:    form.status,
      formCreatedAt: form.createdAt,
      callId:        bestCall?.callId ?? null,
      recordingUrl:  bestCall ? `/api/recording/by-call/${encodeURIComponent(bestCall.callId)}` : null,
      callDate:      bestCall?.callDate ?? null,
      operator:      bestCall?.operator ?? null,
      duration:      bestCall?.duration ?? null,
    }
  })
}
