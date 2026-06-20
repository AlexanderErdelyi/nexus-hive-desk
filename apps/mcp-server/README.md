# Nexus Translator MCP Server

Stdio MCP server that exposes Nexus Translation Memory and Glossary tools to Copilot Chat and other MCP-compatible clients.

## Setup

The server is automatically configured in `.vscode/mcp.json` when you install the Nexus Translator VS Code extension. No manual setup needed.

## Building

```sh
cd apps/mcp-server
npm install
npm run build
```

## Tools

See the [VS Code extension README](../vscode-extension/README.md#mcp-server) for full documentation.

## Storage

Reads/writes `.nexus/tm.json` and `.nexus/glossary.json` relative to `NEXUS_WORKSPACE` (set in `.vscode/mcp.json`). These files are shared with the VS Code extension.
