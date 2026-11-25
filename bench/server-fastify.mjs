import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4102);

const app = Fastify({ logger: false });

await app.register(cors, { hook: 'onRequest' });
await app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/static/',
  etag: false,
  lastModified: false,
});

for (let i = 0; i < 40; i++) {
  app.get(`/api/v1/resource-${i}/:id`, async (req) => ({ resource: i, id: req.params.id }));
}

app.get('/ping', async (_req, reply) => reply.type('text/plain').send('pong'));
app.get('/json', async () => ({ message: 'Hello, World!', status: 'ok' }));
app.get('/users/:id/posts/:postId', async (req) => ({
  userId: req.params.id,
  postId: req.params.postId,
  sort: req.query.sort || 'asc',
}));
app.post('/echo', async (req) => ({ ok: true, name: req.body?.name }));
app.get('/cors', async () => ({ cors: true }));

await app.listen({ port, host: '127.0.0.1' });
console.log(`READY:${port}`);
