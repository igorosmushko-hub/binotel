import { Router } from 'express'
import { createBinatelClient } from '../clients/binatel'

const router = Router()
const binatel = createBinatelClient()

// GET /api/recording/by-call/:callId — запись конкретного звонка (callId вида OKITOKI_342434)
router.get('/by-call/:callId', async (req, res) => {
  const { callId } = req.params
  try {
    const stream = await binatel.downloadRecordingByCallId(callId)
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Disposition', `inline; filename="${callId.replace(/[^\w.-]/g, '_')}.mp3"`)
    stream.pipe(res)
  } catch (err: any) {
    console.error('GET /api/recording/by-call error:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

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
