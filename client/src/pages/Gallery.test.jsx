import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Gallery from './Gallery'
import api from '../lib/api'

const navigate = vi.fn()
const logout = vi.fn()

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock('../context/useAuth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', name: 'Owner' }, logout }),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}))

const photos = [
  { _id: 'photo-1', originalFilename: 'one.jpg', owner: { _id: 'owner-1', name: 'Owner' }, createdAt: '2026-01-01T00:00:00.000Z', description: '' },
  { _id: 'photo-2', originalFilename: 'two.jpg', owner: { _id: 'other-1', name: 'Other' }, createdAt: '2026-01-02T00:00:00.000Z', description: '' },
  { _id: 'photo-3', originalFilename: 'three.jpg', owner: { _id: 'owner-1', name: 'Owner' }, createdAt: '2026-01-03T00:00:00.000Z', description: '' },
]

const listResponse = (items = photos, page = 1, totalPages = 1) => ({
  data: { photos: items, pagination: { page, totalPages, total: items.length } },
})

beforeEach(() => {
  vi.clearAllMocks()
  document.body.style.overflow = ''
  api.get.mockResolvedValue(listResponse())
  api.delete.mockResolvedValue({ status: 204 })
  api.patch.mockResolvedValue({ data: { photo: { ...photos[0], description: 'Updated description' } } })
  window.confirm = vi.fn(() => true)
})

afterEach(() => {
  cleanup()
})

describe('Gallery lightbox and navigation', () => {
  it('opens a photo, locks scrolling, navigates with arrows, and closes with Escape', async () => {
    render(<Gallery />)
    await screen.findByText('one.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Open one.jpg' }))
    expect(await screen.findByRole('dialog')).toHaveAttribute('aria-label', 'Photo details for one.jpg')
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await screen.findByRole('dialog')).toHaveAttribute('aria-label', 'Photo details for two.jpg')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.body.style.overflow).toBe('')
  })

  it('loads the adjacent page when navigating beyond the current page', async () => {
    api.get
      .mockResolvedValueOnce(listResponse([photos[0]], 1, 2))
      .mockResolvedValueOnce(listResponse([photos[1]], 2, 2))
    render(<Gallery />)
    await screen.findByText('one.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Open one.jpg' }))
    fireEvent.keyDown(window, { key: 'ArrowRight' })

    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Photo details for two.jpg'))
    expect(api.get).toHaveBeenLastCalledWith('/photos?page=2&limit=20')
  })

  it('deletes the current owned photo after confirmation and refreshes the gallery', async () => {
    render(<Gallery />)
    await screen.findByText('one.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Open one.jpg' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/photos/photo-1'))
    expect(window.confirm).toHaveBeenCalledWith('Delete this photo permanently?')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('Gallery UI enhancements', () => {
  it('displays the empty-gallery screen when no photos are present', async () => {
    api.get.mockResolvedValueOnce(listResponse([], 1, 1))
    render(<Gallery />)

    expect(await screen.findByText('Your gallery is waiting.')).toBeInTheDocument()
    expect(screen.getByText('Choose a few images from your device and make this space yours.')).toBeInTheDocument()
  })

  it('renders a drag-and-drop upload zone and handles dropped image files', async () => {
    api.post.mockResolvedValueOnce({ data: { photos: [{ _id: 'photo-new' }] } })
    render(<Gallery />)
    await screen.findByText('one.jpg')

    const dropzone = screen.getByRole('button', { name: 'Upload photos by drag and drop or browsing' })
    expect(dropzone).toBeInTheDocument()

    const file = new File(['dummy-content'], 'summer.jpg', { type: 'image/jpeg' })
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [file],
      },
    })

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/photos',
      expect.any(FormData),
      expect.objectContaining({ headers: { 'Content-Type': 'multipart/form-data' } })
    ))
  })

  it('allows editing and saving a photo description for owned photos', async () => {
    render(<Gallery />)
    await screen.findByText('one.jpg')

    const editButton = screen.getByRole('button', { name: 'Edit description for one.jpg' })
    fireEvent.click(editButton)

    const textarea = screen.getByLabelText('Edit Description')
    fireEvent.change(textarea, { target: { value: 'New sunset photo' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/photos/photo-1', {
      description: 'New sunset photo',
    }))
  })
})
