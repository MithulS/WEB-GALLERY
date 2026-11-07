import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { MongoMemoryServer } from 'mongodb-memory-server'
import sharp from 'sharp'
import app from '../app.js'
import Photo from '../models/Photo.js'
import User from '../models/User.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-tests'

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

  it('uploads a valid image and stores a resized JPEG', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await uploadImage(agent)

    expect(response.status).toBe(201)
    const photo = await Photo.findById(response.body.photos[0]._id)
    const gridfsFile = await mongoose.connection.db.collection('photos.files').findOne({ _id: photo.gridfsFileId })
    const storedImage = await new Promise((resolve, reject) => {
      const chunks = []
      const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'photos' }).openDownloadStream(photo.gridfsFileId)
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
    const metadata = await sharp(storedImage).metadata()

    expect(photo).not.toBeNull()
    expect(gridfsFile.filename).toMatch(/^[0-9a-f-]{36}\.jpg$/)
    expect(gridfsFile.length).toBeGreaterThan(0)
    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(1600)
    expect(metadata.height).toBe(800)
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

  it('rejects a spoofed image MIME type when the bytes are not an image', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await agent
      .post('/api/photos')
      .attach('photos', Buffer.from('not a jpeg'), { filename: 'sample.jpg', contentType: 'image/jpeg' })

    expect(response.status).toBe(400)
  })

  it('rejects images exceeding the pixel dimensions limit', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const response = await uploadImage(agent, await makeImage(10001, 1))

    expect(response.status).toBe(400)
  })

  it('strips EXIF metadata from stored images', async () => {
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
    const photo = await Photo.findById(response.body.photos[0]._id)
    const storedFile = await new Promise((resolve, reject) => {
      const chunks = []
      const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'photos' }).openDownloadStream(photo.gridfsFileId)
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })

    expect((await sharp(storedFile).metadata()).exif).toBeUndefined()
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
      gridfsFileId: new mongoose.Types.ObjectId(),
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
    const fileResponse = await agent.get(`/api/photos/${photoId}/file`).buffer(true)

    expect(listResponse.status).toBe(200)
    expect(listResponse.headers['cache-control']).toBe('private, no-store')
    expect(listResponse.body.photos).toHaveLength(1)
    expect(listResponse.body.photos[0]._id).toBe(photoId)
    expect(fileResponse.status).toBe(200)
    expect(fileResponse.headers['cache-control']).toBe('private, no-store')
    expect(fileResponse.headers['content-type']).toContain('image/jpeg')
    expect(fileResponse.body.length).toBeGreaterThan(0)
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

  it('prevents another user from listing or viewing the photo by changing its id', async () => {
    const ownerAgent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const otherAgent = await registerAgent({ name: 'Other', email: 'other@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(ownerAgent)
    const photoId = uploadResponse.body.photos[0]._id

    const listResponse = await otherAgent.get('/api/photos')
    const fileResponse = await otherAgent.get(`/api/photos/${photoId}/file`).buffer(true)

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.photos).toHaveLength(0)
    expect(fileResponse.status).toBe(403)
    expect(fileResponse.headers['cache-control']).toBe('private, no-store')
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

  it('allows the owner to delete the photo and its GridFS file', async () => {
    const agent = await registerAgent({ name: 'Owner', email: 'owner@example.com', password: 'password-123' })
    const uploadResponse = await uploadImage(agent)
    const photoId = uploadResponse.body.photos[0]._id
    const photo = await Photo.findById(photoId)

    const response = await agent.delete(`/api/photos/${photoId}`)
    const gridfsFile = await mongoose.connection.db.collection('photos.files').findOne({ _id: photo.gridfsFileId })

    expect(response.status).toBe(204)
    expect(await Photo.exists({ _id: photoId })).toBeNull()
    expect(gridfsFile).toBeNull()
  })
})
