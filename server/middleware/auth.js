import jwt from 'jsonwebtoken'
import User from '../models/User.js'

const getCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
})

export const authCookieOptions = getCookieOptions

export const requireAuth = async (request, response, next) => {
  const token = request.cookies?.token

  if (!token) {
    return response.status(401).json({ message: 'Authentication required' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
    if (payload.type !== 'access') {
      return response.status(401).json({ message: 'Invalid or expired token' })
    }
    const user = await User.findById(payload.userId).select('+authTokenVersion emailVerified')
    if (!user || user.authTokenVersion !== payload.tokenVersion) {
      return response.status(401).json({ message: 'Invalid or expired token' })
    }
    if (!user.emailVerified) {
      return response.status(403).json({ code: 'EMAIL_UNVERIFIED', message: 'Email verification is required' })
    }
    request.user = payload
    return next()
  } catch {
    return response.status(401).json({ message: 'Invalid or expired token' })
  }
}
