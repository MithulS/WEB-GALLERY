import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../context/useAuth'
import {
  UploadIcon,
  GoogleIcon,
  CloseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  TrashIcon,
  EditIcon,
  PhotoIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  SpinnerIcon,
} from '../components/Icons'

const imageUrl = (id) => `/api/photos/${id}/file`

const formatUploadDate = (date) => {
  if (!date) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(date))
}

const maxUploadFiles = 20
const maxUploadSize = 10 * 1024 * 1024
const acceptedUploadTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const acceptedUploadExtensions = /\.(jpe?g|png|webp|heic|heif)$/i

export default function Gallery() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const fileInput = useRef(null)
  const lightboxCloseButton = useRef(null)
  const touchStartX = useRef(null)

  const [photos, setPhotos] = useState([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 })
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [lightboxImageLoading, setLightboxImageLoading] = useState(false)
  const [lightboxImageError, setLightboxImageError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [googleImporting, setGoogleImporting] = useState(false)
  const [editingPhotoId, setEditingPhotoId] = useState(null)
  const [deletingPhotoId, setDeletingPhotoId] = useState(null)
  const [editDescription, setEditDescription] = useState('')
  const [savingDescription, setSavingDescription] = useState(false)
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploadItems, setUploadItems] = useState([])

  const googleStatus = new URLSearchParams(window.location.search).get('google')
  const [googleConnected] = useState(googleStatus === 'connected')
  const googleReady = Boolean(user?.googleConnected) || googleConnected

  const [message, setMessage] = useState(
    googleStatus === 'connected' ? 'Google Photos is connected. Open the picker to choose photos.' : ''
  )
  const [error, setError] = useState(
    googleStatus === 'denied' || googleStatus === 'error' ? 'Google Photos authorization was not completed.' : ''
  )

  const parseGoogleDuration = (duration) => {
    const seconds = Number.parseFloat(String(duration || '').replace('s', ''))
    return Number.isFinite(seconds) ? seconds * 1000 : 3000
  }

  const loadPhotos = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const { data } = await api.get(`/photos?page=${page}&limit=20`)
      setPhotos(data.photos)
      setPagination(data.pagination)
      return data.photos
    } catch (requestError) {
      if (requestError.response?.status === 401) {
        navigate('/login', { replace: true })
      } else {
        setError('Your gallery could not be loaded.')
      }
    } finally {
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => {
    queueMicrotask(loadPhotos)
  }, [loadPhotos])

  useEffect(() => {
    if (googleStatus === 'connected' || googleStatus === 'denied' || googleStatus === 'error') {
      navigate('/', { replace: true })
    }
  }, [googleStatus, navigate])

  useEffect(() => {
    if (selectedPhoto) {
      setLightboxImageLoading(true)
      setLightboxImageError(false)
    }
  }, [selectedPhoto])

  const openLightbox = (photo) => {
    setLightboxImageLoading(true)
    setLightboxImageError(false)
    setSelectedPhoto(photo)
  }

  const navigateLightbox = useCallback(async (direction) => {
    if (!selectedPhoto) return
    const currentIndex = photos.findIndex((photo) => photo._id === selectedPhoto._id)
    const nextIndex = currentIndex + direction
    if (nextIndex >= 0 && nextIndex < photos.length) {
      setSelectedPhoto(photos[nextIndex])
      return
    }
    const nextPage = pagination.page + (direction > 0 ? 1 : -1)
    if (nextPage < 1 || nextPage > pagination.totalPages) return
    const nextPhotos = await loadPhotos(nextPage)
    const nextPhoto = direction > 0 ? nextPhotos?.[0] : nextPhotos?.[nextPhotos.length - 1]
    if (nextPhoto) setSelectedPhoto(nextPhoto)
  }, [photos, selectedPhoto, pagination, loadPhotos])

  useEffect(() => {
    if (!selectedPhoto) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    lightboxCloseButton.current?.focus()

    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedPhoto(null)
      if (event.key === 'ArrowLeft') navigateLightbox(-1)
      if (event.key === 'ArrowRight') navigateLightbox(1)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [selectedPhoto, navigateLightbox])

  const handleLightboxTouchStart = (event) => {
    touchStartX.current = event.changedTouches[0].clientX
  }

  const handleLightboxTouchEnd = (event) => {
    if (touchStartX.current === null) return
    const distance = event.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(distance) >= 50) navigateLightbox(distance < 0 ? 1 : -1)
  }

  const uploadSingleFile = async (file, index) => {
    setUploadItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status: 'uploading', progress: 0, error: '' } : item
      )
    )
    const formData = new FormData()
    formData.append('photos', file)
    if (uploadDescription.trim()) formData.append('description', uploadDescription)
    try {
      await api.post('/photos', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) =>
          setUploadItems((current) =>
            current.map((item, itemIndex) =>
              itemIndex === index
                ? { ...item, progress: event.total ? Math.round((event.loaded * 100) / event.total) : 0 }
                : item
            )
          ),
      })
      setUploadItems((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, status: 'uploaded', progress: 100 } : item
        )
      )
      return true
    } catch (requestError) {
      const failure = requestError.response?.data?.failures?.[0]
      setUploadItems((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                status: 'failed',
                error: failure?.message || requestError.response?.data?.message || 'Upload failed',
              }
            : item
        )
      )
      return false
    }
  }

  const processFileList = async (filesList) => {
    const files = Array.from(filesList || [])
    if (!files.length) return
    if (files.length > maxUploadFiles) {
      setError(`You can upload up to ${maxUploadFiles} images at a time.`)
      return
    }
    const invalidFile = files.find(
      (file) =>
        file.size > maxUploadSize ||
        (!acceptedUploadTypes.has(file.type) && !acceptedUploadExtensions.test(file.name))
    )
    if (invalidFile) {
      setError(`${invalidFile.name} is not a supported image or exceeds the 10 MB limit.`)
      return
    }

    setUploadItems(
      files.map((file) => ({
        file,
        name: file.name,
        size: file.size,
        status: 'queued',
        progress: 0,
        error: '',
      }))
    )
    setUploading(true)
    setError('')
    setMessage('')

    for (const [index, file] of files.entries()) {
      await uploadSingleFile(file, index)
    }

    setUploading(false)
    setUploadDescription('')
    setMessage('Uploads completed. You can review your photos below.')
    await loadPhotos(pagination.page)
  }

  const handleUpload = async (event) => {
    const files = event.target.files
    event.target.value = ''
    await processFileList(files)
  }

  const handleDrop = async (event) => {
    event.preventDefault()
    setIsDragging(false)
    if (uploading) return
    const files = event.dataTransfer.files
    if (files && files.length > 0) {
      await processFileList(files)
    }
  }

  const handleDragOver = (event) => {
    event.preventDefault()
    if (!uploading && !isDragging) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (event) => {
    event.preventDefault()
    setIsDragging(false)
  }

  const retryUpload = async (index) => {
    const item = uploadItems[index]
    if (!item || uploading) return
    setUploading(true)
    setError('')
    await uploadSingleFile(item.file, index)
    setUploading(false)
    await loadPhotos(pagination.page)
  }

  const clearUploadItems = () => {
    if (!uploading) {
      setUploadItems([])
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

    let pickerWindow
    let sessionId

    try {
      console.info('[GooglePhotos] BUTTON_CLICKED: User clicked Import from Google Photos')

      // Open a blank popup synchronously within the click handler to avoid popup blocking.
      // Navigate it to the pickerUri after we receive it from the backend.
      console.info('[GooglePhotos] POPUP_CREATED: Opening blank popup window')
      pickerWindow = window.open('', '_blank', 'noopener,noreferrer,width=800,height=600')
      if (!pickerWindow) throw new Error('Allow pop-ups to open Google Photos.')
      console.info('[GooglePhotos] POPUP_CREATED: Blank popup opened successfully')

      setMessage('Opening Google Photos...')

      console.info('[GooglePhotos] SESSION_CREATE_STARTED: Requesting picker session from backend')
      const { data: session } = await api.post('/photos/google/session')
      sessionId = session.sessionId
      console.info('[GooglePhotos] SESSION_CREATED: Picker session created', {
        sessionId: session.sessionId,
        hasPickerUri: Boolean(session.pickerUri),
        pickerUriPrefix: session.pickerUri?.slice(0, 80),
      })

      console.info('[GooglePhotos] PICKER_OPENED: Navigating popup to pickerUri')
      if (!session.pickerUri || typeof session.pickerUri !== 'string' || !session.pickerUri.startsWith('http')) {
        console.error('[GooglePhotos] IMPORT_FAILED: Invalid or missing pickerUri', {
          pickerUri: session.pickerUri,
          session,
        })
        pickerWindow?.close()
        throw new Error('Invalid picker URI received from server')
      }
      pickerWindow.location = session.pickerUri

      setMessage('Waiting for photo selection...')

      console.info('[GooglePhotos] POLLING_STARTED: Polling session for selection completion')
      let selectionComplete = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { data: status } = await api.get(`/photos/google/session/${sessionId}`)
        console.info(`[GooglePhotos] SESSION_STATUS: Poll attempt ${attempt + 1}`, {
          mediaItemsSet: status.mediaItemsSet,
          pollInterval: status.pollingConfig?.pollInterval,
        })
        if (status.mediaItemsSet) {
          selectionComplete = true
          console.info('[GooglePhotos] MEDIA_ITEMS_SET: Selection confirmed by Google Photos')
          break
        }
        await new Promise((resolve) =>
          setTimeout(resolve, parseGoogleDuration(status.pollingConfig?.pollInterval))
        )
      }

      if (!selectionComplete) {
        console.error('[GooglePhotos] IMPORT_FAILED: Selection timed out after 100 attempts')
        throw new Error('Google Photos selection timed out.')
      }

      setMessage('Selection completed.')

      console.info('[GooglePhotos] MEDIA_RETRIEVAL_STARTED: Importing selected photos')
      const { data: importResult } = await api.post('/photos/google/import', { sessionId })
      console.info('[GooglePhotos] MEDIA_RETRIEVED: Import result', {
        selectedCount: importResult?.selectedCount,
        importedCount: importResult?.importedCount,
        failureCount: importResult?.failures?.length,
      })
      const importedCount = importResult?.importedCount ?? importResult?.photos?.length ?? 0
      const selectedCount = importResult?.selectedCount ?? 0

      if (selectedCount) {
        setMessage(`Found ${selectedCount} selected photos. Importing photos...`)
      } else {
        setMessage('Importing photos...')
      }

      if (importedCount) {
        setMessage(`${importedCount} photos imported successfully.`)
      } else {
        setMessage('Google Photos added to your gallery.')
      }

      console.info('[GooglePhotos] GALLERY_REFRESH_SUCCESS: Reloading gallery')
      await loadPhotos(pagination.page)
      console.info('[GooglePhotos] All steps complete')
    } catch (requestError) {
      pickerWindow?.close()
      console.error('[GooglePhotos] IMPORT_FAILED', {
        message: requestError?.message,
        name: requestError?.name,
        stack: requestError?.stack,
        responseStatus: requestError?.response?.status,
        responseData: requestError?.response?.data,
        responseMessage: requestError?.response?.data?.message,
        requestUrl: requestError?.config?.url,
        requestMethod: requestError?.config?.method,
      })
      setError(requestError.response?.data?.message || requestError.message || 'Google Photos import failed.')
    } finally {
      setGoogleImporting(false)
    }
  }

  const handleDelete = async (photoId) => {
    if (deletingPhotoId) return
    if (!window.confirm('Delete this photo permanently?')) return
    setError('')
    setDeletingPhotoId(photoId)
    try {
      await api.delete(`/photos/${photoId}`)
      setPhotos((current) => current.filter((photo) => photo._id !== photoId))
      if (selectedPhoto?._id === photoId) setSelectedPhoto(null)
    } catch (requestError) {
      setError(
        requestError.response?.status === 404
          ? 'This photo has already been deleted.'
          : requestError.response?.data?.message || 'The photo could not be deleted.'
      )
    } finally {
      setDeletingPhotoId(null)
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
      setPhotos((current) =>
        current.map((currentPhoto) => (currentPhoto._id === photo._id ? data.photo : currentPhoto))
      )
      if (selectedPhoto?._id === photo._id) {
        setSelectedPhoto(data.photo)
      }
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

  const overallProgress = uploadItems.length
    ? Math.round(uploadItems.reduce((total, item) => total + item.progress, 0) / uploadItems.length)
    : 0

  const selectedIndex = selectedPhoto ? photos.findIndex((p) => p._id === selectedPhoto._id) : -1

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-[#29261f]">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 border-b border-[#e5ddce] bg-[#fffdfa]/95 backdrop-blur-md">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c75b39] text-white shadow-xs">
              <PhotoIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="font-serif text-xl font-bold tracking-tight text-[#29261f] sm:text-2xl">Pic Web</p>
              <p className="hidden text-xs uppercase tracking-widest text-[#8a8070] sm:block">Shared photo gallery</p>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            {user?.name && (
              <div className="flex items-center gap-2 rounded-full border border-[#e5ddce] bg-[#fbf9f5] px-3.5 py-1.5 text-xs font-medium text-[#5a5345]">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span>{user.name}</span>
              </div>
            )}
            <button
              className="button-secondary text-xs sm:text-sm"
              type="button"
              onClick={handleLogout}
            >
              Log out
            </button>
          </div>
        </nav>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        {/* Gallery Intro & Actions */}
        <section className="mb-8 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#c75b39]">The Collection</p>
            <h1 className="mt-1 font-serif text-3xl font-normal text-[#29261f] sm:text-5xl">Small moments, kept.</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#686154]">
              A peaceful, shared space for keeping and viewing high-fidelity photographs.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              onChange={handleUpload}
            />

            <button
              className="button-primary min-w-[150px]"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              <UploadIcon className="h-4 w-4" />
              <span>{uploading ? `Uploading ${overallProgress}%` : 'Upload Photos'}</span>
            </button>

            <button
              className="button-secondary"
              type="button"
              onClick={handleGooglePicker}
              disabled={googleImporting || uploading}
            >
              {googleImporting ? (
                <SpinnerIcon className="h-4 w-4 text-[#c75b39]" />
              ) : (
                <GoogleIcon className="h-4 w-4" />
              )}
              <span>{googleImporting ? 'Importing...' : googleReady ? 'Open Google Photos' : 'Import from Google Photos'}</span>
            </button>
          </div>
        </section>

        {/* Drag and Drop Upload Area */}
        <section
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !uploading && fileInput.current?.click()}
          onKeyDown={(event) => {
            if (!uploading && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              fileInput.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload photos by drag and drop or browsing"
          className={`group mb-8 cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition-all duration-200 outline-none focus-visible:ring-4 focus-visible:ring-[#c75b39]/20 sm:p-8 ${
            isDragging
              ? 'border-[#c75b39] bg-[#faeee8] ring-4 ring-[#c75b39]/20'
              : 'border-[#d8cebe] bg-[#fffdfa]/70 hover:border-[#c75b39]/60 hover:bg-[#fffdfa]'
          }`}
        >
          <div className="mx-auto flex max-w-md flex-col items-center">
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-transform duration-200 group-hover:scale-105 ${
                isDragging ? 'bg-[#c75b39] text-white' : 'bg-[#faeee8] text-[#c75b39]'
              }`}
            >
              <UploadIcon className="h-6 w-6" />
            </div>

            <p className="mt-3 text-sm font-semibold text-[#29261f]">
              {isDragging ? 'Drop photos to upload now' : 'Drag & drop photos here, or click to browse'}
            </p>

            <p className="mt-1 text-xs text-[#7e7465]">
              Supports JPEG, PNG, WebP, HEIC/HEIF up to 10 MB each (max 20 images)
            </p>

            <div
              className="mt-4 w-full max-w-sm"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <input
                className="field text-center text-xs sm:text-sm"
                type="text"
                maxLength={500}
                placeholder="Optional description for uploaded photos..."
                value={uploadDescription}
                onChange={(event) => setUploadDescription(event.target.value)}
                disabled={uploading}
              />
            </div>
          </div>
        </section>

        {/* Upload Progress Queue */}
        {uploadItems.length > 0 && (
          <div className="mb-8 rounded-2xl border border-[#ded5c5] bg-[#fffdfa] p-4 shadow-xs sm:p-5" aria-live="polite">
            <div className="flex items-center justify-between border-b border-[#f0ebd9] pb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[#29261f]">Upload Progress</span>
                <span className="rounded-full bg-[#f4ece0] px-2 py-0.5 text-xs font-medium text-[#746957]">
                  {uploadItems.filter((item) => item.status === 'uploaded').length} / {uploadItems.length}
                </span>
              </div>
              {!uploading && (
                <button
                  type="button"
                  onClick={clearUploadItems}
                  className="text-xs font-semibold text-[#7e7465] hover:text-[#29261f]"
                >
                  Clear list
                </button>
              )}
            </div>

            {uploading && (
              <div className="mt-3">
                <div className="flex justify-between text-xs font-medium text-[#686154]">
                  <span>Total progress</span>
                  <span>{overallProgress}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#eee7db]">
                  <div
                    className="h-full rounded-full bg-[#c75b39] transition-all duration-300"
                    style={{ width: `${overallProgress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
              {uploadItems.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex flex-col rounded-xl border border-[#ede6d8] bg-[#fbf9f5] px-3.5 py-2.5 text-xs transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-[#29261f]">{item.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.status === 'uploading' && (
                        <span className="flex items-center gap-1 font-semibold text-[#c75b39]">
                          <SpinnerIcon className="h-3 w-3" />
                          <span>{item.progress}%</span>
                        </span>
                      )}
                      {item.status === 'uploaded' && (
                        <span className="flex items-center gap-1 font-semibold text-emerald-700">
                          <CheckCircleIcon className="h-3.5 w-3.5" />
                          <span>Uploaded</span>
                        </span>
                      )}
                      {item.status === 'failed' && (
                        <button
                          className="font-bold text-[#b84f31] hover:underline"
                          type="button"
                          onClick={() => retryUpload(index)}
                          disabled={uploading}
                        >
                          Retry
                        </button>
                      )}
                      {item.status === 'queued' && <span className="text-[#8c8272]">Queued</span>}
                    </div>
                  </div>

                  {item.status === 'failed' && (
                    <p className="mt-1 text-xs text-[#9a3f2b]">{item.error}</p>
                  )}

                  {item.status === 'uploading' && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e8e1d3]">
                      <div
                        className="h-full rounded-full bg-[#c75b39] transition-all duration-150"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status Alerts */}
        {message && (
          <div
            className="mb-6 flex items-start justify-between gap-3 rounded-2xl border border-emerald-200 bg-[#edf6ee] px-4 py-3.5 text-sm text-[#275929]"
            role="status"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-600" />
              <span>{message}</span>
            </div>
            <button
              type="button"
              onClick={() => setMessage('')}
              className="text-[#275929]/70 hover:text-[#275929]"
              aria-label="Dismiss message"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        {error && (
          <div
            className="mb-6 flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-[#faebe7] px-4 py-3.5 text-sm text-[#9a3f2b]"
            role="alert"
          >
            <div className="flex items-center gap-2.5">
              <AlertCircleIcon className="h-5 w-5 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => setError('')}
              className="text-[#9a3f2b]/70 hover:text-[#9a3f2b]"
              aria-label="Dismiss error"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Gallery Content */}
        {loading ? (
          /* Loading Skeletons */
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-6">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={`skeleton-${index}`}
                className="overflow-hidden rounded-2xl border border-[#e5ddce] bg-[#fffdfa] shadow-2xs"
              >
                <div className="skeleton aspect-4/5 w-full" />
                <div className="p-3.5 space-y-2">
                  <div className="skeleton h-4 w-3/4 rounded-md" />
                  <div className="skeleton h-3 w-1/2 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : photos.length ? (
          /* Responsive Image Grid */
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-6">
            {photos.map((photo) => {
              const ownerId = photo.owner?._id ?? photo.owner
              const ownedByUser = String(ownerId) === String(user?.id)

              return (
                <article
                  className="group relative flex flex-col overflow-hidden rounded-2xl border border-[#ded5c5] bg-[#fffdfa] shadow-xs transition-all duration-300 hover:border-[#c75b39]/40 hover:shadow-md"
                  key={photo._id}
                >
                  <div className="relative aspect-4/5 w-full overflow-hidden bg-[#ebe4d6]">
                    <button
                      className="block h-full w-full cursor-zoom-in text-left outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#c75b39]"
                      type="button"
                      onClick={() => openLightbox(photo)}
                      aria-label={`Open ${photo.originalFilename}`}
                    >
                      <img
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                        src={imageUrl(photo._id)}
                        alt={photo.originalFilename}
                        loading="lazy"
                      />
                    </button>

                    {/* Gradient overlay on hover with metadata */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent p-4 text-white opacity-90 sm:opacity-0 sm:transition-opacity sm:duration-200 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <p className="truncate text-sm font-semibold">{photo.originalFilename}</p>
                      <p className="mt-0.5 truncate text-xs text-white/80">
                        {photo.owner?.name || 'Photographer'} · {formatUploadDate(photo.createdAt)}
                      </p>
                    </div>

                    {/* Delete action for owned photos */}
                    {ownedByUser && (
                      <button
                        className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-xs transition hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 disabled:opacity-50"
                        type="button"
                        onClick={() => handleDelete(photo._id)}
                        disabled={deletingPhotoId === photo._id}
                        aria-label={`Delete ${photo.originalFilename}`}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                        <span>{deletingPhotoId === photo._id ? 'Deleting...' : 'Delete'}</span>
                      </button>
                    )}
                  </div>

                  {/* Card Description & Details */}
                  <div className="flex flex-1 flex-col justify-between p-3.5 text-xs text-[#524b3e]">
                    {editingPhotoId === photo._id ? (
                      <div className="space-y-2">
                        <label
                          className="block font-semibold uppercase tracking-wider text-[#7e7465]"
                          htmlFor={`description-${photo._id}`}
                        >
                          Edit Description
                        </label>
                        <textarea
                          id={`description-${photo._id}`}
                          className="field min-h-18 resize-y px-3 py-2 text-xs"
                          maxLength={500}
                          value={editDescription}
                          onChange={(event) => setEditDescription(event.target.value)}
                        />
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            className="button-secondary px-2.5 py-1 text-xs"
                            type="button"
                            onClick={cancelDescriptionEdit}
                            disabled={savingDescription}
                          >
                            Cancel
                          </button>
                          <button
                            className="button-primary px-3 py-1 text-xs"
                            type="button"
                            onClick={() => handleDescriptionSave(photo)}
                            disabled={savingDescription}
                          >
                            {savingDescription ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-h-5 flex-1 whitespace-pre-wrap break-words leading-relaxed text-[#484236]">
                          {photo.description || <span className="italic text-[#9e9483]">No description</span>}
                        </p>
                        {ownedByUser && (
                          <button
                            className="inline-flex shrink-0 items-center gap-1 font-semibold text-[#b84f31] hover:text-[#8f3b25] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c75b39]"
                            type="button"
                            onClick={() => startDescriptionEdit(photo)}
                            aria-label={`Edit description for ${photo.originalFilename}`}
                          >
                            <EditIcon className="h-3 w-3" />
                            <span>Edit</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          /* Clean Empty Gallery Screen */
          <div className="rounded-3xl border-2 border-dashed border-[#d8cebe] bg-[#fffdfa]/80 px-6 py-16 text-center sm:py-24">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-[#faeee8] text-[#c75b39]">
              <PhotoIcon className="h-8 w-8" />
            </div>
            <h2 className="mt-5 font-serif text-2xl font-normal text-[#29261f] sm:text-3xl">
              Your gallery is waiting.
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#746b5d]">
              Choose a few images from your device and make this space yours.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                className="button-primary"
                type="button"
                onClick={() => fileInput.current?.click()}
              >
                <UploadIcon className="h-4 w-4" />
                <span>Upload Photos</span>
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={handleGooglePicker}
              >
                <GoogleIcon className="h-4 w-4" />
                <span>Import from Google Photos</span>
              </button>
            </div>
          </div>
        )}

        {/* Pagination Navigation */}
        {pagination.totalPages > 1 && (
          <nav
            className="mt-10 flex items-center justify-center gap-3 sm:gap-4"
            aria-label="Gallery pages"
          >
            <button
              className="button-secondary"
              type="button"
              disabled={loading || pagination.page <= 1}
              onClick={() => loadPhotos(pagination.page - 1)}
            >
              <ChevronLeftIcon className="h-4 w-4" />
              <span>Previous</span>
            </button>
            <span className="px-2 text-xs font-medium text-[#746b5d] sm:text-sm">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              className="button-secondary"
              type="button"
              disabled={loading || pagination.page >= pagination.totalPages}
              onClick={() => loadPhotos(pagination.page + 1)}
            >
              <span>Next</span>
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </nav>
        )}
      </main>

      {/* Lightbox Modal */}
      {selectedPhoto && (() => {
        const selectedOwnerId = selectedPhoto.owner?._id ?? selectedPhoto.owner
        const selectedPhotoIsOwned = String(selectedOwnerId) === String(user?.id)

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-3 backdrop-blur-sm sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`Photo details for ${selectedPhoto.originalFilename}`}
            onClick={() => setSelectedPhoto(null)}
            onTouchStart={handleLightboxTouchStart}
            onTouchEnd={handleLightboxTouchEnd}
          >
            <div
              className="relative flex w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-[#ded5c5] bg-[#fffdfa] shadow-2xl"
              onClick={(event) => event.stopPropagation()}
              onTouchStart={(event) => {
                event.stopPropagation()
                handleLightboxTouchStart(event)
              }}
              onTouchEnd={(event) => {
                event.stopPropagation()
                handleLightboxTouchEnd(event)
              }}
            >
              {/* Lightbox Header Bar */}
              <div className="flex items-center justify-between border-b border-[#eee7da] px-5 py-4">
                <div className="min-w-0 pr-4">
                  <p className="truncate text-base font-semibold text-[#29261f]">
                    {selectedPhoto.originalFilename}
                  </p>
                  <p className="mt-0.5 text-xs text-[#7e7465]">
                    Uploaded by {selectedPhoto.owner?.name || 'Photographer'} · {formatUploadDate(selectedPhoto.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {selectedIndex >= 0 && (
                    <span className="hidden rounded-full bg-[#f4ece0] px-3 py-1 text-xs font-medium text-[#6c614f] sm:inline-block">
                      {selectedIndex + 1} of {photos.length}
                    </span>
                  )}
                  <button
                    ref={lightboxCloseButton}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#d8cebe] bg-[#fdfaf5] px-3.5 py-1.5 text-xs font-bold text-[#554d3f] transition hover:border-[#c75b39] hover:text-[#b84f31] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c75b39]"
                    type="button"
                    onClick={() => setSelectedPhoto(null)}
                    aria-label="Close photo view"
                  >
                    <CloseIcon className="h-4 w-4" />
                    <span>Close</span>
                    <span className="hidden text-[10px] uppercase text-[#9e9483] sm:inline">(Esc)</span>
                  </button>
                </div>
              </div>

              {/* Main Image Stage */}
              <div className="relative flex min-h-[300px] max-h-[72vh] items-center justify-center overflow-hidden bg-[#181614]">
                {lightboxImageLoading && (
                  <div className="absolute z-10 flex flex-col items-center gap-2 text-white/90" role="status">
                    <SpinnerIcon className="h-7 w-7 text-[#c75b39]" />
                    <span className="text-xs tracking-wider uppercase">Loading image...</span>
                  </div>
                )}

                {lightboxImageError ? (
                  <div className="p-8 text-center text-white" role="alert">
                    <AlertCircleIcon className="mx-auto h-8 w-8 text-red-400" />
                    <p className="mt-2 text-sm font-medium">This image could not be loaded.</p>
                  </div>
                ) : (
                  <img
                    className={`max-h-[72vh] w-auto max-w-full object-contain transition-opacity duration-300 ${
                      lightboxImageLoading ? 'opacity-0' : 'opacity-100'
                    }`}
                    src={imageUrl(selectedPhoto._id)}
                    alt={selectedPhoto.originalFilename}
                    onLoad={() => setLightboxImageLoading(false)}
                    onError={() => {
                      setLightboxImageLoading(false)
                      setLightboxImageError(true)
                    }}
                  />
                )}

                {/* Left Navigation Arrow */}
                {photos.findIndex((photo) => photo._id === selectedPhoto._id) > 0 && (
                  <button
                    className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2.5 text-white backdrop-blur-xs transition hover:scale-110 hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    type="button"
                    onClick={() => navigateLightbox(-1)}
                    aria-label="Previous photo"
                  >
                    <ChevronLeftIcon className="h-6 w-6" />
                  </button>
                )}

                {/* Right Navigation Arrow */}
                {(photos.findIndex((photo) => photo._id === selectedPhoto._id) < photos.length - 1 ||
                  pagination.page < pagination.totalPages) && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2.5 text-white backdrop-blur-xs transition hover:scale-110 hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    type="button"
                    onClick={() => navigateLightbox(1)}
                    aria-label="Next photo"
                  >
                    <ChevronRightIcon className="h-6 w-6" />
                  </button>
                )}
              </div>

              {/* Lightbox Footer & Actions */}
              <div className="flex flex-col gap-4 border-t border-[#eee7da] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 pr-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#8a8070]">Description</p>
                  <p className="mt-0.5 text-sm text-[#484236]">
                    {selectedPhoto.description || <span className="italic text-[#9e9483]">No description provided</span>}
                  </p>
                </div>

                {selectedPhotoIsOwned && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      className="button-secondary border-[#b84f31] text-xs font-semibold text-[#b84f31] hover:bg-[#faeee8]"
                      type="button"
                      onClick={() => handleDelete(selectedPhoto._id)}
                      disabled={deletingPhotoId === selectedPhoto._id}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                      <span>{deletingPhotoId === selectedPhoto._id ? 'Deleting...' : 'Delete photo'}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
