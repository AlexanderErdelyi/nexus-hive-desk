import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export async function callMcpTool(
  command: string,
  args: string[],
  env: Record<string, string>,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<McpToolResult> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });

  const client = new Client({ name: 'nexus-hive-desk', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: toolArgs });
    return result as McpToolResult;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<Array<{ name: string; description?: string }>> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });

  const client = new Client({ name: 'nexus-hive-desk', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools ?? [];
  } finally {
    await client.close().catch(() => {});
  }
}
