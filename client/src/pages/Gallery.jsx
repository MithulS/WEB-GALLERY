import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../context/useAuth'

const imageUrl = (id) => `/api/photos/${id}/file`

export default function Gallery() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const fileInput = useRef(null)
  const [photos, setPhotos] = useState([])
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [googleImporting, setGoogleImporting] = useState(false)
  const googleStatus = new URLSearchParams(window.location.search).get('google')
  const [googleConnected] = useState(googleStatus === 'connected')
  const googleReady = Boolean(user?.googleConnected) || googleConnected
  const [editingPhotoId, setEditingPhotoId] = useState(null)
  const [editDescription, setEditDescription] = useState('')
  const [savingDescription, setSavingDescription] = useState(false)
  const [uploadDescription, setUploadDescription] = useState('')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState(googleStatus === 'connected' ? 'Google Photos is connected. Open the picker to choose photos.' : '')
  const [error, setError] = useState(googleStatus === 'denied' || googleStatus === 'error' ? 'Google Photos authorization was not completed.' : '')

  const parseGoogleDuration = (duration) => {
    const seconds = Number.parseFloat(String(duration || '').replace('s', ''))
    return Number.isFinite(seconds) ? seconds * 1000 : 3000
  }

  const loadPhotos = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/photos?limit=100')
      setPhotos(data.photos)
    } catch (requestError) {
      if (requestError.response?.status === 401) navigate('/login', { replace: true })
      else setError('Your gallery could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => {
    queueMicrotask(loadPhotos)
  }, [loadPhotos])

  useEffect(() => {
    if (googleStatus === 'connected') {
      navigate('/', { replace: true })
    } else if (googleStatus === 'denied' || googleStatus === 'error') {
      navigate('/', { replace: true })
    }
  }, [googleStatus, navigate])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSelectedPhoto(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])

  const handleUpload = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return

    const formData = new FormData()
    files.forEach((file) => formData.append('photos', file))
    if (uploadDescription.trim()) formData.append('description', uploadDescription)
    setUploading(true)
    setProgress(0)
    setError('')
    setMessage('')

    try {
      await api.post('/photos', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => setProgress(event.total ? Math.round((event.loaded * 100) / event.total) : 0),
      })
      setMessage(`${files.length} ${files.length === 1 ? 'photo' : 'photos'} added to your gallery.`)
      setUploadDescription('')
      await loadPhotos()
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'The upload could not be completed.')
    } finally {
      setUploading(false)
    }
  }

  const handleGooglePicker = async () => {
    if (!googleReady) {
      window.location.assign('/api/google/auth')
      return
    }

    setGoogleImporting(true)
    setError('')
    setMessage('Opening Google Photos...')

    try {
      const { data: session } = await api.post('/photos/google/session')
      const pickerWindow = window.open(session.pickerUri, '_blank', 'noopener,noreferrer')
      if (!pickerWindow) throw new Error('Allow pop-ups to open Google Photos.')

      let selectionComplete = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { data: status } = await api.get(`/photos/google/session/${session.sessionId}`)
        if (status.mediaItemsSet) {
          selectionComplete = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, parseGoogleDuration(status.pollingConfig?.pollInterval)))
      }

      if (!selectionComplete) throw new Error('Google Photos selection timed out.')
      setMessage('Importing your selected photos...')
      await api.post('/photos/google/import', { sessionId: session.sessionId })
      setMessage('Google Photos added to your gallery.')
      await loadPhotos()
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message || 'Google Photos import failed.')
    } finally {
      setGoogleImporting(false)
    }
  }

  const handleDelete = async (photoId) => {
    setError('')
    try {
      await api.delete(`/photos/${photoId}`)
      setPhotos((current) => current.filter((photo) => photo._id !== photoId))
      if (selectedPhoto?._id === photoId) setSelectedPhoto(null)
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'The photo could not be deleted.')
    }
  }

  const startDescriptionEdit = (photo) => {
    setError('')
    setEditingPhotoId(photo._id)
    setEditDescription(photo.description || '')
  }

  const cancelDescriptionEdit = () => {
    if (savingDescription) return
    setEditingPhotoId(null)
    setEditDescription('')
  }

  const handleDescriptionSave = async (photo) => {
    if (savingDescription) return
    setSavingDescription(true)
    setError('')
    try {
      const { data } = await api.patch(`/photos/${photo._id}`, { description: editDescription })
      setPhotos((current) => current.map((currentPhoto) => currentPhoto._id === photo._id ? data.photo : currentPhoto))
      setEditingPhotoId(null)
      setEditDescription('')
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'The description could not be saved.')
    } finally {
      setSavingDescription(false)
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-[#f5f1e8] text-[#29261f]">
      <header className="border-b border-[#ded6c8] bg-[#fffdf8]/90 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <div>
            <p className="font-serif text-2xl">Pic Web</p>
            <p className="hidden text-xs uppercase tracking-[0.18em] text-[#8a8173] sm:block">Your visual archive</p>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <span className="hidden text-sm text-[#746d61] sm:inline">{user?.name}</span>
            <button className="button-secondary" type="button" onClick={handleLogout}>Log out</button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <section className="mb-9 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <div>
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[#c75b39]">The collection</p>
            <h1 className="font-serif text-4xl sm:text-6xl">Small moments, kept.</h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-[#746d61]">Upload the images you want close at hand. Everything here is processed gently and kept in its original order.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <input ref={fileInput} className="hidden" type="file" accept="image/*" multiple onChange={handleUpload} />
            <label className="min-w-60 flex-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-[#746d61]">
              Description for uploaded photos
              <input className="field mt-1" type="text" maxLength="500" placeholder="Optional description" value={uploadDescription} onChange={(event) => setUploadDescription(event.target.value)} disabled={uploading} />
            </label>
            <button className="button-primary" type="button" onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? `Uploading ${progress}%` : 'Add photos'}</button>
            <button className="button-secondary" type="button" onClick={handleGooglePicker} disabled={googleImporting || uploading}>{googleImporting ? 'Importing...' : googleReady ? 'Open Google Photos' : 'Import from Google Photos'}</button>
          </div>
        </section>

        {uploading && <div className="mb-7 h-2 overflow-hidden rounded-full bg-[#e4dbcc]" aria-label={`Upload progress ${progress}%`}><div className="h-full rounded-full bg-[#c75b39] transition-all" style={{ width: `${progress}%` }} /></div>}
        {message && <p className="mb-6 rounded-xl bg-[#e5f0e3] px-4 py-3 text-sm text-[#35603a]">{message}</p>}
        {error && <p className="mb-6 rounded-xl bg-[#f9e3dc] px-4 py-3 text-sm text-[#9a3f2b]">{error}</p>}

        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"><div className="skeleton h-64" /><div className="skeleton h-80" /><div className="skeleton h-56" /><div className="skeleton h-72" /></div>
        ) : photos.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
            {photos.map((photo) => {
              const ownerId = photo.owner?._id ?? photo.owner
              const ownedByUser = String(ownerId) === String(user?.id)
              return (
                <article className="group relative overflow-hidden rounded-2xl bg-[#e4dbcc]" key={photo._id}>
                  <button className="block w-full cursor-zoom-in text-left" type="button" onClick={() => setSelectedPhoto(photo)} aria-label={`Open ${photo.originalFilename}`}>
                    <img className="aspect-4/5 w-full object-cover transition duration-500 group-hover:scale-105" src={imageUrl(photo._id)} alt={photo.originalFilename} loading="lazy" />
                  </button>
                  {ownedByUser && <button className="absolute right-3 top-3 rounded-full bg-[#29261f]/80 px-3 py-1.5 text-xs font-semibold text-white transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" type="button" onClick={() => handleDelete(photo._id)}>Delete</button>}
                  <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/65 to-transparent px-4 pb-3 pt-10 text-white"><p className="truncate text-sm font-medium">{photo.originalFilename}</p><p className="mt-1 text-xs text-white/75">{photo.owner?.name || 'Unknown photographer'}</p></div>
                  <div className="bg-[#fffdf8] p-3 text-sm text-[#4d473d]">
                    {editingPhotoId === photo._id ? (
                      <div>
                        <label className="block text-xs text-[#746d61]" htmlFor={`description-${photo._id}`}>Description</label>
                        <textarea id={`description-${photo._id}`} className="field mt-1 min-h-20 resize-y px-2 py-1 text-sm" maxLength="500" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button className="button-secondary px-3 py-1 text-xs" type="button" onClick={cancelDescriptionEdit} disabled={savingDescription}>Cancel</button>
                          <button className="button-primary px-3 py-1 text-xs" type="button" onClick={() => handleDescriptionSave(photo)} disabled={savingDescription}>{savingDescription ? 'Saving...' : 'Save'}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-h-5 whitespace-pre-wrap break-words">{photo.description || 'Add a description'}</p>
                        {ownedByUser && <button className="shrink-0 text-xs font-semibold text-[#b84f31] hover:text-[#8f3b25]" type="button" onClick={() => startDescriptionEdit(photo)}>Edit</button>}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-[#cfc4b2] bg-[#fffdf8]/60 px-6 py-20 text-center"><p className="font-serif text-3xl">Your gallery is waiting.</p><p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#746d61]">Choose a few images from your device and make this space yours.</p></div>
        )}
      </main>

      {selectedPhoto && <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#201c17]/90 p-5" role="dialog" aria-modal="true" onClick={() => setSelectedPhoto(null)}><div className="relative max-h-full max-w-5xl" onClick={(event) => event.stopPropagation()}><button className="absolute -right-2 -top-12 text-sm font-semibold text-white" type="button" onClick={() => setSelectedPhoto(null)}>Close</button><img className="max-h-[85vh] rounded-2xl object-contain" src={imageUrl(selectedPhoto._id)} alt={selectedPhoto.originalFilename} /></div></div>}
    </div>
  )
}
