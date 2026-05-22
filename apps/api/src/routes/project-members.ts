import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

export async function projectMemberRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('onRequest', requireAuth(app));

  // ─── List members of a project ─────────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>(
    '/:projectId/members',
    async (req) => {
      const members = await prisma.projectMember.findMany({
        where: { projectId: req.params.projectId },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      return { data: members };
    }
  );

  // ─── Add member to project ─────────────────────────────────────────────────
  app.post<{
    Params: { projectId: string };
    Body: { email: string; role?: string };
  }>(
    '/:projectId/members',
    async (req, reply) => {
      const { email, role = 'viewer' } = req.body;

      if (!email) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'email is required' });
      }

      if (!['admin', 'editor', 'translator', 'viewer'].includes(role)) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'role must be admin, editor, translator, or viewer' });
      }

      // Verify the project exists and get its customerId
      const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { customerId: true },
      });

      if (!project) {
        return reply.status(404).send({ error: 'not_found', message: 'Project not found' });
      }

      // Verify the requesting user is a customer admin (if project has a customer)
      if (project.customerId) {
        const requestingMember = await prisma.customerMember.findUnique({
          where: {
            userId_customerId: {
              userId: req.user.sub,
              customerId: project.customerId,
            },
          },
        });

        if (!requestingMember || requestingMember.role !== 'admin') {
          return reply
            .status(403)
            .send({ error: 'forbidden', message: 'Only customer admins can manage project members' });
        }
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'User not found with that email' });
      }

      const existing = await prisma.projectMember.findUnique({
        where: {
          userId_projectId: {
            userId: user.id,
            projectId: req.params.projectId,
          },
        },
      });

      if (existing) {
        return reply
          .status(409)
          .send({ error: 'conflict', message: 'User is already a member of this project' });
      }

      const member = await prisma.projectMember.create({
        data: {
          userId: user.id,
          projectId: req.params.projectId,
          role,
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      return reply.status(201).send({ data: member });
    }
  );

  // ─── Update member role ────────────────────────────────────────────────────
  app.patch<{
    Params: { projectId: string; memberId: string };
    Body: { role: string };
  }>(
    '/:projectId/members/:memberId',
    async (req, reply) => {
      const { role } = req.body;

      if (!['admin', 'editor', 'translator', 'viewer'].includes(role)) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'role must be admin, editor, translator, or viewer' });
      }

      const member = await prisma.projectMember.update({
        where: { id: req.params.memberId },
        data: { role },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      return { data: member };
    }
  );

  // ─── Remove member ─────────────────────────────────────────────────────────
  app.delete<{ Params: { projectId: string; memberId: string } }>(
    '/:projectId/members/:memberId',
    async (req, reply) => {
      await prisma.projectMember.delete({ where: { id: req.params.memberId } });
      return reply.status(204).send();
    }
  );
}
