import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import User from '../models/User.js'
import { authCookieOptions, requireAuth } from '../middleware/auth.js'
import { createOtp, isOtpResendAllowed, matchesOtp, maxOtpAttempts, maxOtpResendsPerHour, sendOtpEmail } from '../services/emailVerification.js'
import { createGoogleLoginAuthUrl, exchangeGoogleLoginCode, isGoogleLoginConfigured } from '../services/googlePhotos.js'

const router = express.Router()
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const cookieName = 'token'
const googleLoginStateCookie = 'google_login_state'
const maxNameLength = 100
const minPasswordLength = 10
const maxPasswordLength = 128
const maxLoginFailures = 5
const loginLockoutMs = 15 * 60 * 1000
const commonPasswords = new Set(['password123', 'password1234', 'qwerty1234', '1234567890', 'letmein123', 'welcome123', 'admin12345'])
const cookieOptions = () => ({
  ...authCookieOptions(),
  maxAge: 15 * 60 * 1000,
})
const refreshCookieOptions = () => ({ ...authCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 })
const genericLoginMessage = 'Unable to log in with those credentials. If your email is not verified, request a new code.'
const googleLoginFailureRedirect = () => `${process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173'}/login?error=google_failed`
const galleryRedirect = () => `${process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173'}/gallery`
const registerSchema = z.object({
  name: z.string().trim().min(1).max(maxNameLength),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(minPasswordLength).max(maxPasswordLength),
}).strict()
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(minPasswordLength).max(maxPasswordLength) }).strict()
const verificationSchema = z.object({ email: z.string().trim().toLowerCase().email(), otp: z.string().regex(/^\d{6}$/) }).strict()
const resendSchema = z.object({ email: z.string().trim().toLowerCase().email() }).strict()

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Try again later.' },
})
const googleAuthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many Google login attempts. Try again later.' },
})
const googleStateCookieOptions = () => ({
  ...authCookieOptions(),
  sameSite: 'lax',
  maxAge: 10 * 60 * 1000,
})

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
  googleConnected: Boolean(user.googleRefreshToken),
  emailVerified: user.emailVerified,
})

const hashRefreshToken = (token) => crypto.createHash('sha256').update(token).digest('hex')
const issueTokens = (user) => {
  const claims = { userId: user._id.toString(), tokenVersion: user.authTokenVersion, type: 'access' }
  const accessToken = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' })
  const refreshToken = jwt.sign({ ...claims, type: 'refresh', jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' })
  return { accessToken, refreshToken }
}

const setSessionCookies = async (user, response) => {
  const tokens = issueTokens(user)
  user.refreshTokenHash = hashRefreshToken(tokens.refreshToken)
  await user.save()
  response.cookie(cookieName, tokens.accessToken, cookieOptions())
  response.cookie('refreshToken', tokens.refreshToken, refreshCookieOptions())
}

const readGoogleLoginState = (value) => {
  try {
    if (!value) return null
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed.state !== 'string' || typeof parsed.codeVerifier !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

const statesMatch = (expected, actual) => {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

router.get('/google', googleAuthRateLimit, (request, response) => {
  if (!isGoogleLoginConfigured()) return response.redirect(googleLoginFailureRedirect())

  const state = crypto.randomBytes(32).toString('base64url')
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const cookieValue = Buffer.from(JSON.stringify({ state, codeVerifier })).toString('base64url')
  response.cookie(googleLoginStateCookie, cookieValue, googleStateCookieOptions())
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  return response.redirect(createGoogleLoginAuthUrl(state, codeChallenge))
})

router.get('/google/callback', googleAuthRateLimit, async (request, response) => {
  const stateCookie = request.cookies?.[googleLoginStateCookie]
  response.clearCookie(googleLoginStateCookie, authCookieOptions())
  const oauthState = readGoogleLoginState(stateCookie)

  if (
    !oauthState
    || !statesMatch(oauthState.state, request.query.state)
    || request.query.error
    || typeof request.query.code !== 'string'
  ) {
    return response.redirect(googleLoginFailureRedirect())
  }

  try {
    const identity = await exchangeGoogleLoginCode(request.query.code, oauthState.codeVerifier)
    let user = await User.findOne({ googleId: identity.googleId }).select('+authTokenVersion +refreshTokenHash +googleRefreshToken +passwordHash')

    if (!user) {
      user = await User.findOne({ email: identity.email }).select('+authTokenVersion +refreshTokenHash +googleRefreshToken +passwordHash')
      if (user) {
        if (!user.emailVerified) throw new Error('Cannot link Google to an unverified email')
        user.googleId = identity.googleId
        user.avatar = identity.avatar
        user.authProvider = 'google'
        await user.save()
      }
    }

    if (!user) {
      user = await User.create({
        name: identity.name,
        email: identity.email,
        googleId: identity.googleId,
        avatar: identity.avatar,
        authProvider: 'google',
        emailVerified: true,
      })
    }

    await setSessionCookies(user, response)
    return response.redirect(galleryRedirect())
  } catch (error) {
    console.error('Google sign-in callback failed:', error.response?.data?.error_description || error.message)
    return response.redirect(googleLoginFailureRedirect())
  }
})

router.post('/register', authRateLimit, async (request, response) => {
  const parsed = registerSchema.safeParse(request.body)

  if (!parsed.success || commonPasswords.has(parsed.data.password.toLowerCase())) {
    return response.status(400).json({ message: `Name, a valid email, and a password between ${minPasswordLength} and ${maxPasswordLength} characters are required` })
  }
  const { name: normalizedName, email: normalizedEmail, password } = parsed.data

  try {
    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser) {
      return response.status(400).json({ message: 'Unable to register with those details' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await User.create({
      name: normalizedName,
      email: normalizedEmail,
      passwordHash,
    })

    const otp = createOtp()
    user.otpHash = otp.codeHash
    user.otpExpiresAt = otp.expiresAt
    user.lastOtpSentAt = otp.sentAt
    await user.save()

    try {
      await sendOtpEmail(user.email, otp.code)
    } catch (error) {
      console.error(`Registration OTP email failed for ${user.email}:`, error.message)
      await User.deleteOne({ _id: user._id })
      return response.status(503).json({ message: 'Email verification is temporarily unavailable' })
    }

    return response.status(201).json({ verificationRequired: true, email: user.email })
  } catch (error) {
    if (error?.code === 11000) {
      return response.status(400).json({ message: 'Unable to register with those details' })
    }
    return response.status(500).json({ message: 'Unable to register user' })
  }
})

router.post('/login', authRateLimit, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body)

  if (!parsed.success) {
    return response.status(400).json({ message: `A valid email and a password between ${minPasswordLength} and ${maxPasswordLength} characters are required` })
  }
  const { email: normalizedEmail, password } = parsed.data

  try {
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash +googleRefreshToken +authTokenVersion +loginFailures +loginLockedUntil')
    if (user?.loginLockedUntil && user.loginLockedUntil > new Date()) {
      return response.status(401).json({ message: genericLoginMessage })
    }
    if (user && !user.passwordHash) {
      return response.status(401).json({ code: 'GOOGLE_ACCOUNT', message: 'This account uses Google login. Continue with Google instead.' })
    }
    const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false

    if (!user || !passwordMatches) {
      if (user) {
        user.loginFailures += 1
        if (user.loginFailures >= maxLoginFailures) user.loginLockedUntil = new Date(Date.now() + loginLockoutMs)
        await user.save()
      }
      return response.status(401).json({ message: genericLoginMessage })
    }
    if (!user.emailVerified) {
      return response.status(401).json({ code: 'EMAIL_UNVERIFIED', message: genericLoginMessage })
    }

    user.loginFailures = 0
    user.loginLockedUntil = undefined
    await setSessionCookies(user, response)
    return response.json({ user: publicUser(user) })
  } catch {
    return response.status(500).json({ message: 'Unable to log in' })
  }
})

router.post('/refresh', async (request, response) => {
  const token = request.cookies?.refreshToken
  if (!token) return response.status(401).json({ message: 'Invalid or expired token' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
    if (payload.type !== 'refresh') throw new Error('Invalid token')
    const user = await User.findById(payload.userId).select('+authTokenVersion +refreshTokenHash +googleRefreshToken')
    if (!user || !user.emailVerified || user.authTokenVersion !== payload.tokenVersion || user.refreshTokenHash !== hashRefreshToken(token)) {
      return response.status(401).json({ message: 'Invalid or expired token' })
    }
    await setSessionCookies(user, response)
    return response.json({ user: publicUser(user) })
  } catch {
    return response.status(401).json({ message: 'Invalid or expired token' })
  }
})

router.post('/verify-otp', authRateLimit, async (request, response) => {
  const parsed = verificationSchema.safeParse(request.body)
  if (!parsed.success) {
    return response.status(400).json({ message: 'A valid email and six-digit code are required' })
  }
  const { email: normalizedEmail, otp } = parsed.data

  try {
    const user = await User.findOne({ email: normalizedEmail }).select('+otpHash +otpExpiresAt +otpAttempts')
    if (!user || user.emailVerified || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
      return response.status(400).json({ code: 'OTP_EXPIRED', message: 'That verification code is invalid or expired' })
    }
    if (user.otpAttempts >= maxOtpAttempts) {
      return response.status(400).json({ code: 'OTP_TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Request a new verification code.' })
    }

    user.otpAttempts += 1
    if (!matchesOtp(otp, user.otpHash)) {
      if (user.otpAttempts >= maxOtpAttempts) {
        user.otpHash = undefined
        user.otpExpiresAt = undefined
      }
      await user.save()
      return response.status(400).json({
        code: user.otpAttempts >= maxOtpAttempts ? 'OTP_TOO_MANY_ATTEMPTS' : 'OTP_INVALID',
        message: user.otpAttempts >= maxOtpAttempts
          ? 'Too many incorrect attempts. Request a new verification code.'
          : 'That verification code is incorrect.',
      })
    }

    user.emailVerified = true
    user.otpHash = undefined
    user.otpExpiresAt = undefined
    user.otpAttempts = 0
    await user.save()

    return response.json({ user: publicUser(user) })
  } catch {
    return response.status(500).json({ message: 'Unable to verify email' })
  }
})

router.post('/resend-otp', authRateLimit, async (request, response) => {
  const parsed = resendSchema.safeParse(request.body)
  if (!parsed.success) {
    return response.status(400).json({ message: 'A valid email is required' })
  }
  const { email: normalizedEmail } = parsed.data

  try {
    const user = await User.findOne({ email: normalizedEmail }).select('+lastOtpSentAt +otpResends')
    const genericResponse = () => response.status(202).json({ message: 'If the account can receive email, a verification code will be sent.' })
    if (!user || user.emailVerified) return genericResponse()
    if (!isOtpResendAllowed(user.lastOtpSentAt)) {
      return genericResponse()
    }
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    user.otpResends = (user.otpResends || []).filter((sentAt) => sentAt > hourAgo)
    if (user.otpResends.length >= maxOtpResendsPerHour) {
      return genericResponse()
    }

    const otp = createOtp()
    await sendOtpEmail(user.email, otp.code)
    user.otpHash = otp.codeHash
    user.otpExpiresAt = otp.expiresAt
    user.lastOtpSentAt = otp.sentAt
    user.otpResends.push(otp.sentAt)
    user.otpAttempts = 0
    await user.save()
    return genericResponse()
  } catch (error) {
    console.error('Unable to send verification email:', error)
    return response.status(202).json({ message: 'If the account can receive email, a verification code will be sent.' })
  }
})

router.post('/logout', async (request, response) => {
  const token = request.cookies?.token
  try {
    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
      await User.findByIdAndUpdate(payload.userId, { $inc: { authTokenVersion: 1 }, $unset: { refreshTokenHash: 1 } })
    }
  } catch {
    // Logout remains successful even when the session is already invalid.
  }
  response.clearCookie(cookieName, authCookieOptions())
  response.clearCookie('refreshToken', authCookieOptions())
  return response.status(204).send()
})

router.get('/me', async (request, response, next) => {
  if (!request.cookies?.token) {
    return response.json({ user: null })
  }
  return requireAuth(request, response, next)
}, async (request, response) => {
  try {
    const user = await User.findById(request.user.userId).select('+googleRefreshToken')
    if (!user) {
      return response.status(401).json({ message: 'User no longer exists' })
    }
    return response.json({ user: publicUser(user) })
  } catch {
    return response.status(401).json({ message: 'Invalid authentication token' })
  }
})

export default router
