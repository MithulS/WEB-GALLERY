import express from 'express'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import mongoose from 'mongoose'
import { z } from 'zod'
import Photo from '../models/Photo.js'
import User from '../models/User.js'
import GooglePickerSession from '../models/GooglePickerSession.js'
import { requireAuth } from '../middleware/auth.js'
import { decryptGoogleToken, getGoogleAccessToken } from '../services/googlePhotos.js'
import { deleteGridFsFile, findGridFsFile, getUserStorageUsage, maxStorageBytes, openGridFsDownload, processAndStorePhoto } from '../services/photoStorage.js'

const router = express.Router()
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const maxFileSize = 10 * 1024 * 1024
const maxFilesPerUpload = 20
const maxDescriptionLength = 500
const descriptionSchema = z.object({ description: z.string().max(maxDescriptionLength) }).strict()
const uploadDescriptionSchema = z.object({ description: z.string().max(maxDescriptionLength) }).strict()
const googleImportSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: maxFilesPerUpload },
  fileFilter: (_request, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error('Only JPEG, PNG, and WebP images are allowed'))
    }
    return callback(null, true)
  },
})

const parseUploads = (request, response, next) => {
  upload.array('photos', maxFilesPerUpload)(request, response, (error) => {
    if (!error) {
      return next()
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ message: 'Each image must be 10 MB or smaller' })
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
      return response.status(413).json({ message: `You can upload up to ${maxFilesPerUpload} images at a time` })
    }

    return response.status(400).json({ message: 'Invalid photo upload' })
  })
}

const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many uploads. Try again later.' },
})

const assertStorageQuota = async (ownerId, additionalBytes) => {
  const used = await getUserStorageUsage(Photo, ownerId)
  if (used + additionalBytes > maxStorageBytes) {
    const error = new Error('Storage quota exceeded')
    error.statusCode = 413
    throw error
  }
}
const googleImportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many Google Photos import attempts. Try again later.' },
})

const googleApiBase = 'https://photospicker.googleapis.com/v1'

const googleRequest = async (url, token, options = {}) => {
  const googleResponse = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  if (!googleResponse.ok) {
    const body = await googleResponse.text().catch(() => '')
    console.error('Google Photos API error:', googleResponse.status, body)
    throw new Error(`Google Photos request failed: ${googleResponse.status}`)
  }
  return googleResponse.json()
}

const getGoogleTokenForUser = async (userId) => {
  const user = await User.findById(userId).select('+googleRefreshToken')
  if (!user?.googleRefreshToken) return null
  return getGoogleAccessToken(decryptGoogleToken(user.googleRefreshToken))
}

const getOwnedPickerSession = (sessionId, userId) => GooglePickerSession.findOne({ sessionId, owner: userId })

const downloadGoogleImage = async (baseUrl, token) => {
  const googleResponse = await fetch(`${baseUrl}=d`, { headers: { Authorization: `Bearer ${token}` } })
  if (!googleResponse.ok || !googleResponse.body) throw new Error('Google image download failed')

  const contentLength = Number(googleResponse.headers.get('content-length'))
  if (contentLength > maxFileSize) throw new Error('Google image is too large')

  const chunks = []
  let size = 0
  for await (const chunk of googleResponse.body) {
    size += chunk.length
    if (size > maxFileSize) throw new Error('Google image is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const safeFilename = (filename) => (filename || 'google-photo.jpg').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180)
const sanitizeDescription = (value) => value
  .replace(/<[^>]*>/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()

router.use(requireAuth)
router.use((_request, response, next) => {
  response.set('Cache-Control', 'private, no-store')
  next()
})

router.get('/', async (request, response) => {
  const pageValue = request.query.page ?? '1'
  const limitValue = request.query.limit ?? '20'
  const page = Number(pageValue)
  const limit = Number(limitValue)

  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1 || limit > 100) {
    return response.status(400).json({ message: 'Page must be at least 1 and limit must be between 1 and 100' })
  }

  try {
    const [photos, total] = await Promise.all([
      Photo.find({ owner: request.user.userId })
        .populate('owner', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Photo.countDocuments({ owner: request.user.userId }),
    ])

    return response.json({
      photos,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch {
    return response.status(500).json({ message: 'Unable to fetch photos' })
  }
})

router.get('/:id/file', async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) {
    return response.status(400).json({ message: 'Invalid photo id' })
  }

  try {
    const photo = await Photo.findById(request.params.id).lean()
    if (!photo) {
      return response.status(404).json({ message: 'Photo not found' })
    }
    if (photo.owner.toString() !== request.user.userId) {
      return response.status(403).json({ message: 'You do not have permission to view this photo' })
    }

    const file = await findGridFsFile(photo.gridfsFileId)
    if (!file) {
      return response.status(404).json({ message: 'Photo file not found' })
    }

    response.type(file.contentType || 'image/jpeg')
    response.set('Content-Length', file.length.toString())

    const downloadStream = openGridFsDownload(photo.gridfsFileId)
    downloadStream.once('error', () => {
      if (!response.headersSent) {
        response.status(404).json({ message: 'Photo file not found' })
      } else {
        response.destroy()
      }
    })
    downloadStream.pipe(response)
    return undefined
  } catch {
    return response.status(500).json({ message: 'Unable to fetch photo file' })
  }
})

router.patch('/:id', async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) {
    return response.status(400).json({ message: 'Invalid photo id' })
  }

  const parsed = descriptionSchema.safeParse(request.body)
  if (!parsed.success) {
    return response.status(400).json({ message: 'Description must be text' })
  }
  const description = sanitizeDescription(parsed.data.description)
  if (description.length > maxDescriptionLength) {
    return response.status(400).json({ message: `Description must be ${maxDescriptionLength} characters or fewer` })
  }

  try {
    const photo = await Photo.findOneAndUpdate(
      { _id: request.params.id, owner: request.user.userId },
      { description },
      { new: true, runValidators: true },
    )
    if (!photo) return response.status(404).json({ message: 'Photo not found' })
    return response.json({ photo })
  } catch {
    return response.status(500).json({ message: 'Unable to update photo description' })
  }
})

router.delete('/:id', async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) {
    return response.status(400).json({ message: 'Invalid photo id' })
  }

  try {
    const photo = await Photo.findById(request.params.id)

    if (!photo) {
      return response.status(404).json({ message: 'Photo not found' })
    }
    if (photo.owner.toString() !== request.user.userId) {
      return response.status(403).json({ message: 'You do not have permission to delete this photo' })
    }

    const file = await findGridFsFile(photo.gridfsFileId)
    if (file) {
      await deleteGridFsFile(photo.gridfsFileId)
    }
    await photo.deleteOne()

    return response.status(204).send()
  } catch {
    return response.status(500).json({ message: 'Unable to delete photo' })
  }
})

router.post('/', uploadRateLimit, parseUploads, async (request, response) => {
  if (!request.files?.length) {
    return response.status(400).json({ message: 'At least one photo is required' })
  }
  const parsedDescription = request.body?.description === undefined
    ? { success: true, data: { description: '' } }
    : uploadDescriptionSchema.safeParse({ description: request.body.description })
  if (!parsedDescription.success) {
    return response.status(400).json({ message: 'Description must be 500 characters or fewer' })
  }
  const description = sanitizeDescription(parsedDescription.data.description)
  if (description.length > maxDescriptionLength) {
    return response.status(400).json({ message: 'Description must be 500 characters or fewer' })
  }

  const storedFileIds = []
  const createdPhotos = []

  try {
    for (const file of request.files) {
      await assertStorageQuota(request.user.userId, file.size)
      const storedPhoto = await processAndStorePhoto(file.buffer, file.originalname, request.user.userId)
      storedFileIds.push(storedPhoto.gridfsFileId)

      const photo = await Photo.create({
        owner: request.user.userId,
        originalFilename: file.originalname,
        gridfsFileId: storedPhoto.gridfsFileId,
        size: storedPhoto.size,
        description,
      })
      createdPhotos.push(photo)
    }

    return response.status(201).json({ photos: createdPhotos })
  } catch (error) {
    await Promise.all(storedFileIds.map((fileId) => deleteGridFsFile(fileId).catch(() => undefined)))
    if (createdPhotos.length) {
      await Photo.deleteMany({ _id: { $in: createdPhotos.map((photo) => photo._id) } })
    }

    if (error.statusCode === 413) {
      return response.status(413).json({ message: 'Your storage quota has been exceeded' })
    }
    if (
      error.message?.includes('unsupported image format')
      || error.message?.includes('Unsupported image format')
      || error.message?.includes('dimensions exceed')
    ) {
      return response.status(400).json({ message: 'One or more images could not be processed' })
    }
    return response.status(500).json({ message: 'Unable to upload photos' })
  }
})

router.post('/google/session', googleImportRateLimit, async (request, response) => {
  try {
    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) {
      return response.status(409).json({ message: 'Connect Google Photos before importing' })
    }

    const session = await googleRequest(`${googleApiBase}/sessions`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickingConfig: { maxItemCount: maxFilesPerUpload } }),
    })
    await GooglePickerSession.create({ sessionId: session.id, owner: request.user.userId })
    return response.status(201).json({ sessionId: session.id, pickerUri: session.pickerUri })
  } catch {
    return response.status(502).json({ message: 'Unable to start Google Photos import' })
  }
})

router.get('/google/session/:sessionId', async (request, response) => {
  try {
    const session = await getOwnedPickerSession(request.params.sessionId, request.user.userId)
    if (!session) return response.status(404).json({ message: 'Google Photos session not found' })

    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) return response.status(401).json({ message: 'Google Photos authorization expired' })

    const status = await googleRequest(`${googleApiBase}/sessions/${encodeURIComponent(session.sessionId)}`, token)
    return response.json({ mediaItemsSet: status.mediaItemsSet === true, pollingConfig: status.pollingConfig })
  } catch {
    return response.status(502).json({ message: 'Unable to check Google Photos session' })
  }
})

router.post('/google/import', googleImportRateLimit, async (request, response) => {
  const parsed = googleImportSchema.safeParse(request.body)
  if (!parsed.success) {
    return response.status(400).json({ message: 'A Google Photos session is required' })
  }
  const { sessionId } = parsed.data

  const storedFileIds = []
  const createdPhotos = []

  try {
    const session = await getOwnedPickerSession(sessionId, request.user.userId)
    if (!session) return response.status(404).json({ message: 'Google Photos session not found' })

    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) return response.status(401).json({ message: 'Google Photos authorization expired' })

    const status = await googleRequest(`${googleApiBase}/sessions/${encodeURIComponent(sessionId)}`, token)
    if (!status.mediaItemsSet) return response.status(409).json({ message: 'Finish selecting photos before importing' })

    const mediaItems = []
    let pageToken
    do {
      const query = new URLSearchParams({ sessionId, pageSize: String(maxFilesPerUpload) })
      if (pageToken) query.set('pageToken', pageToken)
      const page = await googleRequest(`${googleApiBase}/mediaItems?${query}`, token)
      mediaItems.push(...(page.mediaItems || []))
      pageToken = page.nextPageToken
    } while (pageToken && mediaItems.length < maxFilesPerUpload)

    for (const item of mediaItems.slice(0, maxFilesPerUpload)) {
      const mediaFile = item.mediaFile
      if (!mediaFile?.baseUrl || !mediaFile.mimeType?.startsWith('image/')) continue

      const imageBuffer = await downloadGoogleImage(mediaFile.baseUrl, token)
      await assertStorageQuota(request.user.userId, imageBuffer.length)
      const storedPhoto = await processAndStorePhoto(imageBuffer, safeFilename(mediaFile.filename), request.user.userId)
      storedFileIds.push(storedPhoto.gridfsFileId)
      createdPhotos.push(await Photo.create({
        owner: request.user.userId,
        originalFilename: safeFilename(mediaFile.filename),
        gridfsFileId: storedPhoto.gridfsFileId,
        size: storedPhoto.size,
      }))
    }

    await GooglePickerSession.deleteOne({ _id: session._id })
    await fetch(`${googleApiBase}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    return response.status(201).json({ photos: createdPhotos })
  } catch {
    await Promise.all(storedFileIds.map((fileId) => deleteGridFsFile(fileId).catch(() => undefined)))
    if (createdPhotos.length) await Photo.deleteMany({ _id: { $in: createdPhotos.map((photo) => photo._id) } })
    return response.status(502).json({ message: 'Unable to import Google Photos' })
  }
})

export default router
