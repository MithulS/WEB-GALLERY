import { MongoMemoryServer } from 'mongodb-memory-server'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const mongo = await MongoMemoryServer.create()
const mongoUri = mongo.getUri('picweb')

console.log(`Local MongoDB ready at ${mongoUri}`)

const child = spawn(
  process.execPath,
  ['--watch', path.join(__dirname, 'index.js')],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      PIC_WEB_MONGO_URI: mongoUri,
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
  },
)

const shutdown = async () => {
  child.kill('SIGTERM')
  await mongo.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

child.on('exit', async (code) => {
  await mongo.stop()
  process.exit(code ?? 0)
})
