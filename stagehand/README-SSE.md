# MCP Server with SSE Transport

This is a Model Context Protocol (MCP) server that uses Server-Sent Events (SSE) transport to communicate with clients. The server is built on Express and runs on port 3001 by default.

## Installation

Make sure all dependencies are installed:

```bash
# Install dependencies
npm install
```

## Building the Server

Build the TypeScript code:

```bash
npm run build
```

## Running the Server

Start the SSE server:

```bash
npm run start:sse
```

## Endpoints

The server exposes the following endpoints:

- **SSE Endpoint**: `http://localhost:3001/sse`
  - Used for server-to-client communication via SSE
  - Clients connect to this endpoint to receive server messages
  - When a client connects, the server assigns a session ID that must be used for all subsequent POST requests

- **Message Endpoint**: `http://localhost:3001/messages?sessionId={sessionId}`
  - Used for client-to-server communication
  - Clients send POST requests to this endpoint with `application/json` content type
  - **IMPORTANT**: You must include the `sessionId` query parameter

- **Health Check**: `http://localhost:3001/health`
  - Returns a simple "ok" response
  - Useful for checking if the server is running

## Manual Testing

1. First, connect to the SSE endpoint in a browser tab or using a tool like `curl`:

```bash
curl -N http://localhost:3001/sse
```

2. Note the session ID that is logged in the server console. It will look something like:
```
SSE connection established with session ID: abc123def456
```

3. Use this session ID for all POST requests to the messages endpoint:

```bash
curl --location --request POST 'http://localhost:3001/messages?sessionId=abc123def456' \
--header 'Content-Type: application/json' \
--data '{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 0,
  "params": {}
}'
```

## Client Usage

To connect to this server from an MCP client:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(
  new URL("http://localhost:3001/sse")
);

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {}
    }
  }
);

await client.connect(transport);

// Now you can interact with the MCP server
const tools = await client.listTools();
console.log(tools);
```

## Implementation Notes

This server implementation:

1. Uses the Express framework for HTTP routing
2. Implements SSE for server-to-client streaming
3. Uses POST requests for client-to-server messages
4. Supports multiple simultaneous connections through session management
5. Handles connection lifecycle events (close, error, disconnect)

The implementation is based on the Model Context Protocol TypeScript SDK and follows the best practices outlined in the MCP specification. 