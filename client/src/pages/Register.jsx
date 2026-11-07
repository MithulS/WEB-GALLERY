import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

export default function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')

    try {
      await register(form)
      navigate('/verify-email', { replace: true, state: { email: form.email } })
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to create your account right now.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f1e8] px-5 py-10">
      <section className="w-full max-w-md rounded-4xl border border-[#dcd4c5] bg-[#fffdf8] p-7 shadow-[0_24px_80px_rgba(67,55,35,0.12)] sm:p-10">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[#c75b39]">Pic Web</p>
        <h1 className="font-serif text-4xl text-[#29261f]">Start your archive.</h1>
        <p className="mt-3 text-sm leading-6 text-[#746d61]">A quiet place for the images worth keeping.</p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <label className="block text-sm font-semibold text-[#4d473d]">
            Name
            <input id="register-name" name="name" className="field" type="text" autoComplete="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="block text-sm font-semibold text-[#4d473d]">
            Email
            <input id="register-email" name="email" className="field" type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label className="block text-sm font-semibold text-[#4d473d]">
            Password
            <input id="register-password" name="password" className="field" type="password" autoComplete="new-password" minLength="10" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            <span className="mt-2 block text-xs font-normal text-[#746d61]">Use at least 10 characters and avoid common passwords.</span>
          </label>
          {error && <p className="rounded-xl bg-[#f9e3dc] px-4 py-3 text-sm text-[#9a3f2b]">{error}</p>}
          <button className="button-primary w-full" type="submit" disabled={busy}>{busy ? 'Creating your archive...' : 'Create account'}</button>
        </form>

        <p className="mt-7 text-center text-sm text-[#746d61]">Already have an account? <Link className="font-bold text-[#b84f31] hover:text-[#8f3b25]" to="/login">Log in</Link></p>
      </section>
    </main>
  )
}
