import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '@nexus/db';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Fastify onRequest hook – verifies JWT and attaches user to request */
export function requireAuth(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }
  };
}

// Role hierarchy: viewer < translator < editor < admin
const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  translator: 2,
  editor: 3,
  admin: 4,
};

/**
 * Returns the current user's role in a project, or null if they are not a member.
 * Users with no ProjectMember row are treated as non-members (null).
 */
export async function getProjectRole(userId: string, projectId: string): Promise<string | null> {
  const member = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { role: true },
  });
  return member?.role ?? null;
}

/**
 * Fastify preHandler that verifies the authenticated user has at least `minRole`
 * in the project identified by `req.params.projectId` (or a custom resolver).
 *
 * Usage:
 *   app.patch('/:projectId/something', { preHandler: [requireAuth(app), requireProjectRole('editor')] }, handler)
 *   // or as a plugin-level hook for all routes in a project-scoped plugin
 */
export function requireProjectRole(
  minRole: 'viewer' | 'translator' | 'editor' | 'admin',
  projectIdResolver?: (req: FastifyRequest) => string,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string>;
    const projectId = projectIdResolver ? projectIdResolver(req) : (params.projectId ?? params.id);
    if (!projectId) {
      return reply.status(400).send({ error: 'bad_request', message: 'projectId required' });
    }

    const role = await getProjectRole(req.user.sub, projectId);
    if (!role) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a project member' });
    }

    const userRank = ROLE_RANK[role] ?? 0;
    const required = ROLE_RANK[minRole] ?? 0;
    if (userRank < required) {
      return reply.status(403).send({ error: 'forbidden', message: `Requires ${minRole} role or higher` });
    }
  };
}

// Extend Fastify types
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}
