import mongoose from 'mongoose'

const googlePickerSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60,
    },
  },
  { versionKey: false },
)

const GooglePickerSession = mongoose.models.GooglePickerSession || mongoose.model('GooglePickerSession', googlePickerSessionSchema)

export default GooglePickerSession
