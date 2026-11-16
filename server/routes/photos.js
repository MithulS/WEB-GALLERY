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
import { deleteCloudinaryPhoto, getCloudinaryPhotoUrl, getUserStorageUsage, maxStorageBytes, processAndStorePhoto } from '../services/photoStorage.js'

const router = express.Router()
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'])
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
    const extension = file.originalname?.slice(file.originalname.lastIndexOf('.')).toLowerCase()
    if (!allowedMimeTypes.has(file.mimetype) && !allowedExtensions.has(extension)) {
      return callback(new Error('Only JPEG, PNG, WebP, and HEIC images are allowed'))
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

class GooglePhotosApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'GooglePhotosApiError'
    this.status = status
  }
}

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
    throw new GooglePhotosApiError(googleResponse.status, `Google Photos request failed: ${googleResponse.status}`)
  }
  return googleResponse.json()
}

const getGoogleTokenForUser = async (userId) => {
  const user = await User.findById(userId).select('+googleRefreshToken')
  if (!user?.googleRefreshToken) return null
  try {
    return await getGoogleAccessToken(decryptGoogleToken(user.googleRefreshToken))
  } catch (error) {
    if (error.response?.data?.error === 'invalid_grant') {
      await User.updateOne({ _id: userId }, { $unset: { googleRefreshToken: 1 } })
      return null
    }
    throw error
  }
}

const getOwnedPickerSession = (sessionId, userId) => GooglePickerSession.findOne({ sessionId, owner: userId })

const downloadGoogleImage = async (baseUrl, token) => {
  // mediaFile.baseUrl is a temporary signed URL from Google's Photos Picker API.
  // Fetch it directly — do not append =d or any suffix, and do not add an
  // Authorization header (the URL is already authenticated via its signature).
  const googleResponse = await fetch(baseUrl)
  if (!googleResponse.ok) throw new GooglePhotosApiError(googleResponse.status, 'Google image download failed')
  if (!googleResponse.body) throw new Error('Google image download failed')

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

const googleErrorResponse = (error, fallbackMessage) => {
  if (error instanceof GooglePhotosApiError) {
    if (error.status === 401 || error.status === 403) return { status: 401, message: 'Google Photos authorization expired or the selected media is no longer accessible' }
    if (error.status === 404) return { status: 404, message: 'The Google Photos picker session has expired' }
    if (error.status === 409 || error.status === 412) return { status: 409, message: 'Finish selecting photos before importing' }
  }
  return { status: 502, message: fallbackMessage }
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
      Photo.find({}).select('-cloudinaryUrl -cloudinaryPublicId')
        .populate('owner', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Photo.countDocuments(),
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
    if (!photo.cloudinaryPublicId) {
      return response.status(404).json({ message: 'Photo file not found' })
    }
    return response.redirect(302, getCloudinaryPhotoUrl(photo.cloudinaryPublicId))
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

    await deleteCloudinaryPhoto(photo.cloudinaryPublicId)
    try {
      await photo.deleteOne()
    } catch (error) {
      console.error('Photo storage was deleted but database record deletion failed:', error)
      return response.status(500).json({ message: 'The photo storage was removed, but the gallery record could not be deleted. Contact support.' })
    }

    return response.status(204).send()
  } catch (error) {
    console.error('Unable to delete photo:', error)
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

  const createdPhotos = []
  const failures = []

  for (const file of request.files) {
    let storedPhoto
    try {
      storedPhoto = await processAndStorePhoto(file.buffer, file.originalname, request.user.userId)
      await assertStorageQuota(request.user.userId, storedPhoto.size)
      const photo = await Photo.create({
        owner: request.user.userId,
        originalFilename: safeFilename(file.originalname),
        cloudinaryPublicId: storedPhoto.cloudinaryPublicId,
        cloudinaryUrl: storedPhoto.cloudinaryUrl,
        size: storedPhoto.size,
        description,
      })
      createdPhotos.push(photo)
    } catch (error) {
      if (storedPhoto?.cloudinaryPublicId) {
        await deleteCloudinaryPhoto(storedPhoto.cloudinaryPublicId).catch(() => undefined)
      }
      failures.push({
        filename: safeFilename(file.originalname),
        message: error.statusCode === 413
          ? 'Your storage quota has been exceeded'
          : error.message?.includes('dimensions exceed')
            ? 'Image dimensions exceed the allowed limit'
            : 'This image could not be processed',
      })
    }
  }

  if (!createdPhotos.length) {
    const quotaExceeded = failures.some((failure) => failure.message === 'Your storage quota has been exceeded')
    return response.status(quotaExceeded ? 413 : 400).json({ message: quotaExceeded ? 'Your storage quota has been exceeded' : 'No photos could be uploaded', failures })
  }
  return response.status(failures.length ? 207 : 201).json({ photos: createdPhotos, failures })
})

router.post('/google/session', googleImportRateLimit, async (request, response) => {
  try {
    console.info('[GooglePhotos] SESSION_CREATE_STARTED: Creating picker session', {
      owner: request.user.userId,
      maxItemCount: maxFilesPerUpload,
    })

    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) {
      console.error('[GooglePhotos] SESSION_CREATE_STARTED: No Google token for user', {
        owner: request.user.userId,
      })
      return response.status(409).json({ message: 'Connect Google Photos before importing' })
    }

    const session = await googleRequest(`${googleApiBase}/sessions`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickingConfig: { maxItemCount: maxFilesPerUpload } }),
    })

    console.info('[GooglePhotos] SESSION_CREATED: Picker session created', {
      sessionId: session.id,
      owner: request.user.userId,
      expireTime: session.expireTime,
      hasPickerUri: Boolean(session.pickerUri),
    })

    await GooglePickerSession.create({ sessionId: session.id, owner: request.user.userId })

    console.info('[GooglePhotos] SESSION_CREATED: Picker session stored in database', {
      sessionId: session.id,
      owner: request.user.userId,
    })

    if (!session.pickerUri) {
      console.error('[GooglePhotos] SESSION_CREATED: pickerUri missing from Google response', {
        sessionId: session.id,
        owner: request.user.userId,
      })
      throw new Error('Google Photos picker URI is missing from session creation response')
    }

    // pickerUri must be used as-is per the official Photos Picker API.
    // Do not append /autoclose or any other path segment.
    return response.status(201).json({ sessionId: session.id, pickerUri: session.pickerUri })
  } catch (error) {
    console.error('[GooglePhotos] SESSION_CREATE_STARTED: Failed', {
      owner: request.user.userId,
      status: error.status,
      message: error.message,
    })
    const failure = googleErrorResponse(error, 'Unable to start Google Photos import')
    return response.status(failure.status).json({ message: failure.message })
  }
})

router.get('/google/session/:sessionId', async (request, response) => {
  try {
    console.info('[GooglePhotos] POLLING_STARTED: Checking session status', {
      sessionId: request.params.sessionId,
      owner: request.user.userId,
    })

    const session = await getOwnedPickerSession(request.params.sessionId, request.user.userId)
    if (!session) {
      console.error('[GooglePhotos] POLLING_STARTED: Session not found', {
        sessionId: request.params.sessionId,
        owner: request.user.userId,
      })
      return response.status(404).json({ message: 'Google Photos session not found' })
    }

    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) {
      console.error('[GooglePhotos] POLLING_STARTED: Google authorization expired', {
        sessionId: session.sessionId,
        owner: request.user.userId,
      })
      return response.status(401).json({ message: 'Google Photos authorization expired' })
    }

    const status = await googleRequest(`${googleApiBase}/sessions/${encodeURIComponent(session.sessionId)}`, token)
    console.info('[GooglePhotos] SESSION_STATUS: Polled Google Photos session', {
      sessionId: session.sessionId,
      owner: request.user.userId,
      mediaItemsSet: status.mediaItemsSet === true,
      state: status.state,
      expireTime: status.expireTime,
      pollingInterval: status.pollingConfig?.pollInterval,
    })
    return response.json({ mediaItemsSet: status.mediaItemsSet === true, pollingConfig: status.pollingConfig })
  } catch (error) {
    console.error('[GooglePhotos] POLLING_STARTED: Failed to check session', {
      sessionId: request.params.sessionId,
      owner: request.user.userId,
      status: error.status,
      message: error.message,
    })
    const failure = googleErrorResponse(error, 'Unable to check Google Photos session')
    return response.status(failure.status).json({ message: failure.message })
  }
})

router.post('/google/import', googleImportRateLimit, async (request, response) => {
  const parsed = googleImportSchema.safeParse(request.body)
  if (!parsed.success) {
    console.error('[GooglePhotos] IMPORT_FAILED: Invalid request body', {
      owner: request.user.userId,
    })
    return response.status(400).json({ message: 'A Google Photos session is required' })
  }
  const { sessionId } = parsed.data

  const storedCloudinaryIds = []
  const createdPhotos = []
  const failures = []
  let selectedCount = 0

  try {
    console.info('[GooglePhotos] MEDIA_RETRIEVAL_STARTED: Importing selected photos', {
      sessionId,
      owner: request.user.userId,
    })

    const session = await getOwnedPickerSession(sessionId, request.user.userId)
    if (!session) {
      console.error('[GooglePhotos] IMPORT_FAILED: Session not found', {
        sessionId,
        owner: request.user.userId,
      })
      return response.status(404).json({ message: 'Google Photos session not found' })
    }

    const token = await getGoogleTokenForUser(request.user.userId)
    if (!token) {
      console.error('[GooglePhotos] IMPORT_FAILED: Google authorization expired', {
        sessionId,
        owner: request.user.userId,
      })
      return response.status(401).json({ message: 'Google Photos authorization expired' })
    }

    const status = await googleRequest(`${googleApiBase}/sessions/${encodeURIComponent(sessionId)}`, token)
    if (!status.mediaItemsSet) {
      console.error('[GooglePhotos] IMPORT_FAILED: Selection not completed', {
        sessionId,
        owner: request.user.userId,
        mediaItemsSet: status.mediaItemsSet,
      })
      return response.status(409).json({ message: 'Finish selecting photos before importing' })
    }

    console.info('[GooglePhotos] MEDIA_ITEMS_SET: Selection confirmed by Google Photos', {
      sessionId,
      owner: request.user.userId,
      state: status.state,
    })

    const mediaItems = []
    let pageToken
    do {
      const query = new URLSearchParams({ sessionId, pageSize: String(maxFilesPerUpload) })
      if (pageToken) query.set('pageToken', pageToken)
      const page = await googleRequest(`${googleApiBase}/mediaItems?${query}`, token)
      mediaItems.push(...(page.mediaItems || []))
      pageToken = page.nextPageToken
    } while (pageToken && mediaItems.length < maxFilesPerUpload)

    selectedCount = mediaItems.length
    console.info('[GooglePhotos] MEDIA_RETRIEVED: Selected media items', {
      sessionId,
      owner: request.user.userId,
      selectedCount,
      pageCount: mediaItems.length,
    })

    if (selectedCount === 0) {
      console.error('[GooglePhotos] IMPORT_FAILED: No photos selected', {
        sessionId,
        owner: request.user.userId,
      })
      await GooglePickerSession.deleteOne({ _id: session._id })
      await fetch(`${googleApiBase}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
      return response.status(409).json({ message: 'No photos were selected in Google Photos' })
    }

    for (const item of mediaItems.slice(0, maxFilesPerUpload)) {
      const mediaFile = item.mediaFile
      const filename = safeFilename(mediaFile?.filename)
      if (!mediaFile?.baseUrl || !mediaFile.mimeType?.startsWith('image/')) {
        failures.push({ filename, message: 'This selected item is not an accessible image' })
        continue
      }

      // Duplicate prevention: skip if a photo with the same name and owner was recently imported
      const recentDuplicate = await Photo.findOne({
        owner: request.user.userId,
        originalFilename: filename,
        createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
      })
      if (recentDuplicate) {
        console.info('[GooglePhotos] IMPORT_FAILED: Duplicate skipped', {
          sessionId,
          owner: request.user.userId,
          filename,
        })
        failures.push({ filename, message: 'Duplicate import skipped' })
        continue
      }

      let storedPhoto
      try {
        console.info('[GooglePhotos] IMAGE_DOWNLOAD_STARTED: Downloading image', {
          sessionId,
          owner: request.user.userId,
          filename,
          mimeType: mediaFile.mimeType,
        })
        const imageBuffer = await downloadGoogleImage(mediaFile.baseUrl)
        console.info('[GooglePhotos] IMAGE_DOWNLOAD_SUCCESS: Image downloaded', {
          sessionId,
          owner: request.user.userId,
          filename,
          downloadedBytes: imageBuffer.length,
        })

        await assertStorageQuota(request.user.userId, imageBuffer.length)
        storedPhoto = await processAndStorePhoto(imageBuffer, filename, request.user.userId)
        storedCloudinaryIds.push(storedPhoto.cloudinaryPublicId)
        await assertStorageQuota(request.user.userId, storedPhoto.size - imageBuffer.length)

        console.info('[GooglePhotos] CLOUDINARY_UPLOAD_SUCCESS: Image stored', {
          sessionId,
          owner: request.user.userId,
          filename,
          cloudinaryPublicId: storedPhoto.cloudinaryPublicId,
          storedBytes: storedPhoto.size,
        })

        createdPhotos.push(await Photo.create({
          owner: request.user.userId,
          originalFilename: filename,
          cloudinaryPublicId: storedPhoto.cloudinaryPublicId,
          cloudinaryUrl: storedPhoto.cloudinaryUrl,
          size: storedPhoto.size,
        }))
        console.info('[GooglePhotos] MONGODB_SAVE_SUCCESS: Photo record saved', {
          sessionId,
          owner: request.user.userId,
          filename,
          photoId: createdPhotos[createdPhotos.length - 1]?._id,
        })
      } catch (error) {
        if (storedPhoto?.cloudinaryPublicId) {
          await deleteCloudinaryPhoto(storedPhoto.cloudinaryPublicId).catch(() => undefined)
        }
        failures.push({
          filename,
          message: error instanceof GooglePhotosApiError && (error.status === 401 || error.status === 403)
            ? 'This selected image is no longer accessible'
            : 'This selected image could not be imported',
        })
        console.error('[GooglePhotos] IMPORT_FAILED: Image import failed', {
          sessionId,
          owner: request.user.userId,
          filename,
          error: error.message,
        })
      }
    }

    await GooglePickerSession.deleteOne({ _id: session._id })
    await fetch(`${googleApiBase}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)

    console.info('[GooglePhotos] IMPORT_COMPLETED: Import finished', {
      sessionId,
      owner: request.user.userId,
      selectedCount,
      importedCount: createdPhotos.length,
      failureCount: failures.length,
    })

    if (!createdPhotos.length) return response.status(502).json({ message: 'No selected Google Photos could be imported', failures })
    return response.status(failures.length ? 207 : 201).json({ photos: createdPhotos, failures, selectedCount, importedCount: createdPhotos.length })
  } catch (error) {
    await Promise.all(storedCloudinaryIds.map((publicId) => deleteCloudinaryPhoto(publicId).catch(() => undefined)))
    if (createdPhotos.length) await Photo.deleteMany({ _id: { $in: createdPhotos.map((photo) => photo._id) } })
    console.error('[GooglePhotos] IMPORT_FAILED: Import error', {
      sessionId,
      owner: request.user.userId,
      status: error.status,
      message: error.message,
    })
    const failure = googleErrorResponse(error, 'Unable to import Google Photos')
    return response.status(failure.status).json({ message: failure.message })
  }
})

export default router
