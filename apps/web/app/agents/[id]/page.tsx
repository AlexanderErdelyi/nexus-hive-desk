import { AgentDetail } from '@/components/agents/AgentDetail';

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentDetail agentId={id} />;
}
