import crypto from 'node:crypto'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { v2 as cloudinary } from 'cloudinary'

export const maxStorageBytes = 1024 * 1024 * 1024
export const maxImageDimension = 10000
export const maxImagePixels = 40_000_000

const configureCloudinary = () => {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary storage is not configured')
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })
}

const validateImage = async (buffer) => {
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  if (!['jpeg', 'png', 'webp', 'heif'].includes(metadata.format)) {
    throw new Error('Unsupported image format')
  }
  if (
    !metadata.width
    || !metadata.height
    || metadata.width > maxImageDimension
    || metadata.height > maxImageDimension
    || metadata.width * metadata.height > maxImagePixels
  ) {
    throw new Error('Image dimensions exceed the allowed limit')
  }
}

export const processAndStorePhoto = async (buffer, _filename, ownerId) => {
  await validateImage(buffer)
  const processedImage = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()

  configureCloudinary()
  const publicId = `pic-web/${ownerId}/${crypto.randomUUID()}`
  await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream({
      public_id: publicId,
      resource_type: 'image',
      type: 'authenticated',
      format: 'jpg',
      context: { owner: ownerId },
    }, (error, result) => {
      if (error) return reject(error)
      return resolve(result)
    })
    uploadStream.end(processedImage)
  })

  return {
    cloudinaryPublicId: publicId,
    cloudinaryUrl: getCloudinaryPhotoUrl(publicId),
    size: processedImage.length,
  }
}

export const getCloudinaryPhotoUrl = (publicId) => {
  configureCloudinary()
  return cloudinary.url(publicId, {
    format: 'jpg',
    resource_type: 'image',
    secure: true,
    sign_url: true,
    type: 'authenticated',
  })
}

export const getUserStorageUsage = (Photo, ownerId) => Photo.aggregate([
  { $match: { owner: new mongoose.Types.ObjectId(ownerId) } },
  { $group: { _id: null, total: { $sum: '$size' } } },
]).then(([result]) => result?.total || 0)

export const deleteCloudinaryPhoto = async (publicId) => {
  if (!publicId) return
  configureCloudinary()
  await cloudinary.uploader.destroy(publicId, {
    invalidate: true,
    resource_type: 'image',
    type: 'authenticated',
  })
}
