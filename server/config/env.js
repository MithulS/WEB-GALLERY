import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configDirectory = path.dirname(fileURLToPath(import.meta.url))
const serverDirectory = path.resolve(configDirectory, '..')
const runtimeMongoUri = process.env.PIC_WEB_MONGO_URI || process.env.MONGO_URI

dotenv.config({ path: path.join(serverDirectory, '.env') })
dotenv.config({ path: path.resolve(serverDirectory, '..', '.env'), override: true })

if (runtimeMongoUri) process.env.MONGO_URI = runtimeMongoUri
delete process.env.PIC_WEB_MONGO_URI
