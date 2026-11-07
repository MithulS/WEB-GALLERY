import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
})

let refreshing

api.interceptors.response.use(undefined, async (error) => {
  const request = error.config
  if (
    error.response?.status !== 401
    || request?._retry
    || request?.url?.includes('/auth/refresh')
    || request?.url?.includes('/auth/login')
    || request?.url?.includes('/auth/me')
  ) {
    return Promise.reject(error)
  }

  request._retry = true
  refreshing ||= api.post('/auth/refresh')
  try {
    await refreshing
    return api(request)
  } catch {
    return Promise.reject(error)
  } finally {
    refreshing = undefined
  }
})

export default api
