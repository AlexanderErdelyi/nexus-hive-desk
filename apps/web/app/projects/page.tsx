'use client';

import { ProjectsList } from '@/components/projects/ProjectsList';
import { useSearchParams } from 'next/navigation';

export default function ProjectsPage() {
  const searchParams = useSearchParams();
  const newForCustomer = searchParams.get('newForCustomer') ?? undefined;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="mt-1 text-gray-500">Manage your translation projects</p>
        </div>
      </div>
      <ProjectsList defaultCustomerId={newForCustomer} />
    </div>
  );
}
