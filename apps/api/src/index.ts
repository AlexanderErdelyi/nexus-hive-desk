import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { aiRoutes } from './routes/ai';
import { customerRoutes } from './routes/customers';
import { glossaryRoutes } from './routes/glossary';
import { projectRoutes } from './routes/projects';
import { remoteRoutes } from './routes/remote';
import { translationRoutes } from './routes/translations';

async function bootstrap() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  await app.register(customerRoutes, { prefix: '/api/customers' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(translationRoutes, { prefix: '/api/translations' });
  await app.register(glossaryRoutes, { prefix: '/api/glossary' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(remoteRoutes, { prefix: '/api/remote' });

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  const port = Number(process.env.PORT ?? 3001);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`NexusHiveDesk API running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void bootstrap();
