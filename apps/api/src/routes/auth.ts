import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { hashPassword, verifyPassword, requireAuth } from '../lib/auth';

export async function authRoutes(app: FastifyInstance) {
  // ─── Sign up ────────────────────────────────────────────────────────────────
  app.post<{ Body: { email: string; name: string; password: string } }>(
    '/signup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, name, password } = req.body;

      if (!email || !name || !password) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'email, name, and password are required' });
      }

      if (password.length < 8) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'Password must be at least 8 characters' });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({ error: 'conflict', message: 'Email already registered' });
      }

      const hashedPassword = await hashPassword(password);
      const user = await prisma.user.create({
        data: { email, name, hashedPassword },
      });

      const token = app.jwt.sign({ sub: user.id, email: user.email });

      return reply.status(201).send({
        data: {
          user: { id: user.id, email: user.email, name: user.name },
          token,
        },
      });
    }
  );

  // ─── Login ──────────────────────────────────────────────────────────────────
  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = req.body;

      if (!email || !password) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'email and password are required' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply
          .status(401)
          .send({ error: 'unauthorized', message: 'Invalid email or password' });
      }

      const valid = await verifyPassword(password, user.hashedPassword);
      if (!valid) {
        return reply
          .status(401)
          .send({ error: 'unauthorized', message: 'Invalid email or password' });
      }

      const token = app.jwt.sign({ sub: user.id, email: user.email });

      return reply.send({
        data: {
          user: { id: user.id, email: user.email, name: user.name },
          token,
        },
      });
    }
  );

  // ─── Get current user ──────────────────────────────────────────────────────
  app.get('/me', { onRequest: [async (req, reply) => {
    try { await req.jwtVerify(); } catch {
      return reply.status(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }
  }] }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        customerMembers: {
          select: {
            role: true,
            customer: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user) {
      return { error: 'not_found', message: 'User not found' };
    }

    return { data: user };
  });

  // ─── Update current user profile ──────────────────────────────────────────
  app.patch<{ Body: { name?: string } }>(
    '/me',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      const { name } = req.body;
      if (!name?.trim()) {
        return reply.status(400).send({ error: 'validation', message: 'name is required' });
      }
      const user = await prisma.user.update({
        where: { id: req.user.sub },
        data: { name: name.trim() },
        select: { id: true, email: true, name: true },
      });
      return { data: user };
    }
  );

  // ─── Change password ───────────────────────────────────────────────────────
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/change-password',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'validation', message: 'currentPassword and newPassword are required' });
      }
      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'validation', message: 'New password must be at least 8 characters' });
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user) return reply.status(404).send({ error: 'not_found' });

      const valid = await verifyPassword(currentPassword, user.hashedPassword);
      if (!valid) {
        return reply.status(401).send({ error: 'unauthorized', message: 'Current password is incorrect' });
      }
      await prisma.user.update({
        where: { id: req.user.sub },
        data: { hashedPassword: await hashPassword(newPassword) },
      });
      return { data: { ok: true } };
    }
  );
}
