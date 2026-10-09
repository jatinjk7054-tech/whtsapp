# Jatin — Full-stack starter

Backend aur frontend alag-alag folders mein hain, dono apna dev server chalate hain aur `/api` ke through baat karte hain.

```
jatin/
├── backend/          Express + PostgreSQL REST API (port 4000)
├── frontend/         React + Vite client (port 5173)
└── package.json      Root scripts (dono ek saath chalane ke liye)
```

## Setup

### 1. PostgreSQL

Docker use kar rahe ho:

```bash
cd backend
docker compose up -d
```

Docker nahi hai? Local PostgreSQL install karke `backend/.env` mein credentials match kar lo. `npm run migrate` database khud create kar deta hai (agar user ko CREATE DATABASE permission ho).

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env     # Windows: Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

### Ya dono ek saath (repo root se)

```bash
npm run install:all
npm run migrate
npm run dev
```

Frontend `http://localhost:5173` par khulega, API `http://localhost:4000` par. Vite dev server `/api` ko backend par proxy karta hai, isliye browser me koi CORS issue nahi aayega.

## API

Base URL: `http://localhost:4000/api`

| Method | Route | Description |
| --- | --- | --- |
| GET | `/health` | Health + database check |
| GET | `/tasks` | List tasks (`?completed=true&sort=title_asc&limit=50&offset=0`) |
| GET | `/tasks/:id` | Single task |
| POST | `/tasks` | Create (`{ title, description?, completed? }`) |
| PATCH | `/tasks/:id` | Partial update |
| DELETE | `/tasks/:id` | Delete |

Example:

```bash
curl -X POST http://localhost:4000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Wire up auth"}'
```

## Structure

**backend/**

```
src/
├── index.js              server bootstrap + graceful shutdown
├── app.js                express app (helmet, cors, json, routes)
├── config.js             env parsing with fail-fast
├── routes/index.js       /api router + /health
├── tasks/
│   ├── task.routes.js    route handlers
│   ├── task.schema.js    zod validation
│   └── task.repository.js  SQL queries
├── db/
│   ├── pool.js           pg Pool singleton
│   ├── schema.sql        DDL
│   └── migrate.js        runner (--reset to drop tables)
└── lib/
    ├── HttpError.js      typed HTTP errors
    └── error.middleware.js
```

**frontend/**

```
src/
├── main.jsx
├── App.jsx               state + data fetching
├── lib/api.js            fetch wrapper with error handling
├── components/
│   ├── TaskForm.jsx
│   └── TaskList.jsx
└── styles.css
```

## Adding a new feature

1. SQL table `backend/src/db/schema.sql` mein add karo.
2. `backend/src/tasks/` jaisa ek naya module banao (routes + schema + repository).
3. `backend/src/routes/index.js` mein router mount karo.
4. Frontend mein `lib/api.js` me methods aur ek component add karo.

## Notes

- CORS: development me `localhost` / `127.0.0.1` ke kisi bhi port se requests
  accept hoti hain (Vite apna port badal de to bhi), production me sirf `CORS_ORIGIN`
  allow-list — comma-separated, koi wildcard nahi.
- Vite `strictPort: true` ke saath chalta hai: `5173` busy ho to error deta hai
  aur chup-chaap `5174` par shift nahi hota.
- `.env` me `CORS_ORIGIN` comma-separated list le sakta hai — multiple frontend origins ke liye.
- `npm run db:reset --prefix backend` saara data delete karke schema rebuild karta hai.