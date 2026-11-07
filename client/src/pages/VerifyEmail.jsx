import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

export default function VerifyEmail() {
  const { verifyEmail, resendVerification } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [email, setEmail] = useState(location.state?.email || '')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const codeInputRef = useRef(null)

  useEffect(() => {
    codeInputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!cooldown) return undefined
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  const handleVerify = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await verifyEmail({ email, otp: code })
      navigate('/login', { replace: true, state: { successMessage: 'Email verified, please log in' } })
    } catch (requestError) {
      const code = requestError.response?.data?.code
      setError(code === 'OTP_TOO_MANY_ATTEMPTS'
        ? 'Too many incorrect attempts. Request a new verification code.'
        : requestError.response?.data?.message || 'That verification code is incorrect or expired.')
    } finally {
      setBusy(false)
    }
  }

  const handleResend = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await resendVerification(email)
      setCooldown(60)
      setMessage('If an eligible account exists, a new verification code has been sent.')
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to resend the verification code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f1e8] px-5 py-10">
      <section className="w-full max-w-md rounded-4xl border border-[#dcd4c5] bg-[#fffdf8] p-7 shadow-[0_24px_80px_rgba(67,55,35,0.12)] sm:p-10">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[#c75b39]">Pic Web</p>
        <h1 className="font-serif text-4xl text-[#29261f]">Verify your email.</h1>
        <p className="mt-3 text-sm leading-6 text-[#746d61]">Enter the six-digit code sent to your email. It expires in 10 minutes.</p>
        <form className="mt-8 space-y-5" onSubmit={handleVerify}>
          <label className="block text-sm font-semibold text-[#4d473d]">Email
            <input className="field" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="block text-sm font-semibold text-[#4d473d]">Verification code
            <input
              ref={codeInputRef}
              className="field tracking-[0.3em]"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength="6"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          {message && <p className="rounded-xl bg-[#e5f0e3] px-4 py-3 text-sm text-[#35603a]">{message}</p>}
          {error && <p className="rounded-xl bg-[#f9e3dc] px-4 py-3 text-sm text-[#9a3f2b]">{error}</p>}
          <button className="button-primary w-full" type="submit" disabled={busy}>{busy ? 'Verifying...' : 'Verify email'}</button>
        </form>
        <button className="mt-4 w-full text-sm font-bold text-[#b84f31] hover:text-[#8f3b25]" type="button" disabled={busy || cooldown > 0 || !email} onClick={handleResend}>
          {cooldown ? `Resend OTP in ${cooldown}s` : 'Resend OTP'}
        </button>
        <p className="mt-7 text-center text-sm text-[#746d61]"><Link className="font-bold text-[#b84f31] hover:text-[#8f3b25]" to="/login">Back to login</Link></p>
      </section>
    </main>
  )
}
