import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [resendAvailable, setResendAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const googleFailed = new URLSearchParams(location.search).get('error') === 'google_failed'

  const handleSubmit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')

    try {
      await login(form)
      navigate(location.state?.from || '/', { replace: true })
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to log in right now.')
      setResendAvailable(requestError.response?.data?.code === 'EMAIL_UNVERIFIED')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f1e8] px-5 py-10">
      <section className="w-full max-w-md rounded-4xl border border-[#dcd4c5] bg-[#fffdf8] p-7 shadow-[0_24px_80px_rgba(67,55,35,0.12)] sm:p-10">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[#c75b39]">Pic Web</p>
        <h1 className="font-serif text-4xl text-[#29261f]">Welcome back.</h1>
        <p className="mt-3 text-sm leading-6 text-[#746d61]">Keep your favorite photographs close, wherever the day takes you.</p>
        {location.state?.successMessage && <p className="mt-5 rounded-xl bg-[#e5f0e3] px-4 py-3 text-sm text-[#35603a]">{location.state.successMessage}</p>}
        {googleFailed && <p className="mt-5 rounded-xl bg-[#f9e3dc] px-4 py-3 text-sm text-[#9a3f2b]">Google sign-in could not be completed. Please try again.</p>}

        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <label className="block text-sm font-semibold text-[#4d473d]">
            Email
            <input id="login-email" name="email" className="field" type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label className="block text-sm font-semibold text-[#4d473d]">
            Password
            <input id="login-password" name="password" className="field" type="password" autoComplete="current-password" minLength="10" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
          {error && <p className="rounded-xl bg-[#f9e3dc] px-4 py-3 text-sm text-[#9a3f2b]">{error}</p>}
          {resendAvailable && <button className="text-sm font-bold text-[#b84f31] hover:text-[#8f3b25]" type="button" onClick={() => navigate('/verify-email', { state: { email: form.email } })}>Verify or resend OTP</button>}
          <button className="button-primary w-full" type="submit" disabled={busy}>{busy ? 'Opening your gallery...' : 'Log in'}</button>
        </form>
        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-[0.16em] text-[#aaa193]">
          <span className="h-px flex-1 bg-[#dcd4c5]" />
          or
          <span className="h-px flex-1 bg-[#dcd4c5]" />
        </div>
        <a className="button-secondary block w-full text-center" href="/api/auth/google">Continue with Google</a>

        <p className="mt-7 text-center text-sm text-[#746d61]">New here? <Link className="font-bold text-[#b84f31] hover:text-[#8f3b25]" to="/register">Create an account</Link></p>
      </section>
    </main>
  )
}
