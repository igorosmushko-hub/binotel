export interface SimpleForms_Form {
  id: string
  formNumber: string   // короткий номер анкеты (отображаемый операторам)
  projectId: string
  projectName: string
  phone: string        // нормализованный номер (+7XXXXXXXXXX)
  status: string       // "targeted" | "nontargeted" | "incomplete" | "defect" | "unknown"
  createdAt: string
}

export interface BinatelCall {
  callId: string
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
