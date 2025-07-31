#!/usr/bin/env node

import express from 'express';
// @ts-ignore
import cors from 'cors';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, ApiKeys, closeSession } from "./server.js";
import { ensureLogDirectory, registerExitHandlers, scheduleLogRotation, setupLogRotation } from "./logging.js";
import { cleanupSessionScreenshots } from "./resources.js";

// Run setup for logging
ensureLogDirectory();
setupLogRotation();
scheduleLogRotation();
registerExitHandlers();

// Create Express server
const app = express();
app.use(cors());

// Apply JSON middleware to all routes except /messages
app.use((req, res, next) => {
  if (req.path === '/messages') {
    return next();
  }
  express.json()(req, res, next);
});

// Extract API keys from headers or query parameters
function extractApiKeys(req: express.Request): ApiKeys {
  // Parse and validate API keys
  const browserbaseApiKey = 
    (typeof req.query.browserbase_api_key === 'string' ? req.query.browserbase_api_key : '') ||
    (typeof req.headers['x-browserbase-api-key'] === 'string' ? req.headers['x-browserbase-api-key'] : '');

  const browserbaseProjectId = 
    (typeof req.query.browserbase_project_id === 'string' ? req.query.browserbase_project_id : '') ||
    (typeof req.headers['x-browserbase-project-id'] === 'string' ? req.headers['x-browserbase-project-id'] : '');

  const openaiApiKey = 
    (typeof req.query.openai_api_key === 'string' ? req.query.openai_api_key : '') ||
    (typeof req.headers['x-openai-api-key'] === 'string' ? req.headers['x-openai-api-key'] : '');

  return {
    browserbaseApiKey: browserbaseApiKey || undefined,
    browserbaseProjectId: browserbaseProjectId || undefined,
    openaiApiKey: openaiApiKey || undefined,
  };
}

// Store active sessions
const sessions: Record<
  string,
  { transport: SSEServerTransport; response: express.Response }
> = {};

// SSE endpoint
app.get('/sse', async (req, res) => {
  console.log(`New SSE connection from ${req.ip || 'unknown'}`);

  try {
    // Extract API keys from headers
    const apiKeys = extractApiKeys(req);

    // Log API key sources (masked for security)
    console.log('API Keys sources:');
    console.log(`- Browserbase API Key: ${
      req.query.browserbase_api_key ? 'from query params' :
      req.headers['x-browserbase-api-key'] ? 'from headers' : 'not provided'
    }`);
    console.log(`- Browserbase Project ID: ${
      req.query.browserbase_project_id ? 'from query params' :
      req.headers['x-browserbase-project-id'] ? 'from headers' : 'not provided'
    }`);
    console.log(`- OpenAI API Key: ${
      req.query.openai_api_key ? 'from query params' :
      req.headers['x-openai-api-key'] ? 'from headers' : 'not provided'
    }`);

    // Validate required API keys
    if (!apiKeys.browserbaseApiKey || !apiKeys.browserbaseProjectId || !apiKeys.openaiApiKey) {
      res.status(401).send(
        'Missing required API keys. Keys can be provided either as headers (x-browserbase-api-key, x-browserbase-project-id, x-openai-api-key) ' +
        'or as query parameters (browserbase_api_key, browserbase_project_id, openai_api_key)'
      );
      return;
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Create SSE transport
    const sseTransport = new SSEServerTransport('/messages', res);

    try {
      // Create the MCP server with API keys from headers
      const server = createServer(apiKeys);

      // Connect to MCP server
      await server.connect(sseTransport);

      const sessionId = sseTransport.sessionId;
      if (sessionId) {
        // Store session information
        sessions[sessionId] = { transport: sseTransport, response: res };

        console.log(`SSE connection established with session ID: ${sessionId}`);

        // Handle transport events
        sseTransport.onclose = () => {
          console.log(`SSE connection closed (session ${sessionId})`);
          delete sessions[sessionId];
        };

        sseTransport.onerror = (err) => {
          console.error(`SSE error (session ${sessionId}):`, err);
          delete sessions[sessionId];
        };

        // Handle client disconnect
        req.on('close', () => {
          console.log(`Client disconnected (session ${sessionId})`);
          // Clean up resources for this session
          try {
            // Close the Stagehand session associated with this client if it exists
            closeSession(apiKeys).catch(err => {
              console.error(`Error closing session on disconnect: ${err}`);
            });

            // Remove the session from active sessions
            delete sessions[sessionId];

            // Clean up screenshots associated with this session
            cleanupSessionScreenshots(sessionId);

            console.log(`Session ${sessionId} resources cleaned up`);
          } catch (error) {
            console.error(`Error cleaning up resources for session ${sessionId}:`, error);
          }
        });
      } else {
        throw new Error("Failed to obtain session ID from SSE transport");
      }
    } catch (error) {
      console.error('Error connecting to server:', error);
      res.status(500).send(`Error connecting to server: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    console.error('Error handling SSE connection:', error);
    res.status(500).send(`Error handling SSE connection: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Message endpoint for client-to-server communication
app.post('/messages', (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const session = sessions[sessionId];
  if (session?.transport?.handlePostMessage) {
    console.log(`POST to SSE transport (session ${sessionId})`);
    try {
      session.transport.handlePostMessage(req, res).catch(err => {
        console.error(`Error handling message for session ${sessionId}:`, err);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      });
    } catch (error) {
      console.error(`Error handling message for session ${sessionId}:`, error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  } else {
    res.status(503).send(`No active SSE connection for session ${sessionId}`);
  }
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.send('ok');
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MCP SSE Server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Message endpoint: http://localhost:${PORT}/messages?sessionId={sessionId}`);
});