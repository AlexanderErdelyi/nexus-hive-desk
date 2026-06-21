#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTools, handleTool } from './tools.js';

const workspaceRoot = process.env.NEXUS_WORKSPACE || process.argv[2] || process.cwd();

const server = new Server(
  { name: 'nexus-translator', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const tools = createTools(workspaceRoot);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleTool(request.params.name, request.params.arguments ?? {}, workspaceRoot);
  // The SDK's ServerResult union is broader than our CallToolResult shape.
  return result as unknown as Record<string, unknown>;
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Nexus MCP server started. Workspace: ${workspaceRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
