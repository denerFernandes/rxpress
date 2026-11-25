import express from '../dist/index.mjs';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4101);
const staticDir = join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// ioThreads: the engine's I/O threads (default 1; the throughput tables use 4).
if (process.env.IO_THREADS) app.set('ioThreads', Number(process.env.IO_THREADS));

app.use('/static', express.static(staticDir));

// Realistic API surface: 40 sibling REST routes registered before target endpoints
for (let i = 0; i < 40; i++) {
  app.get(`/api/v1/resource-${i}/:id`, (req, res) => {
    res.json({ resource: i, id: req.params.id });
  });
}

// Scenario 1: Plain text
app.get('/ping', (_req, res) => {
  res.type('text/plain').send('pong');
});

// Scenario 2: JSON response
app.get('/json', (_req, res) => {
  res.json({ message: 'Hello, World!', status: 'ok' });
});

// Scenario 3: Route params + query string
app.get('/users/:id/posts/:postId', (req, res) => {
  res.json({
    userId: req.params.id,
    postId: req.params.postId,
    sort: req.query.sort || 'asc',
  });
});

// Scenario 4: JSON POST body
app.post('/echo', express.json(), (req, res) => {
  res.json({ ok: true, name: req.body?.name });
});

// Scenario 5: Third-party Express middleware (cors)
app.get('/cors', cors(), (_req, res) => {
  res.json({ cors: true });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`READY:${port}`);
});
