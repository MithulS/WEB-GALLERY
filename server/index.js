import './config/env.js'
import mongoose from 'mongoose'
import app from './app.js'
import { verifyEmailTransport } from './services/emailVerification.js'
import { validateGoogleRedirectUris } from './services/googlePhotos.js'

const port = process.env.PORT || 5000
const mongoUri = process.env.MONGO_URI
const jwtSecret = process.env.JWT_SECRET

const missing = []
if (!mongoUri) missing.push('MONGO_URI')
if (!jwtSecret) missing.push('JWT_SECRET')
else if (jwtSecret.length < 32) missing.push('JWT_SECRET (must be at least 32 characters)')
for (const variable of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  if (!process.env[variable]) missing.push(variable)
}

const googleSettingsPresent = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_AUTH_REDIRECT_URI',
  'GOOGLE_PHOTOS_REDIRECT_URI',
  'GOOGLE_TOKEN_ENCRYPTION_KEY',
].some((variable) => Boolean(process.env[variable]))
if (googleSettingsPresent) {
  try {
    validateGoogleRedirectUris()
  } catch (error) {
    missing.push(error.message)
  }
}

if (missing.length > 0) {
  throw new Error(`Missing required configuration: ${missing.join(', ')}`)
}

const startServer = async () => {
  await mongoose.connect(mongoUri)
  await verifyEmailTransport()
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`)
  })
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
