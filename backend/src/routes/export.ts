import { Router } from 'express'
import { SimpleformsClient } from '../clients/simpleforms'
import { createBinatelClient } from '../clients/binatel'
import { matchFormsWithCalls } from '../services/matcher'
import { exportToCsv, exportToXlsx } from '../services/exporter'

const router = Router()
const sf = new SimpleformsClient()
const binatel = createBinatelClient()

async function getMatchedRecords(projectIds: string[]) {
  const [projects, calls] = await Promise.all([
    Promise.all(projectIds.map(id => sf.getProject(id))),
    binatel.getCalls(),
  ])
  const allForms: import('../types').SimpleForms_Form[] = []
  for (const p of projects) {
    const forms = await sf.getForms(p.id, p.name)
    allForms.push(...forms)
  }
  return matchFormsWithCalls(allForms, calls)
}

function parseIds(raw?: string): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// GET /api/export/csv?projectIds=X,Y,Z
router.get('/csv', async (req, res) => {
  const projectIds = parseIds(req.query.projectIds as string)
  if (!projectIds.length) return res.status(400).json({ error: 'projectIds is required' })

  try {
    const records = await getMatchedRecords(projectIds)
    const buf = exportToCsv(records)
    const filename = `export_${projectIds.join('-')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buf)
  } catch (err: any) {
    console.error('GET /api/export/csv error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/export/xlsx?projectIds=X,Y,Z
router.get('/xlsx', async (req, res) => {
  const projectIds = parseIds(req.query.projectIds as string)
  if (!projectIds.length) return res.status(400).json({ error: 'projectIds is required' })

  try {
    const records = await getMatchedRecords(projectIds)
    const buf = exportToXlsx(records)
    const filename = `export_${projectIds.join('-')}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buf)
  } catch (err: any) {
    console.error('GET /api/export/xlsx error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
