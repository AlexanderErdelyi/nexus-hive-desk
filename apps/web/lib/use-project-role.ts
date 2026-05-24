'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth-context';
import { api } from './api';

interface Member {
  id: string;
  userId: string;
  role: string;
  user: { id: string; email: string; name: string };
}

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  translator: 2,
  editor: 3,
  admin: 4,
};

/**
 * Returns the current user's role in the given project, or null if not a member / loading.
 * Also provides hasRole(minRole) helper for permission checks.
 */
export function useProjectRole(projectId: string | undefined) {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get<{ data: Member[] }>(`/api/projects/${projectId}/members`),
    enabled: !!projectId && !!user,
    staleTime: 60_000,
  });

  const role = data?.data?.find((m) => m.userId === user?.id)?.role ?? null;

  function hasRole(minRole: 'viewer' | 'translator' | 'editor' | 'admin'): boolean {
    if (!role) return false;
    return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
  }

  return { role, isLoading, hasRole };
}
