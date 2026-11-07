import crypto from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { authCookieOptions, requireAuth } from '../middleware/auth.js'
import { createGoogleAuthUrl, encryptGoogleToken, exchangeGoogleCode, isGooglePhotosConfigured } from '../services/googlePhotos.js'

const router = express.Router()
const stateCookie = 'google_oauth_state'
// OAuth redirects are cross-site by design; the random state value protects this short-lived cookie.
const stateCookieOptions = () => ({ ...authCookieOptions(), sameSite: 'lax', maxAge: 10 * 60 * 1000 })
const clientOrigin = process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173'

router.get('/auth', requireAuth, (_request, response) => {
  if (!isGooglePhotosConfigured()) {
    return response.status(503).json({ message: 'Google Photos import is not configured' })
  }

  const state = crypto.randomBytes(32).toString('hex')
  response.cookie(stateCookie, state, stateCookieOptions())
  return response.redirect(createGoogleAuthUrl(state))
})

router.get('/callback', async (request, response) => {
  const state = request.cookies?.[stateCookie]
  response.clearCookie(stateCookie, authCookieOptions())

  const token = request.cookies?.token
  if (!token) {
    return response.redirect(`${clientOrigin}/login`)
  }

  let userId
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).userId
  } catch {
    return response.redirect(`${clientOrigin}/login`)
  }

  if (!state || !request.query.state || state !== request.query.state) {
    return response.redirect(`${clientOrigin}/?google=error`)
  }
  if (request.query.error || typeof request.query.code !== 'string') {
    return response.redirect(`${clientOrigin}/?google=denied`)
  }

  try {
    const tokens = await exchangeGoogleCode(request.query.code)
    const refreshToken = tokens.refresh_token
    if (!refreshToken) {
      return response.redirect(`${clientOrigin}/?google=error`)
    }
    await User.findByIdAndUpdate(userId, { googleRefreshToken: encryptGoogleToken(refreshToken) })
    return response.redirect(`${clientOrigin}/?google=connected`)
  } catch {
    return response.redirect(`${clientOrigin}/?google=error`)
  }
})

export default router
