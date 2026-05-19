import { GlossaryManager } from '@/components/glossary/GlossaryManager';

export default async function GlossaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GlossaryManager projectId={id} />;
}
