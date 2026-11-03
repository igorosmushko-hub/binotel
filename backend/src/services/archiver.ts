import ArchiverLib from 'archiver'
import { Readable, PassThrough } from 'stream'
import { IBinatelClient } from '../clients/binatel'
import { MatchedRecord } from '../types'

// Сколько записей скачиваем одновременно (последовательно 3000+ записей не успевают в лимит Vercel;
// больше 5 — сервер 7line начинает отвечать 5xx)
const DOWNLOAD_CONCURRENCY = 5
const DOWNLOAD_RETRIES = 3

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Создаёт ZIP-архив аудиозаписей для совпавших анкет.
 * Файлы группируются в папку по имени проекта: {projectName}/{formId}__{formNumber}.mp3
 * Если переданы reportLines, в корень архива добавляется _отчёт.txt
 * (плюс список записей, которые не удалось скачать).
 * Возвращает PassThrough-поток, который можно напрямую передать в res.pipe().
 */
export function createRecordingsArchive(
  records: MatchedRecord[],
  binatelClient: IBinatelClient,
  reportLines: string[] = []
): PassThrough {
  const output = new PassThrough()
  const archive = ArchiverLib('zip', { zlib: { level: 5 } })

  archive.pipe(output)

  archive.on('error', err => output.destroy(err))

  const matched = records.filter(r => r.callId && r.recordingUrl)

  ;(async () => {
    const failed: MatchedRecord[] = []

    for (let i = 0; i < matched.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = matched.slice(i, i + DOWNLOAD_CONCURRENCY)
      const results = await Promise.all(batch.map(async record => {
        for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt++) {
          try {
            const audioStream = await binatelClient.downloadRecording(record.phone)
            return { record, buf: await streamToBuffer(audioStream) }
          } catch (err) {
            if (attempt < DOWNLOAD_RETRIES - 1) {
              await sleep(1000 * 2 ** attempt)
            } else {
              console.error(`Не удалось скачать запись ${record.callId}:`, err)
              failed.push(record)
            }
          }
        }
        return null
      }))

      for (const item of results) {
        if (!item) continue
        const { record, buf } = item
        const fileName = `${sanitize(record.formId)}__${sanitize(record.formNumber || 'без_номера')}.mp3`
        archive.append(buf, { name: `${sanitize(record.projectName)}/${fileName}` })
      }
    }

    if (reportLines.length || failed.length) {
      const lines = [...reportLines]
      if (failed.length) {
        lines.push('', `Не удалось скачать записи (${failed.length}):`)
        failed.forEach(r => lines.push(`  №${r.formNumber} (${r.formId}), звонок ${r.callId}`))
      }
      archive.append(lines.join('\n'), { name: '_отчёт.txt' })
    }

    await archive.finalize()
  })()

  return output
}
