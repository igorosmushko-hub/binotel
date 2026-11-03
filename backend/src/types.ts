export interface SimpleForms_Form {
  id: string
  formNumber: string   // короткий номер анкеты (отображаемый операторам)
  projectId: string
  projectName: string
  phone: string        // нормализованный номер (+7XXXXXXXXXX)
  sessionId: string    // SessionID из ссылки на заполнение (= generalCallId звонка 7Line); '' если нет
  status: string       // "targeted" | "nontargeted" | "incomplete" | "defect" | "unknown"
  createdAt: string
}

export interface BinatelCall {
  callId: string
  generalCallId: string   // числовой ID звонка в дозвонщике (OKITOKI_342434 -> 342434)
  phone: string
  recordingUrl: string
  callDate: string
  operator: string
  duration: number    // секунды
}

export interface MatchedRecord {
  formId: string
  formNumber: string
  projectId: string
  projectName: string
  phone: string
  sessionId: string | null
  matchedBy: 'session' | 'phone' | null
  formStatus: string
  formCreatedAt: string
  callId: string | null
  recordingUrl: string | null
  callDate: string | null
  operator: string | null
  duration: number | null
}

export interface Project {
  id: string
  name: string
  status: number
}
