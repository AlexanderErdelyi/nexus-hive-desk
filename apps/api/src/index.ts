import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { customerRoutes } from './routes/customers';
import { customerMemberRoutes } from './routes/customer-members';
import { glossaryRoutes } from './routes/glossary';
import { projectRoutes } from './routes/projects';
import { projectMemberRoutes } from './routes/project-members';
import { remoteRoutes } from './routes/remote';
import { translationRoutes } from './routes/translations';
import { userTokenRoutes } from './routes/user-tokens';

async function bootstrap() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'nexus-hive-desk-dev-secret-change-in-production',
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(customerRoutes, { prefix: '/api/customers' });
  await app.register(customerMemberRoutes, { prefix: '/api/customers' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(projectMemberRoutes, { prefix: '/api/projects' });
  await app.register(translationRoutes, { prefix: '/api/translations' });
  await app.register(glossaryRoutes, { prefix: '/api/glossary' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(remoteRoutes, { prefix: '/api/remote' });
  await app.register(userTokenRoutes, { prefix: '/api/user/tokens' });

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
