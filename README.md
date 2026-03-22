# Watch Together

Synchronized video watching with server-side streaming. Upload once, everyone watches in sync.

## Features
- 🎬 Upload video to Railway server — all viewers stream directly from it
- 🔄 Synchronized playback (host controls, viewers follow)
- 💬 Live chat with emoji avatars
- 👥 Friends system with online presence
- 🔐 Persistent sessions (PBKDF2 password hashing, sessions survive restarts)
- 🌙 Dark / light themes, 4 languages
- 📁 Auto video cleanup (2h TTL after room closes)
- 📱 Mobile responsive

## Deploy to Railway

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Watch Together v2"
git remote add origin https://github.com/YOU/watch-together.git
git push -u origin main
```

### 2. Create Railway project
1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select your repo
3. Railway auto-detects Node.js and runs `npm start`

### 3. Add persistent volume (IMPORTANT for uploads & user data)
1. In Railway dashboard → your service → **Volumes**
2. Add volume → mount path: `/app` (or wherever your project root is)
   - This ensures `uploads/` and `data/` survive redeploys

### 4. Environment variables (optional)
```
PORT=3000        # Railway sets this automatically
NODE_ENV=production
```

### 5. Done!
Railway gives you a URL like `https://watch-together-xxx.railway.app`

## Local development
```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Architecture
- `server.js` — Express + WebSocket server
- `public/index.html` — Single-page frontend
- `uploads/` — Uploaded videos (auto-cleaned after 2h)
- `data/users.json` — User accounts (atomic writes)
- `data/sessions.json` — Auth sessions (30-day TTL)

## Video flow
1. Host uploads video → stored in `uploads/` on Railway
2. Server notifies all viewers via WebSocket
3. All viewers stream video directly from `/video/:filename` endpoint
4. Host controls playback → synced to all via WebSocket every 250ms

## Security
- Passwords: PBKDF2 with per-user salt (100k iterations, SHA-512)
- Sessions: 32-byte random tokens, 30-day expiry
- Legacy SHA-256 accounts auto-migrated on next login
- Video files: sanitized filenames, type validation
- File size limit: 4GB
