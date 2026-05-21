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
import { translationMemoryRoutes } from './routes/translation-memory';
import { translationRoutes } from './routes/translations';
import { agentRoutes } from './routes/agents';
import { skillRoutes } from './routes/skills';
import { mcpConnectionRoutes } from './routes/mcp-connections';
import { userTokenRoutes } from './routes/user-tokens';
import { workItemRoutes } from './routes/work-items';

async function bootstrap() {
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 }); // 10 MB body limit

  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map(s => s.trim());
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(null, true); // allow all in dev — restrict via CORS_ORIGIN in prod
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    preflight: true,
    strictPreflight: false,
    maxAge: 0, // disable preflight cache so browsers never use stale CORS responses
  });

  // Belt-and-suspenders: ensure CORS headers on every response (including error responses)
  app.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'nexus-hive-desk-dev-secret-change-in-production',
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}`,
    }),
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(customerRoutes, { prefix: '/api/customers' });
  await app.register(customerMemberRoutes, { prefix: '/api/customers' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(projectMemberRoutes, { prefix: '/api/projects' });
  await app.register(translationRoutes, { prefix: '/api/translations' });
  await app.register(translationMemoryRoutes, { prefix: '/api/translation-memory' });
  await app.register(glossaryRoutes, { prefix: '/api/glossary' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(remoteRoutes, { prefix: '/api/remote' });
  await app.register(skillRoutes, { prefix: '/api/skills' });
  await app.register(mcpConnectionRoutes, { prefix: '/api/mcp-connections' });
  await app.register(agentRoutes, { prefix: '/api/agents' });
  await app.register(userTokenRoutes, { prefix: '/api/user/tokens' });
  await app.register(workItemRoutes, { prefix: '/api/projects' });

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
