import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

export const config = {
  simpleforms: {
    apiKey: process.env.SIMPLEFORMS_API_KEY || '',
    apiBase: process.env.SIMPLEFORMS_API_BASE || 'https://api.simpleforms.ru',
    apiVersion: process.env.SIMPLEFORMS_API_VERSION || '1.0',
    timezoneOffset: process.env.TIMEZONE_OFFSET || '+05:00',
  },
  binatel: {
    apiKey: process.env.BINATEL_API_KEY || '',
    apiBase: process.env.BINATEL_API_BASE || '',
  },
  port: parseInt(process.env.PORT || '3000', 10),
}
