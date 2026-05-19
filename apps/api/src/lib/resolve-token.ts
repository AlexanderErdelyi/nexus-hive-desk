import { prisma } from '@nexus/db';
import { decryptToken } from './crypto';

/**
 * Resolve the most specific token for a user + provider combination.
 *
 * Resolution order (most specific wins):
 * 1. Project-scoped token for the matching provider
 * 2. Customer-scoped token for the matching provider
 * 3. Global token for the matching provider
 *
 * Returns the decrypted PAT string, or null if no token is found.
 */
export async function resolveToken(
  userId: string,
  provider: 'github' | 'azuredevops',
  opts?: { projectId?: string; customerId?: string }
): Promise<{ token: string; baseUrl?: string | null } | null> {
  // 1. Try project-scoped
  if (opts?.projectId) {
    const projectToken = await prisma.userToken.findFirst({
      where: { userId, provider, scopeType: 'project', scopeId: opts.projectId },
    });
    if (projectToken) {
      return {
        token: decryptToken(projectToken.encryptedToken, projectToken.tokenIv, projectToken.tokenTag),
        baseUrl: projectToken.baseUrl,
      };
    }
  }

  // 2. Try customer-scoped
  if (opts?.customerId) {
    const customerToken = await prisma.userToken.findFirst({
      where: { userId, provider, scopeType: 'customer', scopeId: opts.customerId },
    });
    if (customerToken) {
      return {
        token: decryptToken(customerToken.encryptedToken, customerToken.tokenIv, customerToken.tokenTag),
        baseUrl: customerToken.baseUrl,
      };
    }
  }

  // 3. Fall back to global
  const globalToken = await prisma.userToken.findFirst({
    where: { userId, provider, scopeType: 'global' },
  });
  if (globalToken) {
    return {
      token: decryptToken(globalToken.encryptedToken, globalToken.tokenIv, globalToken.tokenTag),
      baseUrl: globalToken.baseUrl,
    };
  }

  return null;
}
