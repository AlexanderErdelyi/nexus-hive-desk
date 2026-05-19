import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

export async function customerMemberRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('onRequest', requireAuth(app));

  // ─── List members of a customer ────────────────────────────────────────────
  app.get<{ Params: { customerId: string } }>(
    '/:customerId/members',
    async (req, reply) => {
      const members = await prisma.customerMember.findMany({
        where: { customerId: req.params.customerId },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      return { data: members };
    }
  );

  // ─── Add member to customer (by email) ─────────────────────────────────────
  app.post<{
    Params: { customerId: string };
    Body: { email: string; role?: string };
  }>(
    '/:customerId/members',
    async (req, reply) => {
      const { email, role = 'viewer' } = req.body;

      if (!email) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'email is required' });
      }

      if (!['admin', 'editor', 'viewer'].includes(role)) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'role must be admin, editor, or viewer' });
      }

      // Verify the requesting user is an admin of this customer
      const requestingMember = await prisma.customerMember.findUnique({
        where: {
          userId_customerId: {
            userId: req.user.sub,
            customerId: req.params.customerId,
          },
        },
      });

      if (!requestingMember || requestingMember.role !== 'admin') {
        return reply
          .status(403)
          .send({ error: 'forbidden', message: 'Only customer admins can manage members' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'User not found with that email' });
      }

      const existing = await prisma.customerMember.findUnique({
        where: {
          userId_customerId: {
            userId: user.id,
            customerId: req.params.customerId,
          },
        },
      });

      if (existing) {
        return reply
          .status(409)
          .send({ error: 'conflict', message: 'User is already a member of this customer' });
      }

      const member = await prisma.customerMember.create({
        data: {
          userId: user.id,
          customerId: req.params.customerId,
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
    Params: { customerId: string; memberId: string };
    Body: { role: string };
  }>(
    '/:customerId/members/:memberId',
    async (req, reply) => {
      const { role } = req.body;

      if (!['admin', 'editor', 'viewer'].includes(role)) {
        return reply
          .status(400)
          .send({ error: 'validation', message: 'role must be admin, editor, or viewer' });
      }

      // Verify the requesting user is an admin
      const requestingMember = await prisma.customerMember.findUnique({
        where: {
          userId_customerId: {
            userId: req.user.sub,
            customerId: req.params.customerId,
          },
        },
      });

      if (!requestingMember || requestingMember.role !== 'admin') {
        return reply
          .status(403)
          .send({ error: 'forbidden', message: 'Only customer admins can manage members' });
      }

      const member = await prisma.customerMember.update({
        where: { id: req.params.memberId },
        data: { role },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      return { data: member };
    }
  );

  // ─── Remove member ────────────────────────────────────────────────────────
  app.delete<{ Params: { customerId: string; memberId: string } }>(
    '/:customerId/members/:memberId',
    async (req, reply) => {
      // Verify the requesting user is an admin
      const requestingMember = await prisma.customerMember.findUnique({
        where: {
          userId_customerId: {
            userId: req.user.sub,
            customerId: req.params.customerId,
          },
        },
      });

      if (!requestingMember || requestingMember.role !== 'admin') {
        return reply
          .status(403)
          .send({ error: 'forbidden', message: 'Only customer admins can manage members' });
      }

      await prisma.customerMember.delete({ where: { id: req.params.memberId } });
      return reply.status(204).send();
    }
  );
}
