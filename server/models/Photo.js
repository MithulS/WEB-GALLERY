import mongoose from 'mongoose'

const photoSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    originalFilename: {
      type: String,
      required: true,
      trim: true,
    },
    gridfsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    size: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { versionKey: false },
)

const Photo = mongoose.models.Photo || mongoose.model('Photo', photoSchema)

export default Photo
