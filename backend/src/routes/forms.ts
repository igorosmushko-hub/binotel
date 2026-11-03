import { Router } from 'express'
import { SimpleformsClient } from '../clients/simpleforms'
import { createBinatelClient } from '../clients/binatel'
import { matchFormsWithCalls, formsDateRange } from '../services/matcher'
import { SimpleForms_Form, MatchedRecord } from '../types'

const router = Router()
const sf = new SimpleformsClient()
const binatel = createBinatelClient()

// GET /api/forms?projectIds=X,Y,Z
router.get('/', async (req, res) => {
  const { projectIds: raw } = req.query as { projectIds?: string }

  const projectIds = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!projectIds.length) {
    return res.status(400).json({ error: 'projectIds is required' })
  }

  try {
    const projects = await Promise.all(projectIds.map(id => sf.getProject(id)))

    // Анкеты SF — строго последовательно, иначе SF API возвращает 503
    const allForms: SimpleForms_Form[] = []
    for (const p of projects) {
      const forms = await sf.getForms(p.id, p.name)
      allForms.push(...forms)
    }

    // Звонки качаем только за период дат анкет — не весь месяц
    const range = formsDateRange(allForms)
    const calls = range ? await binatel.getCalls(range.from, range.to) : []

    const records: MatchedRecord[] = matchFormsWithCalls(allForms, calls)
    res.json(records)
  } catch (err: any) {
    console.error('GET /api/forms error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
