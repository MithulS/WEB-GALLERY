import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

export default function ProtectedRoute() {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f5f1e8] text-sm text-[#746d61]">Checking your gallery...</div>
  }

  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location.pathname }} />
}
