import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-tests'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.GOOGLE_PHOTOS_REDIRECT_URI = 'http://localhost:5000/api/google/callback'
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'test-google-token-encryption-key-that-is-long-enough'

vi.mock('../services/googlePhotos.js', () => ({
  createGoogleAuthUrl: vi.fn((state) => `https://accounts.google.test/auth?state=${state}`),
  createGoogleLoginAuthUrl: vi.fn(),
  decryptGoogleToken: vi.fn((token) => token),
  exchangeGoogleCode: vi.fn(),
  exchangeGoogleLoginCode: vi.fn(),
  getGoogleAccessToken: vi.fn(async () => 'test-access-token'),
  encryptGoogleToken: vi.fn((token) => token),
  isGoogleLoginConfigured: vi.fn(() => false),
  isGooglePhotosConfigured: vi.fn(() => true),
  validateGoogleRedirectUris: vi.fn(),
}))

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    url: vi.fn(),
    uploader: { destroy: vi.fn(), upload_stream: vi.fn() },
  },
}))

vi.mock('../services/photoStorage.js', () => ({
  deleteCloudinaryPhoto: vi.fn(),
  getCloudinaryPhotoUrl: vi.fn((publicId) => `https://res.cloudinary.com/test-cloud/${publicId}.jpg`),
  getUserStorageUsage: vi.fn(async () => 0),
  maxStorageBytes: 1024 * 1024 * 1024,
  processAndStorePhoto: vi.fn(async (_buffer, filename) => ({
    cloudinaryPublicId: `pic-web/test/${filename}`,
    cloudinaryUrl: `https://res.cloudinary.com/test-cloud/${filename}.jpg`,
    size: 100,
  })),
}))

const { default: app } = await import('../app.js')
const { default: User } = await import('../models/User.js')
const { default: GooglePickerSession } = await import('../models/GooglePickerSession.js')

let mongoServer

const sessionCookie = (userId) => jwt.sign(
  { userId: userId.toString(), tokenVersion: 0, type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '15m', algorithm: 'HS256' },
)

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
})

afterEach(async () => {
  await User.deleteMany({})
  await GooglePickerSession.deleteMany({})
  vi.restoreAllMocks()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('Google Photos picker routes', () => {
  it('creates a picker session for an authorized user', async () => {
    const user = await User.create({
      name: 'Owner',
      email: 'owner@example.com',
      emailVerified: true,
      googleRefreshToken: 'encrypted-google-token',
    })
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'picker-session',
      pickerUri: 'https://photos.google.test/picker',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await request(app)
      .post('/api/photos/google/session')
      .set('Cookie', `token=${sessionCookie(user._id)}`)

    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      sessionId: 'picker-session',
    pickerUri: 'https://photos.google.test/picker/autoclose',
    })
    expect(await GooglePickerSession.exists({ sessionId: 'picker-session', owner: user._id })).not.toBeNull()
  })

  it('does not expose another user’s picker session', async () => {
    const owner = await User.create({ name: 'Owner', email: 'owner@example.com', emailVerified: true })
    const other = await User.create({ name: 'Other', email: 'other@example.com', emailVerified: true })
    await GooglePickerSession.create({ sessionId: 'private-session', owner: owner._id })

    const response = await request(app)
      .get('/api/photos/google/session/private-session')
      .set('Cookie', `token=${sessionCookie(other._id)}`)

    expect(response.status).toBe(404)
  })

  it('handles canceled Google authorization without creating a session', async () => {
    const user = await User.create({ name: 'Owner', email: 'owner@example.com', emailVerified: true, googleRefreshToken: 'encrypted-google-token' })
    const response = await request(app)
      .get('/api/google/callback?error=access_denied&state=state')
      .set('Cookie', [`token=${sessionCookie(user._id)}`, 'google_oauth_state=state'])

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('http://localhost:5173/?google=denied')
  })

  it('reports an expired Google picker session', async () => {
    const user = await User.create({ name: 'Owner', email: 'owner@example.com', emailVerified: true, googleRefreshToken: 'encrypted-google-token' })
    await GooglePickerSession.create({ sessionId: 'expired-session', owner: user._id })
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 404 }))

    const response = await request(app)
      .get('/api/photos/google/session/expired-session')
      .set('Cookie', `token=${sessionCookie(user._id)}`)

    expect(response.status).toBe(404)
    expect(response.body.message).toBe('The Google Photos picker session has expired')
  })

  it('imports selected images into the gallery and deletes the picker session', async () => {
    const user = await User.create({ name: 'Owner', email: 'owner@example.com', emailVerified: true, googleRefreshToken: 'encrypted-google-token' })
    await GooglePickerSession.create({ sessionId: 'ready-session', owner: user._id })
    const image = Buffer.from('selected-image')
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mediaItemsSet: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mediaItems: [{ mediaFile: { baseUrl: 'https://google.test/media', mimeType: 'image/jpeg', filename: 'selected.jpg' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(image, { status: 200, headers: { 'Content-Length': String(image.length) } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const response = await request(app)
      .post('/api/photos/google/import')
      .set('Cookie', `token=${sessionCookie(user._id)}`)
      .send({ sessionId: 'ready-session' })

    expect(response.status).toBe(201)
    expect(response.body.photos).toHaveLength(1)
    expect(await GooglePickerSession.exists({ sessionId: 'ready-session' })).toBeNull()
  })

  it('reports inaccessible selected media without exposing Google URLs', async () => {
    const user = await User.create({ name: 'Owner', email: 'owner@example.com', emailVerified: true, googleRefreshToken: 'encrypted-google-token' })
    await GooglePickerSession.create({ sessionId: 'inaccessible-session', owner: user._id })
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mediaItemsSet: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mediaItems: [{ mediaFile: { baseUrl: 'https://google.test/private', mimeType: 'image/jpeg', filename: 'private.jpg' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const response = await request(app)
      .post('/api/photos/google/import')
      .set('Cookie', `token=${sessionCookie(user._id)}`)
      .send({ sessionId: 'inaccessible-session' })

    expect(response.status).toBe(502)
    expect(response.body.message).toBe('No selected Google Photos could be imported')
    expect(response.body.failures[0].message).toContain('no longer accessible')
    expect(JSON.stringify(response.body)).not.toContain('google.test')
  })
})
