# Pic Web

Personal photo gallery with user authentication and optional Google Photos import.

## Stack

- **Client:** React 19, Vite, Tailwind CSS, React Router, Axios (`client/`)
- **Server:** Express 5, Mongoose (MongoDB), GridFS file storage, bcrypt, JWT (`server/`)
- **Tests:** Vitest, Supertest, mongodb-memory-server (`server/tests/`)

## Local setup

1. Copy the environment example:
   ```sh
   cp .env.example .env
   ```
   Fill in `MONGO_URI`, `JWT_SECRET` (32+ chars), `CLIENT_ORIGIN`, `TRUST_PROXY`, SMTP settings, and `MAIL_FROM`. Google variables are optional unless you use Google Photos import.

2. Install dependencies (root + workspaces):
   ```sh
   npm install
   npm --prefix client install
   npm --prefix server install
   ```

## Run locally

Start the server with an in-memory MongoDB (no external database required):
```sh
npm --prefix server run dev:local
```
For real Gmail delivery, add `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=your Gmail address`, `SMTP_PASS=your 16-character Gmail App Password`, and `MAIL_FROM=Pic Web <your Gmail address>` to `server/.env`. Do not use your normal Gmail password. If these values are absent, local development prints the OTP to the server console with a `[DEV ONLY]` marker instead of sending email.

Start the client (Vite dev server on http://localhost:5173, proxies `/api` to :5000):
```sh
npm --prefix client run dev
```

Or run both from the root:
```sh
npm run dev:local   # server only
npm run dev         # client only
```

## Test

```sh
npm test
```

## Deployment security checklist

- **Required server environment:** set a unique `MONGO_URI`, a randomly generated `JWT_SECRET` of at least 32 characters, `CLIENT_ORIGIN` to the exact HTTPS frontend origin, and `TRUST_PROXY` to the number of trusted reverse proxies (or the documented proxy configuration).
- **Email OTP environment:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` (use a Gmail App Password, never a normal account password), and `MAIL_FROM`.
- **Google OAuth, if enabled:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_REDIRECT_URI`, and `GOOGLE_PHOTOS_REDIRECT_URI` to the exact registered callback URLs. For local development, the root `.env` is authoritative when both env files exist. Google Photos also needs a unique `GOOGLE_TOKEN_ENCRYPTION_KEY` of at least 32 characters.
- **HTTPS:** terminate TLS at the proxy or hosting platform, serve the frontend and API over HTTPS, and verify HSTS. Production authentication cookies are Secure and will not work over plain HTTP.
- **MongoDB Atlas:** create a least-privilege database user, restrict the IP allowlist to application egress IPs (never `0.0.0.0/0`), use TLS, enable monitoring, and test restore procedures from automated backups.
- **Secrets and rotation:** store secrets in the deployment secret manager, never commit `.env`, rotate JWT, Google, SMTP, and encryption secrets on a schedule and immediately after suspected exposure. Rotating `JWT_SECRET` invalidates active sessions; rotate the Google encryption key only with a planned token re-encryption/migration.
- **Operations:** review upload limits and quota for expected traffic, monitor authentication failures and SMTP delivery, and keep dependencies patched.
- **Dependency audit:** run `npm --prefix server audit --omit=dev` during deployment checks; the production server dependency tree should report no vulnerabilities.

## API

- `POST /api/auth/register` — create account
- `POST /api/auth/verify-otp` — verify signup OTP
- `POST /api/auth/resend-otp` — send a replacement signup OTP
- `POST /api/auth/login` — set httpOnly JWT cookie
- `GET /api/auth/google` — start Google login OAuth
- `GET /api/auth/google/callback` — complete Google login OAuth
- `POST /api/auth/logout` — clear cookie
- `GET /api/auth/me` — current user
- `GET /api/photos` — list your photos (paginated)
- `POST /api/photos` — upload images (max 20 files, 10 MB each)
- `PATCH /api/photos/:id` — update a photo description (max 500 characters)
- `GET /api/photos/:id/file` — download your photo
- `DELETE /api/photos/:id` — delete your photo
- `GET /api/health` — health check
- `GET /api/google/auth` — start Google Photos OAuth
- `GET /api/google/callback` — OAuth callback
