import mongoose from 'mongoose'
import crypto from 'node:crypto'
import sharp from 'sharp'

const getBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'photos' })
export const maxStorageBytes = 1024 * 1024 * 1024
export const maxImageDimension = 10000
export const maxImagePixels = 40_000_000

const validateImage = async (buffer) => {
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
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

  const gridfsFileId = await new Promise((resolve, reject) => {
    const uploadStream = getBucket().openUploadStream(`${crypto.randomUUID()}.jpg`, {
      contentType: 'image/jpeg',
      metadata: { owner: ownerId },
    })

    uploadStream.once('error', reject)
    uploadStream.once('finish', () => resolve(uploadStream.id))
    uploadStream.end(processedImage)
  })

  return { gridfsFileId, size: processedImage.length }
}

export const getUserStorageUsage = (Photo, ownerId) => Photo.aggregate([
  { $match: { owner: new mongoose.Types.ObjectId(ownerId) } },
  { $group: { _id: null, total: { $sum: '$size' } } },
]).then(([result]) => result?.total || 0)

export const findGridFsFile = (fileId) => getBucket().find({ _id: fileId }).next()

export const openGridFsDownload = (fileId) => getBucket().openDownloadStream(fileId)

export const deleteGridFsFile = (fileId) => getBucket().delete(fileId)
