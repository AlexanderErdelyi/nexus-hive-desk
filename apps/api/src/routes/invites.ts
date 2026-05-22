import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

const VALID_ROLES = ['admin', 'editor', 'translator', 'viewer'] as const;
const INVITE_TTL_HOURS = 72;

export async function inviteRoutes(app: FastifyInstance) {
  // ─── Create invite link (admin only for the project) ─────────────────────
  app.post<{
    Params: { projectId: string };
    Body: { role?: string; email?: string };
  }>(
    '/projects/:projectId/invites',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      const { projectId } = req.params;
      const role = (req.body.role ?? 'viewer') as string;
      const email = req.body.email?.toLowerCase().trim() || undefined;

      if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
        return reply.status(400).send({ error: 'validation', message: 'Invalid role' });
      }

      // Only admins of the project (or owner with no members) can create invites
      const existing = await prisma.projectMember.findFirst({
        where: { projectId, userId: req.user.sub, role: 'admin' },
      });
      // Allow if no members exist yet (first user bootstrapping)
      const memberCount = await prisma.projectMember.count({ where: { projectId } });
      if (!existing && memberCount > 0) {
        return reply.status(403).send({ error: 'forbidden', message: 'Only project admins can create invites' });
      }

      const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
      const invite = await prisma.projectInvite.create({
        data: { projectId, role, email, createdBy: req.user.sub, expiresAt },
        include: { project: { select: { id: true, name: true } } },
      });

      return reply.status(201).send({ data: invite });
    }
  );

  // ─── List active invites for a project ────────────────────────────────────
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/invites',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      const invites = await prisma.projectInvite.findMany({
        where: {
          projectId: req.params.projectId,
          usedAt: null,
          expiresAt: { gte: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      return { data: invites };
    }
  );

  // ─── Delete / revoke an invite ────────────────────────────────────────────
  app.delete<{ Params: { projectId: string; inviteId: string } }>(
    '/projects/:projectId/invites/:inviteId',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      await prisma.projectInvite.delete({ where: { id: req.params.inviteId } });
      return reply.status(204).send();
    }
  );

  // ─── Get invite info (public, no auth required) ────────────────────────────
  app.get<{ Params: { token: string } }>(
    '/invite/:token',
    async (req, reply) => {
      const invite = await prisma.projectInvite.findUnique({
        where: { token: req.params.token },
        include: { project: { select: { id: true, name: true } } },
      });

      if (!invite) return reply.status(404).send({ error: 'not_found', message: 'Invite not found' });
      if (invite.usedAt) return reply.status(410).send({ error: 'gone', message: 'Invite already used' });
      if (invite.expiresAt < new Date()) return reply.status(410).send({ error: 'gone', message: 'Invite expired' });

      return { data: { project: invite.project, role: invite.role, email: invite.email } };
    }
  );

  // ─── Accept invite (requires auth) ────────────────────────────────────────
  app.post<{ Params: { token: string } }>(
    '/invite/:token/accept',
    { onRequest: [requireAuth(app)] },
    async (req, reply) => {
      const invite = await prisma.projectInvite.findUnique({
        where: { token: req.params.token },
      });

      if (!invite) return reply.status(404).send({ error: 'not_found', message: 'Invite not found' });
      if (invite.usedAt) return reply.status(410).send({ error: 'gone', message: 'Invite already used' });
      if (invite.expiresAt < new Date()) return reply.status(410).send({ error: 'gone', message: 'Invite expired' });

      // Check email restriction
      if (invite.email) {
        const user = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { email: true } });
        if (user?.email.toLowerCase() !== invite.email) {
          return reply.status(403).send({ error: 'forbidden', message: 'This invite is for a different email address' });
        }
      }

      // Upsert the project member
      await prisma.projectMember.upsert({
        where: { userId_projectId: { userId: req.user.sub, projectId: invite.projectId } },
        create: { userId: req.user.sub, projectId: invite.projectId, role: invite.role },
        update: { role: invite.role },
      });

      // Mark invite used
      await prisma.projectInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date(), usedBy: req.user.sub },
      });

      return { data: { projectId: invite.projectId, role: invite.role } };
    }
  );
}
