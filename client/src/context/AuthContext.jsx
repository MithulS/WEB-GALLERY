import { useEffect, useState } from 'react'
import api from '../lib/api'
import AuthContext from './AuthContext'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    api.get('/auth/me')
      .then(({ data }) => {
        if (active) setUser(data.user)
      })
      .catch(() => {
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const login = async (credentials) => {
    const { data } = await api.post('/auth/login', credentials)
    setUser(data.user)
    return data.user
  }

  const register = async (details) => {
    const { data } = await api.post('/auth/register', details)
    return data
  }

  const verifyEmail = async (details) => {
    const { data } = await api.post('/auth/verify-otp', details)
    return data
  }

  const resendVerification = async (email) => {
    await api.post('/auth/resend-otp', { email })
  }

  const logout = async () => {
    await api.post('/auth/logout')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, verifyEmail, resendVerification, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
