import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { MongoMemoryServer } from 'mongodb-memory-server'
import app from '../app.js'
import User from '../models/User.js'
import * as emailVerification from '../services/emailVerification.js'
import * as googlePhotos from '../services/googlePhotos.js'
import { authCookieOptions } from '../middleware/auth.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-tests'
process.env.CLIENT_URL = 'http://localhost:5173'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.GOOGLE_AUTH_REDIRECT_URI = 'http://localhost:5000/api/auth/google/callback'
process.env.GOOGLE_PHOTOS_REDIRECT_URI = 'http://localhost:5000/api/google/callback'
const sendOtpEmailMock = vi.spyOn(emailVerification, 'sendOtpEmail').mockResolvedValue(undefined)
const googleUrlMock = vi.spyOn(googlePhotos, 'createGoogleLoginAuthUrl').mockImplementation((state) => `https://accounts.google.test/auth?state=${state}`)
const googleExchangeMock = vi.spyOn(googlePhotos, 'exchangeGoogleLoginCode')

let mongoServer

const validUser = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'correct-password-1',
}

const register = (overrides = {}) => request(app)
  .post('/api/auth/register')
  .send({ ...validUser, ...overrides })

const startGoogleLogin = async (agent = request.agent(app)) => {
  const response = await agent.get('/api/auth/google')
  const cookie = response.headers['set-cookie'][0].split(';')[0]
  const state = new URL(response.headers.location).searchParams.get('state')
  return { agent, cookie, state, response }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
})

afterEach(async () => {
  await User.deleteMany({})
  googleExchangeMock.mockClear()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('authentication', () => {
  it('creates a verified Google user and issues the normal session cookies', async () => {
    googleExchangeMock.mockResolvedValueOnce({
      googleId: 'google-new',
      email: 'google-new@example.com',
      name: 'Google New',
      avatar: 'https://example.com/avatar.jpg',
    })
    const { agent, cookie, state } = await startGoogleLogin()

    const response = await agent
      .get(`/api/auth/google/callback?code=google-code&state=${state}`)
      .set('Cookie', cookie)

    const user = await User.findOne({ email: 'google-new@example.com' }).select('+passwordHash +googleId')
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('http://localhost:5173/gallery')
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('token='),
      expect.stringContaining('refreshToken='),
    ]))
    expect(user).toMatchObject({ googleId: 'google-new', authProvider: 'google', emailVerified: true })
    expect(user.passwordHash).toBeUndefined()
    expect(googleExchangeMock).toHaveBeenLastCalledWith('google-code', expect.any(String))
  })

  it('logs in an existing user by Google ID', async () => {
    const user = await User.create({ name: 'Existing', email: 'existing@example.com', googleId: 'google-existing', authProvider: 'google', emailVerified: true })
    googleExchangeMock.mockResolvedValueOnce({ googleId: 'google-existing', email: user.email, name: user.name })
    const { agent, cookie, state } = await startGoogleLogin()

    const response = await agent.get(`/api/auth/google/callback?code=code&state=${state}`).set('Cookie', cookie)

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('http://localhost:5173/gallery')
    expect(await User.countDocuments()).toBe(1)
  })

  it('links Google to an existing verified email', async () => {
    await User.create({ name: 'Password User', email: 'link@example.com', passwordHash: 'hash', authProvider: 'password', emailVerified: true })
    googleExchangeMock.mockResolvedValueOnce({ googleId: 'google-link', email: 'link@example.com', name: 'Google Name' })
    const { agent, cookie, state } = await startGoogleLogin()

    const response = await agent.get(`/api/auth/google/callback?code=code&state=${state}`).set('Cookie', cookie)

    const user = await User.findOne({ email: 'link@example.com' }).select('+googleId')
    expect(response.status).toBe(302)
    expect(user.googleId).toBe('google-link')
    expect(user.authProvider).toBe('google')
  })

  it('rejects an unverified Google email', async () => {
    googleExchangeMock.mockRejectedValueOnce(new Error('Invalid Google identity'))
    const { agent, cookie, state } = await startGoogleLogin()

    const response = await agent.get(`/api/auth/google/callback?code=code&state=${state}`).set('Cookie', cookie)

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('http://localhost:5173/login?error=google_failed')
    expect(await User.countDocuments()).toBe(0)
  })

  it('rejects a callback with a bad state without exchanging the code', async () => {
    const { agent, cookie } = await startGoogleLogin()

    const response = await agent.get('/api/auth/google/callback?code=code&state=wrong-state').set('Cookie', cookie)

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('http://localhost:5173/login?error=google_failed')
    expect(googleExchangeMock).not.toHaveBeenCalled()
  })

  it('registers with valid data', async () => {
    const response = await register()

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ verificationRequired: true, email: validUser.email })
    expect(response.body).not.toHaveProperty('passwordHash')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('rejects a duplicate email', async () => {
    await register()
    const response = await register({ name: 'Another User' })

    expect(response.status).toBe(400)
    expect(response.body).not.toHaveProperty('passwordHash')
  })

  it.each([
    [{ email: 'not-an-email' }, 'invalid email'],
    [{ password: 'short' }, 'short password'],
    [{ password: 'password123' }, 'common password'],
  ])('rejects registration with %s', async (overrides) => {
    const response = await register(overrides)

    expect(response.status).toBe(400)
  })

  it('logs in with correct credentials and sets an httpOnly cookie', async () => {
    await register()
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })

    expect(response.status).toBe(200)
    expect(response.body.user.email).toBe(validUser.email)
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('HttpOnly')]))
    expect(response.headers['set-cookie'].join(';')).toContain('SameSite=Strict')
  })

  it('stores passwords as bcrypt hashes and never as plaintext', async () => {
    await register()
    const user = await User.findOne({ email: validUser.email }).select('+passwordHash')

    expect(user.passwordHash).not.toBe(validUser.password)
    expect(user.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/)
    expect(await bcrypt.compare(validUser.password, user.passwordHash)).toBe(true)
  })

  it('rejects a wrong password with 401', async () => {
    await register()
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: 'wrong-password' })

    expect(response.status).toBe(401)
  })

  it('explains when a Google-only account has no password', async () => {
    await User.create({ name: 'Google User', email: 'google-only@example.com', authProvider: 'google', emailVerified: true })

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'google-only@example.com', password: 'correct-password-1' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      code: 'GOOGLE_ACCOUNT',
      message: 'This account uses Google login. Continue with Google instead.',
    })
  })

  it('uses the same response for an unknown email and a wrong password', async () => {
    await register()
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: 'wrong-password' })
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'unknown@example.com', password: 'wrong-password' })

    expect(unknownEmail.status).toBe(wrongPassword.status)
    expect(unknownEmail.body).toEqual(wrongPassword.body)
  })

  it('temporarily locks an account after repeated failed logins', async () => {
    await register()
    await User.updateOne({ email: validUser.email }, { emailVerified: true })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: validUser.email, password: 'wrong-password-1' })
    }

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })

    expect(response.status).toBe(401)
    expect(response.body.message).toBe('Unable to log in with those credentials. If your email is not verified, request a new code.')
  })

  it('does not allow an unverified user to log in', async () => {
    await register()
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Unable to log in')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('stores only a verification code hash for unverified users', async () => {
    await register()
    const verification = await User.findOne({ email: validUser.email }).select('+otpHash')
    expect(verification.emailVerified).toBe(false)
    expect(verification.otpHash).toBeTruthy()
  })

  it('sends the generated OTP through the mocked email sender', async () => {
    sendOtpEmailMock.mockClear()
    await register()

    expect(sendOtpEmailMock).toHaveBeenCalledOnce()
    expect(sendOtpEmailMock.mock.calls[0][0]).toBe(validUser.email)
    expect(sendOtpEmailMock.mock.calls[0][1]).toMatch(/^\d{6}$/)
  })

  it('verifies a valid code and clears the stored verification data', async () => {
    await register()
    const verification = emailVerification.createOtp()
    await User.updateOne(
      { email: validUser.email },
      {
        otpHash: verification.codeHash,
        otpExpiresAt: verification.expiresAt,
      },
    )

    const response = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email: validUser.email, otp: verification.code })

    const user = await User.findOne({ email: validUser.email }).select('+otpHash +otpExpiresAt')
    expect(response.status).toBe(200)
    expect(response.body.user.emailVerified).toBe(true)
    expect(user.emailVerified).toBe(true)
    expect(user.otpHash).toBeUndefined()
    expect(user.otpExpiresAt).toBeUndefined()
  })

  it('invalidates a code after five wrong attempts', async () => {
    await register()
    const verification = emailVerification.createOtp()
    await User.updateOne(
      { email: validUser.email },
      {
        otpHash: verification.codeHash,
        otpExpiresAt: verification.expiresAt,
      },
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/verify-otp')
        .send({ email: validUser.email, otp: '000000' })
      expect(response.status).toBe(400)
    }

    const user = await User.findOne({ email: validUser.email }).select('+otpHash +otpAttempts')
    expect(user.otpHash).toBeUndefined()
    expect(user.otpAttempts).toBe(5)
  })

  it('uses the same generic response for resend requests without an eligible account', async () => {
    const response = await request(app)
      .post('/api/auth/resend-otp')
      .send({ email: validUser.email })

    expect(response.status).toBe(202)
    expect(response.body.message).toBe('If the account can receive email, a verification code will be sent.')
  })

  it('returns the authenticated user from /me and rejects requests without a cookie', async () => {
    const agent = request.agent(app)
    await agent.post('/api/auth/register').send(validUser)
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    await agent.post('/api/auth/login').send({ email: validUser.email, password: validUser.password })

    const authenticatedResponse = await agent.get('/api/auth/me')
    const anonymousResponse = await request(app).get('/api/auth/me')

    expect(authenticatedResponse.status).toBe(200)
    expect(authenticatedResponse.body.user.email).toBe(validUser.email)
    expect(authenticatedResponse.body.user.googleConnected).toBe(false)
    expect(anonymousResponse.status).toBe(200)
    expect(anonymousResponse.body).toEqual({ user: null })
  })

  it('clears the cookie on logout', async () => {
    const agent = request.agent(app)
    await agent.post('/api/auth/register').send(validUser)
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    await agent.post('/api/auth/login').send({ email: validUser.email, password: validUser.password })

    const logoutResponse = await agent.post('/api/auth/logout')
    const meResponse = await agent.get('/api/auth/me')

    expect(logoutResponse.status).toBe(204)
    expect(logoutResponse.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/^token=;/)]))
    expect(meResponse.status).toBe(200)
    expect(meResponse.body).toEqual({ user: null })
  })

  it('invalidates an access token after logout', async () => {
    const loginResponse = await request(app)
      .post('/api/auth/register')
      .send(validUser)
    expect(loginResponse.status).toBe(201)
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    const authenticated = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })
    const accessCookie = authenticated.headers['set-cookie'].find((cookie) => cookie.startsWith('token=')).split(';')[0]

    await request(app).post('/api/auth/logout').set('Cookie', accessCookie)
    const replay = await request(app).get('/api/auth/me').set('Cookie', accessCookie)

    expect(replay.status).toBe(401)
  })

  it('rotates refresh tokens and rejects the previous token', async () => {
    await register()
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })
    const refreshCookie = loginResponse.headers['set-cookie'].find((cookie) => cookie.startsWith('refreshToken=')).split(';')[0]

    const refreshResponse = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie)
    const replayResponse = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie)

    expect(refreshResponse.status).toBe(200)
    expect(replayResponse.status).toBe(401)
  })

  it('sets Secure on authentication cookies in production', async () => {
    const previousEnvironment = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(authCookieOptions()).toEqual({
        httpOnly: true,
        sameSite: 'strict',
        secure: true,
      })
    } finally {
      process.env.NODE_ENV = previousEnvironment
    }
  })

  it('requires an origin signal for state-changing requests outside tests', async () => {
    const previousEnvironment = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const response = await request(app)
        .post('/api/auth/register')
        .send(validUser)

      expect(response.status).toBe(403)
      expect(response.body.message).toBe('Cross-site request blocked')
    } finally {
      process.env.NODE_ENV = previousEnvironment
    }
  })

  it('never returns the password hash in responses', async () => {
    const registerResponse = await register()
    await User.updateOne({ email: validUser.email }, { emailVerified: true })
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: validUser.email, password: validUser.password })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: validUser.email, password: validUser.password })
    const meResponse = await agent.get('/api/auth/me')

    expect(JSON.stringify(registerResponse.body)).not.toContain('passwordHash')
    expect(JSON.stringify(loginResponse.body)).not.toContain('passwordHash')
    expect(JSON.stringify(meResponse.body)).not.toContain('passwordHash')

    const storedUser = await User.findOne({ email: validUser.email }).select('+passwordHash')
    expect(storedUser.passwordHash).toBeTruthy()
    expect(storedUser.passwordHash).not.toBe(validUser.password)
  })
})
