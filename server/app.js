import cors from 'cors'
import cookieParser from 'cookie-parser'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { sanitize as sanitizeMongo } from 'express-mongo-sanitize'
import authRoutes from './routes/auth.js'
import googleRoutes from './routes/google.js'
import photoRoutes from './routes/photos.js'

const app = express()
const clientOrigin = process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const stateChangingMethods = new Set(['POST', 'PATCH', 'DELETE'])

app.set('trust proxy', process.env.TRUST_PROXY || 1)
app.disable('x-powered-by')
app.use(cors({ origin: clientOrigin, credentials: true }))
app.use(cookieParser())
app.use((request, response, next) => {
  if (!stateChangingMethods.has(request.method)) return next()
  const origin = request.get('origin')
  let refererOrigin
  try {
    refererOrigin = request.get('referer') ? new URL(request.get('referer')).origin : undefined
  } catch {
    refererOrigin = undefined
  }
  const requestOrigin = origin || refererOrigin
  if ((requestOrigin && requestOrigin !== clientOrigin) || (!requestOrigin && process.env.NODE_ENV !== 'test')) {
    return response.status(403).json({ message: 'Cross-site request blocked' })
  }
  return next()
})
app.use(express.json({ limit: '100kb' }))
app.use((request, _response, next) => {
  request.body = sanitizeMongo(request.body)
  request.params = sanitizeMongo(request.params)
  const sanitizedQuery = sanitizeMongo(request.query)
  Object.keys(request.query).forEach((key) => delete request.query[key])
  Object.assign(request.query, sanitizedQuery)
  return next()
})
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}))
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, skip: () => process.env.NODE_ENV === 'test' }))
app.use('/api/auth', authRoutes)
app.use('/api/google', googleRoutes)
app.use('/api/photos', photoRoutes)

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    return next(error)
  }
  const statusCode = error.statusCode || 500
  // Never leak unexpected server error details to the client
  const message = statusCode < 500 ? error.message : 'Internal server error'
  return response.status(statusCode).json({ message })
})

export default app
