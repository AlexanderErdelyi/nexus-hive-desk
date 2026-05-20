import { AgentsList } from '@/components/agents/AgentsList';

export default function AgentsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Agents</h1>
        <p className="mt-1 text-gray-500 dark:text-gray-400">Configure and manage your AI agents, skills, and MCP connections</p>
      </div>
      <AgentsList />
    </div>
  );
}
