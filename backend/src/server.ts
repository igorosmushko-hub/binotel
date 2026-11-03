import express from 'express'
import path from 'path'
import { config } from './config'

import projectsRouter from './routes/projects'
import formsRouter from './routes/forms'
import exportRouter from './routes/export'
import archiveRouter from './routes/archive'
import recordingRouter from './routes/recording'
import debugRouter from './routes/debug'

const app = express()

app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' })) // формы выгрузки архива по списку номеров

// Статические файлы frontend (includeFiles в vercel.json копирует их рядом)
app.use(express.static(path.resolve(__dirname, '../../frontend')))

// API routes
app.use('/api/projects', projectsRouter)
app.use('/api/forms', formsRouter)
app.use('/api/export', exportRouter)
app.use('/api/archive', archiveRouter)
app.use('/api/recording', recordingRouter)
app.use('/api/debug', debugRouter)

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../../frontend/index.html'))
})

// На Vercel listen не нужен — экспортируем app
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`)
  })
}

export default app
