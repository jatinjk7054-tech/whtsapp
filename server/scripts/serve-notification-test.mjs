import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
process.env.DATABASE_URL = u.toString();

const { default: chatRoutes } = await import('../src/routes/chatRoutes.js');
const { authenticate } = await import('../src/middleware/authMiddleware.js');
const db = (await import('../src/config/db.js')).default;
const { initRealtime } = await import('../src/socket.js');
const { ensureChatSchema } = await import('../src/bootstrap/ensureChatSchema.js');

await ensureChatSchema();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/chat', authenticate, chatRoutes);

// The real drawer path, mounted the way the app mounts it.
const notificationRoutes = (await import('../src/routes/notificationRoutes.js')).default;
app.use('/api/notifications', authenticate, notificationRoutes);

// So the test can obtain a token the same way the browser does.
const authRoutes = (await import('../src/routes/authRoutes.js')).default;
app.use('/api/auth', authRoutes);

const server = app.listen(5098, () => console.log('READY on 5098'));
initRealtime(server);

const bye = async () => {
  server.close();
  await db._pool.end();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
