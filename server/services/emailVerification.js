import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import '../config/env.js'

const codeLifetimeMs = 10 * 60 * 1000
const resendCooldownMs = 60 * 1000
export const maxOtpAttempts = 5
export const maxOtpResendsPerHour = 5

const hashCode = (code) => crypto
  .createHash('sha256')
  .update(`${process.env.JWT_SECRET}:${code}`)
  .digest('hex')

export const createOtp = () => {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  return {
    code,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + codeLifetimeMs),
    sentAt: new Date(),
  }
}

export const isOtpResendAllowed = (lastSentAt) => !lastSentAt || Date.now() - lastSentAt.getTime() >= resendCooldownMs

export const matchesOtp = (code, codeHash) => {
  if (!/^\d{6}$/.test(code) || typeof codeHash !== 'string') return false
  const expected = Buffer.from(codeHash, 'hex')
  const received = Buffer.from(hashCode(code), 'hex')
  return expected.length === received.length && crypto.timingSafeEqual(expected, received)
}

const createTransporter = () => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) {
    throw new Error('Email verification is not configured')
  }
  const port = Number(process.env.SMTP_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid port')
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
}

export const verifyEmailTransport = async () => {
  try {
    const transporter = createTransporter()
    await transporter.verify()
    console.info('SMTP transporter verification succeeded')
    transporter.close()
  } catch (error) {
    console.error('SMTP transporter verification failed:', error.message)
  }
}

export const sendOtpEmail = async (email, code) => {
  if (process.env.NODE_ENV === 'test') return
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[DEV ONLY] OTP for ${email}: ${code}`)
  }
  const transporter = createTransporter()
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Verify your Pic Web email',
      text: `Your Pic Web verification code is ${code}. It expires in 10 minutes.`,
    })
    console.info(`OTP email sent to ${email}`)
  } catch (error) {
    console.error(`OTP email failed for ${email}:`, error.message)
    throw error
  } finally {
    transporter.close()
  }
}
