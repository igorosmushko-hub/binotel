import { Router } from 'express'
import { createBinatelClient } from '../clients/binatel'

const router = Router()
const binatel = createBinatelClient()

// GET /api/recording/:phone — прокси аудиозаписи из 7Line (нужен X-Api-Key, браузер не может сам)
router.get('/:phone', async (req, res) => {
  const { phone } = req.params
  try {
    const stream = await binatel.downloadRecording(phone)
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Disposition', `inline; filename="${phone}.mp3"`)
    stream.pipe(res)
  } catch (err: any) {
    console.error('GET /api/recording error:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

export default router
