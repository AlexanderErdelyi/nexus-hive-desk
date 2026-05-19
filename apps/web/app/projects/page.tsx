import { ProjectsList } from '@/components/projects/ProjectsList';

export default function ProjectsPage() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="mt-1 text-gray-500">Manage your translation projects</p>
        </div>
      </div>
      <ProjectsList />
    </div>
  );
}
