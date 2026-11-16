import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { MongoMemoryServer } from 'mongodb-memory-server'
import sharp from 'sharp'
import { v2 as cloudinary } from 'cloudinary'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-tests'
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
process.env.CLOUDINARY_API_KEY = 'test-key'
process.env.CLOUDINARY_API_SECRET = 'test-secret'

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: vi.fn((_options, callback) => ({
        end: vi.fn(() => callback(null, { public_id: _options.public_id })),
      })),
      destroy: vi.fn(async () => ({ result: 'ok' })),
    },
    url: vi.fn((publicId) => `https://res.cloudinary.com/test-cloud/image/authenticated/s--signature--/v1/${publicId}.jpg`),
  },
}))

import app from '../app.js'
import Photo from '../models/Photo.js'
import User from '../models/User.js'

let mongoServer

const makeImage = (width = 2000, height = 1000) => sharp({
  create: {
    width,
    height,
    channels: 3,
    background: { r: 190, g: 90, b: 55 },
  },
}).jpeg().toBuffer()

const registerAgent = async (user) => {
  const agent = request.agent(app)
  await agent.post('/api/auth/register').send(user).expect(201)
  await User.updateOne({ email: user.email }, { emailVerified: true })
  await agent.post('/api/auth/login').send({ email: user.email, password: user.password }).expect(200)
  return agent
}

const uploadImage = async (agent, image) => {
  const imageBuffer = image || await makeImage()
  return agent
    .post('/api/photos')
    .attach('photos', imageBuffer, { filename: 'sample.jpg', contentType: 'image/jpeg' })
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
})

afterEach(async () => {
  await Photo.deleteMany({})
  await User.deleteMany({})
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('photo routes', () => {
  it('rejects uploads without authentication', async () => {
    const response = await request(app)
      .post('/api/photos')
      .attach('photos', Buffer.from('not checked without auth'), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(401)
  })

  it('blocks unverified users from uploading with a clear error code', async () => {
    const agent = request.agent(app)
    const user = { name: 'Pending', email: 'pending@example.com', password: 'password-123' }
    await agent.post('/api/auth/register').send(user).expect(201)
    const storedUser = await User.findOne({ email: user.email }).select('+authTokenVersion')
    const accessToken = jwt.sign(
      { userId: storedUser._id.toString(), tokenVersion: storedUser.authTokenVersion, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' },
    )

    const response = await agent
      .post('/api/photos')
      .set('Cookie', `token=${accessToken}`)
      .attach('photos', await makeImage(), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(403)
    expect(response.body.code).toBe('EMAIL_UNVERIFIED')
  })

  it('uploads a valid image and stores Cloudinary metadata', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await uploadImage(agent)

    expect(response.status).toBe(201)
    const photo = await Photo.findById(response.body.photos[0]._id)

    expect(photo).not.toBeNull()
    expect(photo.cloudinaryPublicId).toMatch(/^pic-web\/.+\/[0-9a-f-]{36}$/)
    expect(photo.cloudinaryUrl).toContain('res.cloudinary.com')
    expect(photo.size).toBeGreaterThan(0)
  })

  it('preserves successful results when multiple uploads include a failed image', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .attach('photos', await makeImage(), { filename: 'valid.jpg', contentType: 'image/jpeg' })
      .attach('photos', Buffer.from('malformed'), { filename: 'invalid.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(207)
    expect(response.body.photos).toHaveLength(1)
    expect(response.body.failures).toHaveLength(1)
    expect(response.body.failures[0].filename).toBe('invalid.jpg')
  })

  it('reports an image-storage failure without creating a database record', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    cloudinary.uploader.upload_stream.mockImplementationOnce((_options, callback) => ({
      end: vi.fn(() => callback(new Error('Cloudinary unavailable'))),
    }))

    const response = await uploadImage(agent)

    expect(response.status).toBe(400)
    expect(response.body.message).toBe('No photos could be uploaded')
    expect(await Photo.countDocuments()).toBe(0)
  })

  it('stores a trimmed upload description on each uploaded photo', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .field('description', '  Weekend hike  ')
      .attach('photos', await makeImage(), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(201)
    expect(response.body.photos[0].description).toBe('Weekend hike')
    expect((await Photo.findById(response.body.photos[0]._id)).description).toBe('Weekend hike')
  })

  it('rejects an upload description over 500 characters', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .field('description', 'x'.repeat(501))
      .attach('photos', await makeImage(), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(400)
  })

  it('rejects a non-image file', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .attach('photos', Buffer.from('this is not an image'), { filename: 'notes.txt', contentType: 'text/plain' })

    expect(response.status).toBe(400)
  })

  it('rejects more than 20 files in one request', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const requestBuilder = agent.post('/api/photos')
    for (let index = 0; index < 21; index += 1) {
      requestBuilder.attach('photos', await makeImage(10, 10), { filename: `photo-${index}.jpg`, contentType: 'image/jpeg' })
    }

    const response = await requestBuilder
    expect(response.status).toBe(413)
    expect(response.body.message).toContain('up to 20')
  })

  it('rejects a spoofed image MIME type when the bytes are not an image', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .attach('photos', Buffer.from('not a jpeg'), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(400)
  })

  it('rejects malformed image bytes even with a supported extension', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .attach('photos', Buffer.from('not an image'), { filename: '../unsafe.jpg', contentType: 'application/octet-stream' })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('No photos could be uploaded')
  })

  it('rejects images exceeding the pixel dimensions limit', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await uploadImage(agent, await makeImage(10001, 1))

    expect(response.status).toBe(400)
  })

  it('processes images before Cloudinary upload', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const imageWithMetadata = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 190, g: 90, b: 55 },
      },
    }).withMetadata({ exif: { IFD0: { Copyright: 'GPS metadata' } } }).jpeg().toBuffer()
    const response = await uploadImage(agent, imageWithMetadata)
    expect(response.status).toBe(201)
    expect(response.body.photos[0].cloudinaryUrl).toContain('res.cloudinary.com')
  })

  it('blocks state-changing requests from another origin', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'https://attacker.example')
      .send({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })

    expect(response.status).toBe(403)
  })

  it('rejects a file larger than 10 MB', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const oversizedFile = Buffer.alloc((10 * 1024 * 1024) + 1, 0)
    const response = await agent
      .post('/api/photos')
      .attach('photos', oversizedFile, { filename: 'large.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(413)
  })

  it('enforces the per-user storage quota', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const user = await User.findOne({ email: 'owner@example.com' })
    await Photo.create({
      owner: user._id,
      originalFilename: 'existing.jpg',
      cloudinaryPublicId: 'pic-web/existing',
      cloudinaryUrl: 'https://res.cloudinary.com/test-cloud/existing.jpg',
      size: 1024 * 1024 * 1024,
    })

    const response = await uploadImage(agent)

    expect(response.status).toBe(413)
  })

  it('rejects unauthenticated photo listing and file access', async () => {
    const photoId = new mongoose.Types.ObjectId().toString()

    const listResponse = await request(app).get('/api/photos')
    const fileResponse = await request(app).get(`/api/photos/${photoId}/file`)
    const updateResponse = await request(app)
      .patch(`/api/photos/${photoId}`)
      .send({ description: 'Unauthenticated update' })

    expect(listResponse.status).toBe(401)
    expect(fileResponse.status).toBe(401)
    expect(updateResponse.status).toBe(401)
  })

  it('allows a logged-in user to list photos and receive image data', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id

    const listResponse = await agent.get('/api/photos')
    const fileResponse = await agent.get(`/api/photos/${photoId}/file`).redirects(0)

    expect(listResponse.status).toBe(200)
    expect(listResponse.headers['cache-control']).toBe('private, no-store')
    expect(listResponse.body.photos).toHaveLength(1)
    expect(listResponse.body.photos[0]._id).toBe(photoId)
    expect(fileResponse.status).toBe(302)
    expect(fileResponse.headers.location).toContain('res.cloudinary.com')
  })

  it('allows the owner to edit and sanitize a photo description', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id

    const response = await agent
      .patch(`/api/photos/${photoId}`)
      .send({ description: '  <strong>Sunset</strong>\u0000 over the lake  ' })

    expect(response.status).toBe(200)
    expect(response.body.photo.description).toBe('Sunset over the lake')
    expect((await Photo.findById(photoId)).description).toBe('Sunset over the lake')

    const refreshedGallery = await agent.get('/api/photos')
    expect(refreshedGallery.status).toBe(200)
    expect(refreshedGallery.body.photos.find((photo) => photo._id === photoId).description).toBe('Sunset over the lake')
  })

  it('rejects descriptions over 500 characters', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id

    const response = await agent
      .patch(`/api/photos/${photoId}`)
      .send({ description: 'x'.repeat(501) })

    expect(response.status).toBe(400)
  })

  it('prevents another user from editing the photo description', async () => {
    const ownerAgent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const otherAgent = await registerAgent({ name: 'Other', email: 'other@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(ownerAgent)
    const photoId = uploadResponse.body.photos[0]._id

    const response = await otherAgent.patch(`/api/photos/${photoId}`).send({ description: 'Not mine' })

    expect(response.status).toBe(404)
    expect((await Photo.findById(photoId)).description).toBe('')
  })

  it('allows another user to list and view shared photos', async () => {
    const ownerAgent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const otherAgent = await registerAgent({ name: 'Other', email: 'other@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(ownerAgent)
    const photoId = uploadResponse.body.photos[0]._id

    const listResponse = await otherAgent.get('/api/photos')
    const fileResponse = await otherAgent.get(`/api/photos/${photoId}/file`).redirects(0)

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.photos).toHaveLength(1)
    expect(fileResponse.status).toBe(302)
    expect(fileResponse.headers.location).toContain('res.cloudinary.com')
  })

  it('returns paginated gallery results', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    await uploadImage(agent)
    await uploadImage(agent)

    const response = await agent.get('/api/photos?page=2&limit=1')

    expect(response.status).toBe(200)
    expect(response.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 })
    expect(response.body.photos).toHaveLength(1)
  })

  it('prevents another user from deleting the photo', async () => {
    const ownerAgent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const otherAgent = await registerAgent({ name: 'Other', email: 'other@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(ownerAgent)
    const photoId = uploadResponse.body.photos[0]._id

    const response = await otherAgent.delete(`/api/photos/${photoId}`)

    expect(response.status).toBe(403)
    expect(await Photo.exists({ _id: photoId })).not.toBeNull()
  })

  it('allows the owner to delete the photo and its Cloudinary asset', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id
    const response = await agent.delete(`/api/photos/${photoId}`)

    expect(response.status).toBe(204)
    expect(await Photo.exists({ _id: photoId })).toBeNull()
  })

  it('returns not found when deleting a nonexistent photo', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent.delete(`/api/photos/${new mongoose.Types.ObjectId()}`)

    expect(response.status).toBe(404)
    expect(response.body.message).toBe('Photo not found')
  })

  it('keeps the database record when storage deletion fails', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id
    cloudinary.uploader.destroy.mockRejectedValueOnce(new Error('Cloudinary unavailable'))

    const response = await agent.delete(`/api/photos/${photoId}`)

    expect(response.status).toBe(500)
    expect(response.body.message).toBe('Unable to delete photo')
    expect(await Photo.exists({ _id: photoId })).not.toBeNull()
  })

  it('reports a database deletion failure after storage removal', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id
    vi.spyOn(Photo.prototype, 'deleteOne').mockRejectedValueOnce(new Error('Database unavailable'))

    const response = await agent.delete(`/api/photos/${photoId}`)

    expect(response.status).toBe(500)
    expect(response.body.message).toContain('storage was removed')
    expect(await Photo.exists({ _id: photoId })).not.toBeNull()
  })
})
