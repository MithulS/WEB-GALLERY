import crypto from 'node:crypto'
import { google } from 'googleapis'

export const googlePhotosScope = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'

const getConfig = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
})

export const isGooglePhotosConfigured = () => {
  const { clientId, clientSecret } = getConfig()
  const redirectUri = process.env.GOOGLE_PHOTOS_REDIRECT_URI
  return Boolean(clientId && clientSecret && redirectUri && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY?.length >= 32)
}

const createOAuthClient = (redirectUri = process.env.GOOGLE_PHOTOS_REDIRECT_URI) => {
  const { clientId, clientSecret } = getConfig()
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

export const createGoogleAuthUrl = (state) => {
  const client = createOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    prompt: 'consent',
    scope: [googlePhotosScope],
    state,
  })
}

export const exchangeGoogleCode = async (code) => {
  const client = createOAuthClient()
  const { tokens } = await client.getToken(code)
  return tokens
}

const encryptionKey = () => crypto.createHash('sha256').update(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY).digest()

export const encryptGoogleToken = (token) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv, authTag, encrypted].map((value) => value.toString('base64url')).join('.')
}

export const decryptGoogleToken = (value) => {
  const [ivValue, authTagValue, encryptedValue] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}

export const getGoogleAccessToken = async (refreshToken) => {
  const client = createOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('Google did not return an access token')
  return token
}

export const googleLoginScope = ['openid', 'email', 'profile']

export const isGoogleLoginConfigured = () => {
  const { clientId, clientSecret } = getConfig()
  return Boolean(clientId && clientSecret && process.env.GOOGLE_AUTH_REDIRECT_URI)
}

export const createGoogleLoginAuthUrl = (state, codeChallenge) => {
  const client = createOAuthClient(process.env.GOOGLE_AUTH_REDIRECT_URI)
  return client.generateAuthUrl({
    access_type: 'online',
    include_granted_scopes: false,
    prompt: 'select_account',
    scope: googleLoginScope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
}

export const exchangeGoogleLoginCode = async (code, codeVerifier) => {
  const client = createOAuthClient(process.env.GOOGLE_AUTH_REDIRECT_URI)
  const { tokens } = await client.getToken({ code, codeVerifier })
  if (!tokens.id_token) throw new Error('Google did not return an ID token')
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  const validIssuer = payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com'
  if (
    !payload
    || !validIssuer
    || payload.aud !== process.env.GOOGLE_CLIENT_ID
    || !payload.exp
    || payload.exp * 1000 <= Date.now()
    || payload.email_verified !== true
    || typeof payload.sub !== 'string'
    || typeof payload.email !== 'string'
  ) {
    throw new Error('Invalid Google identity')
  }
  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : payload.email,
    avatar: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

export const validateGoogleRedirectUris = () => {
  const entries = [
    ['GOOGLE_AUTH_REDIRECT_URI', process.env.GOOGLE_AUTH_REDIRECT_URI, '/api/auth/google/callback'],
    ['GOOGLE_PHOTOS_REDIRECT_URI', process.env.GOOGLE_PHOTOS_REDIRECT_URI, '/api/google/callback'],
  ]
  for (const [name, value, pathname] of entries) {
    if (!value) throw new Error(`${name} is required`)
    let url
    try {
      url = new URL(value)
    } catch {
      throw new Error(`${name} must be a valid URL`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== pathname || url.search || url.hash || value.endsWith('/')) {
      throw new Error(`${name} must be a URL ending exactly with ${pathname}`)
    }
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error(`${name} must use HTTPS in production`)
    }
    if (process.env.NODE_ENV !== 'production' && (url.protocol !== 'http:' || url.port !== '5000')) {
      throw new Error(`${name} must use http:// on port 5000 outside production`)
    }
  }
}
