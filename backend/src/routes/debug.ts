import { Router } from 'express'
import { SimpleformsClient } from '../clients/simpleforms'

const router = Router()
const sf = new SimpleformsClient()

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

export default router
