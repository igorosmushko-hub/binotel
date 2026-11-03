import express, { Router, Response } from 'express'
import { SimpleformsClient } from '../clients/simpleforms'
import { createBinatelClient } from '../clients/binatel'
import { matchFormsWithCalls, formsDateRange } from '../services/matcher'
import { createRecordingsArchive } from '../services/archiver'
import { parseFormListFile } from '../services/formListParser'
import { MatchedRecord, Project } from '../types'

const router = Router()
const sf = new SimpleformsClient()
const binatel = createBinatelClient()

async function loadRecords(projectIds: string[]): Promise<{ projects: Project[], records: MatchedRecord[] }> {
  const projects = await Promise.all(projectIds.map(id => sf.getProject(id)))

  // Анкеты SF — строго последовательно, иначе SF API возвращает 503
  const allForms: import('../types').SimpleForms_Form[] = []
  for (const p of projects) {
    const forms = await sf.getForms(p.id, p.name)
    allForms.push(...forms)
  }

  // Звонки качаем только за период дат анкет — не весь месяц
  const range = formsDateRange(allForms)
  const calls = range ? await binatel.getCalls(range.from, range.to) : []

  return { projects, records: matchFormsWithCalls(allForms, calls) }
}

function sendArchive(res: Response, records: MatchedRecord[], projects: Project[], reportLines: string[], partLabel?: string, downloadToken?: string) {
  const safeName = projects.map(p => p.name.replace(/[/\\:*?"<>|]/g, '_')).join('_')
  const suffix = partLabel ? `_part${partLabel}` : ''
  const fileName = `recordings_${safeName}${suffix}.zip`
  // В HTTP-заголовке допустим только ASCII: кириллицу передаём через filename* (RFC 5987)
  const asciiFileName = fileName.replace(/[^\x20-\x7E]/g, '_')
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition',
    `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)

  // Сигнал фронту, что сборка на сервере завершилась и начинается отдача файла —
  // фронт опрашивает эту cookie, чтобы убрать спиннер (см. archive-by-list в app.js)
  if (downloadToken) {
    res.cookie(`dl_${downloadToken}`, '1', { maxAge: 60_000, path: '/', sameSite: 'lax' })
  }

  const archiveStream = createRecordingsArchive(records, binatel, reportLines)
  archiveStream.pipe(res)

  archiveStream.on('error', (err) => {
    console.error('Archive stream error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  })
}

// GET /api/archive?projectIds=X,Y,Z — архив всех записей выбранных проектов
router.get('/', async (req, res) => {
  const projectIds = ((req.query.projectIds as string) ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

  if (!projectIds.length) return res.status(400).json({ error: 'projectIds is required' })

  try {
    const { projects, records } = await loadRecords(projectIds)
    const matchedCount = records.filter(r => r.callId).length

    if (matchedCount === 0) {
      return res.status(404).json({ error: 'Нет звонков для архивирования' })
    }

    sendArchive(res, records, projects, [])
  } catch (err: any) {
    console.error('GET /api/archive error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/archive — архив записей только по переданному списку номеров анкет.
// Body (urlencoded или json): projectIds="X,Y", formNumbers="101,102,...", part="1of4" (опц.)
router.post('/', async (req, res) => {
  const projectIds = String(req.body.projectIds ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const requestedNumbers = [...new Set(
    String(req.body.formNumbers ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  )]
  const partLabel = req.body.part ? String(req.body.part).replace(/[^0-9of]/g, '') : undefined
  const downloadToken = req.body.downloadToken ? String(req.body.downloadToken).replace(/[^a-zA-Z0-9]/g, '') : undefined

  if (!projectIds.length)       return res.status(400).json({ error: 'projectIds is required' })
  if (!requestedNumbers.length) return res.status(400).json({ error: 'formNumbers is required' })

  try {
    const { projects, records } = await loadRecords(projectIds)

    // Каждый элемент списка — номер анкеты, её длинный ID или ID звонка Binatel.
    // Номера сравниваем без ведущих нулей, ID — без учёта регистра.
    const normalize = (n: string) => n.replace(/^0+(?=\d)/, '').toLowerCase()
    const wanted = new Set(requestedNumbers.map(normalize))
    const filtered = records.filter(r =>
      (r.formNumber && wanted.has(normalize(r.formNumber))) ||
      (r.formId && wanted.has(normalize(r.formId))) ||
      (r.callId && wanted.has(normalize(r.callId)))
    )

    const foundKeys = new Set(filtered.flatMap(r =>
      [normalize(r.formNumber || ''), normalize(r.formId || ''), normalize(r.callId || '')]
    ))
    const notFound = requestedNumbers.filter(n => !foundKeys.has(normalize(n)))
    const noCall = filtered.filter(r => !r.callId)

    if (filtered.length - noCall.length === 0) {
      return res.status(404).json({ error: 'Ни для одного номера из списка не найдено записей звонков' })
    }

    const reportLines = [
      `Запрошено номеров: ${requestedNumbers.length}`,
      `Найдено анкет: ${filtered.length}`,
      `Со звонком (в архиве): ${filtered.length - noCall.length}`,
    ]
    if (notFound.length) {
      reportLines.push('', `Номера не найдены в выбранных проектах (${notFound.length}):`)
      notFound.forEach(n => reportLines.push(`  ${n}`))
    }
    if (noCall.length) {
      reportLines.push('', `Анкеты без сопоставленного звонка (${noCall.length}):`)
      noCall.forEach(r => reportLines.push(`  №${r.formNumber} (${r.formId})`))
    }

    sendArchive(res, filtered, projects, reportLines, partLabel, downloadToken)
  } catch (err: any) {
    console.error('POST /api/archive error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/archive/parse-file — извлекает номера/ID анкет из XLSX или CSV.
// Файл передаётся как сырое тело запроса (fetch с body: file).
router.post('/parse-file', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Файл пуст или не передан' })
  }
  try {
    const { numbers, ids } = parseFormListFile(req.body)
    if (!numbers.length && !ids.length) {
      return res.status(422).json({
        error: 'В файле не найдены колонки «Номер Анкеты» или «ID Анкеты»',
      })
    }
    res.json({ numbers, ids })
  } catch (err: any) {
    console.error('POST /api/archive/parse-file error:', err.message)
    res.status(422).json({ error: 'Не удалось прочитать файл — нужен XLSX или CSV' })
  }
})

export default router
