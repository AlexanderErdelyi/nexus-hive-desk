import { Suspense } from 'react';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ErrorBoundary>
      <Suspense>
        <ProjectDetail projectId={id} />
      </Suspense>
    </ErrorBoundary>
  );
}
