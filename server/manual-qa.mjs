import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const base = 'http://localhost:5000/api'
const results = []
const jar = new Map()

const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const parseCookies = (response) => {
  const raw = response.headers.getSetCookie?.() || []
  for (const cookie of raw) {
    const [pair] = cookie.split(';')
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
}

const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

const api = async (method, urlPath, { body, formData, expectStatus } = {}) => {
  const headers = {}
  if (jar.size) headers.Cookie = cookieHeader()
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: formData || (body !== undefined ? JSON.stringify(body) : undefined),
  })
  parseCookies(response)

  let data = null
  const text = await response.text()
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (expectStatus !== undefined && response.status !== expectStatus) {
    throw new Error(`expected ${expectStatus}, got ${response.status}: ${text}`)
  }
  return { status: response.status, data, headers: response.headers, raw: response }
}

const makeJpeg = (width = 800, height = 600, color = { r: 40, g: 120, b: 200 }) =>
  sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer()

const clearJar = () => jar.clear()

try {
  // --- Health ---
  {
    const { status, data } = await api('GET', '/health')
    record('Health endpoint', status === 200 && data?.status === 'ok', `status=${status}`)
  }

  // --- Auth validation ---
  {
    const { status } = await api('POST', '/auth/register', {
      body: { name: '', email: 'bad', password: 'short' },
    })
    record('Register rejects invalid payload', status === 400, `status=${status}`)
  }

  {
    const { status } = await api('POST', '/auth/login', {
      body: { email: 'nobody@example.com', password: 'password123' },
    })
    record('Login rejects unknown user', status === 401, `status=${status}`)
  }

  {
    const { status } = await api('GET', '/auth/me')
    record('GET /me without cookie is 401', status === 401, `status=${status}`)
  }

  {
    const { status } = await api('GET', '/photos')
    record('GET /photos without auth is 401', status === 401, `status=${status}`)
  }

  // --- Register owner ---
  clearJar()
  const ownerEmail = `owner_${Date.now()}@test.local`
  {
    const { status, data, headers } = await api('POST', '/auth/register', {
      body: { name: 'Owner Tester', email: ownerEmail, password: 'password123' },
      expectStatus: 201,
    })
    const setCookie = headers.getSetCookie?.().join(';') || ''
    record(
      'Register creates user + httpOnly cookie',
      status === 201 && data.user?.email === ownerEmail && setCookie.includes('HttpOnly') && !JSON.stringify(data).includes('passwordHash'),
      `id=${data.user?.id}`,
    )
  }

  {
    const { status, data } = await api('GET', '/auth/me', { expectStatus: 200 })
    record('GET /me returns authenticated user', status === 200 && data.user?.email === ownerEmail && data.user.googleConnected === false)
  }

  {
    const { status } = await api('POST', '/auth/register', {
      body: { name: 'Dup', email: ownerEmail, password: 'password123' },
    })
    record('Duplicate email rejected', status === 400, `status=${status}`)
  }

  // --- Logout / login ---
  {
    const { status } = await api('POST', '/auth/logout', { expectStatus: 204 })
    record('Logout returns 204', status === 204)
  }

  {
    const { status } = await api('GET', '/auth/me')
    record('Session cleared after logout', status === 401, `status=${status}`)
  }

  {
    const { status, data } = await api('POST', '/auth/login', {
      body: { email: ownerEmail, password: 'wrong-password' },
    })
    record('Wrong password rejected', status === 401, `status=${status}`)
  }

  {
    const { status, data } = await api('POST', '/auth/login', {
      body: { email: ownerEmail, password: 'password123' },
      expectStatus: 200,
    })
    record('Login with correct password', status === 200 && data.user?.email === ownerEmail)
  }

  // --- Photo upload ---
  const image = await makeJpeg()
  let photoId
  {
    const form = new FormData()
    form.append('photos', new Blob([image], { type: 'image/jpeg' }), 'sky.jpg')
    const { status, data } = await api('POST', '/photos', { formData: form, expectStatus: 201 })
    photoId = data.photos?.[0]?._id
    record('Upload JPEG succeeds', status === 201 && Boolean(photoId), `photoId=${photoId}`)
  }

  {
    const form = new FormData()
    form.append('photos', new Blob([Buffer.from('not-an-image')], { type: 'text/plain' }), 'notes.txt')
    const { status } = await api('POST', '/photos', { formData: form })
    record('Non-image upload rejected', status === 400, `status=${status}`)
  }

  {
    const form = new FormData()
    form.append('photos', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), 'huge.jpg')
    const { status } = await api('POST', '/photos', { formData: form })
    record('Oversized upload rejected (413)', status === 413, `status=${status}`)
  }

  {
    const { status, data } = await api('GET', '/photos?limit=20', { expectStatus: 200 })
    const found = data.photos?.some((p) => p._id === photoId)
    record('List photos includes uploaded image', status === 200 && found && data.pagination?.total >= 1, `total=${data.pagination?.total}`)
  }

  {
    const { status } = await api('GET', '/photos?page=0&limit=20')
    record('Invalid pagination rejected', status === 400, `status=${status}`)
  }

  {
    const response = await fetch(`${base}/photos/${photoId}/file`, { headers: { Cookie: cookieHeader() } })
    const buf = Buffer.from(await response.arrayBuffer())
    const meta = await sharp(buf).metadata()
    record(
      'Photo file served as resized JPEG',
      response.status === 200 && response.headers.get('content-type')?.includes('image/jpeg') && meta.format === 'jpeg' && meta.width <= 1600,
      `w=${meta.width} h=${meta.height}`,
    )
  }

  // --- Second user permissions ---
  const ownerCookies = new Map(jar)
  clearJar()
  const otherEmail = `other_${Date.now()}@test.local`
  await api('POST', '/auth/register', {
    body: { name: 'Other Tester', email: otherEmail, password: 'password123' },
    expectStatus: 201,
  })

  {
    const { status, data } = await api('GET', '/photos', { expectStatus: 200 })
    const canSee = data.photos?.some((p) => p._id === photoId)
    record('Other user can see shared gallery photo', canSee === true)
  }

  {
    const { status } = await api('DELETE', `/photos/${photoId}`)
    record('Other user cannot delete owner photo (403)', status === 403, `status=${status}`)
  }

  // Restore owner session
  jar.clear()
  for (const [k, v] of ownerCookies) jar.set(k, v)

  {
    const { status } = await api('DELETE', `/photos/${photoId}`, { expectStatus: 204 })
    record('Owner can delete own photo', status === 204)
  }

  {
    const { status } = await api('GET', `/photos/${photoId}/file`)
    record('Deleted photo file is gone', status === 404, `status=${status}`)
  }

  {
    const { status } = await api('DELETE', '/photos/not-an-id')
    record('Invalid photo id rejected', status === 400, `status=${status}`)
  }

  // --- Google endpoints without config / connection ---
  {
    const { status } = await api('POST', '/photos/google/session')
    record('Google session without connection returns 409', status === 409 || status === 502, `status=${status}`)
  }

  {
    const response = await fetch(`${base}/google/auth`, {
      headers: { Cookie: cookieHeader() },
      redirect: 'manual',
    })
    // With placeholder Google credentials, may 503 or redirect to Google
    record(
      'Google auth route responds (503 if unconfigured)',
      response.status === 503 || response.status === 302 || response.status === 307,
      `status=${response.status}`,
    )
  }

  // Multi upload
  {
    const form = new FormData()
    form.append('photos', new Blob([await makeJpeg(400, 400, { r: 200, g: 80, b: 40 })], { type: 'image/jpeg' }), 'a.jpg')
    form.append('photos', new Blob([await makeJpeg(500, 300, { r: 80, g: 180, b: 90 })], { type: 'image/jpeg' }), 'b.jpg')
    const { status, data } = await api('POST', '/photos', { formData: form, expectStatus: 201 })
    record('Multi-file upload (2 photos)', status === 201 && data.photos?.length === 2, `count=${data.photos?.length}`)
  }
} catch (error) {
  record('Unexpected tester crash', false, error.message)
}

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
console.log('\n========== QA SUMMARY ==========')
console.log(`Passed: ${passed}/${results.length}`)
if (failed.length) {
  console.log('Failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
} else {
  console.log('All manual QA checks passed.')
}
