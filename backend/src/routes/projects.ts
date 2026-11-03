import { Router } from 'express'
import { SimpleformsClient } from '../clients/simpleforms'

const router = Router()
const sf = new SimpleformsClient()

// GET /api/projects
router.get('/', async (_req, res) => {
  try {
    const projects = await sf.getProjects()
    res.json(projects)
  } catch (err: any) {
    console.error('GET /api/projects error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
