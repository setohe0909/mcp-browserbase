import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Stagehand } from "@browserbasehq/stagehand";
import type { ConstructorParams } from "@browserbasehq/stagehand";

import { sanitizeMessage } from "./utils.js";
import { log, logRequest, logResponse, operationLogs, setServerInstance } from "./logging.js";
import { TOOLS, handleToolCall } from "./tools.js";
import { PROMPTS, getPrompt } from "./prompts.js";
import { listResources, listResourceTemplates, readResource } from "./resources.js";

// Interface for API keys
export interface ApiKeys {
  browserbaseApiKey?: string;
  browserbaseProjectId?: string;
  openaiApiKey?: string;
}

// Define Stagehand configuration
export function getStagehandConfig(apiKeys?: ApiKeys): ConstructorParams {
  // Use provided API keys or fall back to environment variables
  const browserbaseApiKey = apiKeys?.browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
  const browserbaseProjectId = apiKeys?.browserbaseProjectId || process.env.BROWSERBASE_PROJECT_ID;
  const openaiApiKey = apiKeys?.openaiApiKey || process.env.OPENAI_API_KEY;

  // Ensure we have valid strings for all required fields
  if (!browserbaseApiKey || !browserbaseProjectId || !openaiApiKey) {
    throw new Error(`Missing required API keys: ${!browserbaseApiKey ? 'browserbaseApiKey ' : ''}${!browserbaseProjectId ? 'browserbaseProjectId ' : ''}${!openaiApiKey ? 'openaiApiKey' : ''}`);
  }

  return {
    env: "BROWSERBASE", // Always use BROWSERBASE since we validate keys
    apiKey: browserbaseApiKey /* API key for authentication */,
    projectId: browserbaseProjectId /* Project identifier */,
    debugDom: false /* Enable DOM debugging features */,
    headless: false /* Run browser in headless mode */,
    logger: (message) =>
      console.error(logLineToString(message)) /* Custom logging function to stderr */,
    domSettleTimeoutMs: 30_000 /* Timeout for DOM to settle in milliseconds */,
    browserbaseSessionCreateParams: {
      projectId: browserbaseProjectId,
      browserSettings: process.env.CONTEXT_ID ? {
          context: {
            id: process.env.CONTEXT_ID,
            persist: true
          }
      } : undefined
    },
    enableCaching: true /* Enable caching functionality */,
    browserbaseSessionID:
      undefined /* Session ID for resuming Browserbase sessions */,
    modelName: "gpt-4o" /* Name of the model to use */,
    modelClientOptions: {
      apiKey: openaiApiKey,
    } /* Configuration options for the model client */,
    useAPI: false,
  };
}

// Session management for concurrent clients
interface StagehandSession {
  stagehand: Stagehand;
  config: ConstructorParams;
  lastUsed: number;
}

class SessionManager {
  private sessions: Map<string, StagehandSession> = new Map();
  private readonly sessionTimeout = 5 * 60 * 1000; // 5 minutes in milliseconds

  constructor() {
    // Start cleanup interval to remove stale sessions
    setInterval(() => this.cleanupStaleSessions(), 2 * 60 * 1000); // Check every 2 minutes

    // Add memory usage monitoring
    setInterval(() => this.logMemoryUsage(), 5 * 60 * 1000); // Log every 5 minutes
  }

  // Generate a unique key for each client configuration
  private getSessionKey(config: ConstructorParams): string {
    return JSON.stringify({
      browserbaseApiKey: config.apiKey,
      browserbaseProjectId: config.projectId,
      openaiApiKey: config.modelClientOptions?.apiKey,
      contextId: config.browserbaseSessionCreateParams?.browserSettings?.context?.id
    });
  }

  // Get or create a session for the given API keys
  async getSession(apiKeys?: ApiKeys): Promise<Stagehand> {
    try {
      const config = getStagehandConfig(apiKeys);
      const sessionKey = this.getSessionKey(config);

      // Check if we have a valid existing session
      const existingSession = this.sessions.get(sessionKey);
      if (existingSession) {
        try {
          // Verify the session has a valid page object
          if (!existingSession.stagehand || !existingSession.stagehand.page) {
            throw new Error("Invalid stagehand instance or missing page object");
          }

          // Test if the session is still valid
          await existingSession.stagehand.page.evaluate(() => document.title);
          // Update last used timestamp
          existingSession.lastUsed = Date.now();
          return existingSession.stagehand;
        } catch (error) {
          // Session is invalid, remove it
          this.sessions.delete(sessionKey);
          log('Browser session expired, creating new session...', 'info');
        }
      }

      // Create a new session
      try {
        // First validate we have all required fields in config
        if (!config || typeof config !== 'object') {
          throw new Error("Invalid configuration object");
        }

        if (!config.apiKey || !config.projectId || !config.modelClientOptions?.apiKey) {
          throw new Error(`Missing required configuration: apiKey=${!!config.apiKey}, projectId=${!!config.projectId}, modelClientOptions.apiKey=${!!config.modelClientOptions?.apiKey}`);
        }

        const stagehand = new Stagehand(config);

        if (!stagehand) {
          throw new Error("Failed to create Stagehand instance");
        }

        await stagehand.init();

        if (!stagehand.page) {
          throw new Error("Stagehand initialization completed but page object is undefined");
        }

        this.sessions.set(sessionKey, {
          stagehand,
          config,
          lastUsed: Date.now()
        });

        return stagehand;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Failed to initialize Stagehand session: ${errorMsg}`, 'error');
        throw error;
      }
    } catch (error) {
      // Handle errors from getStagehandConfig
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Failed to create or retrieve session: ${errorMsg}`, 'error');
      throw error;
    }
  }

  // Close a specific session
  async closeSession(apiKeys?: ApiKeys): Promise<void> {
    const config = getStagehandConfig(apiKeys);
    const sessionKey = this.getSessionKey(config);
    const session = this.sessions.get(sessionKey);
    
    if (session) {
      try {
        await session.stagehand.page.close();
      } catch (error) {
        // Ignore errors on close
      } finally {
        this.sessions.delete(sessionKey);
      }
    }
  }

  // Close all sessions
  async closeAllSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.stagehand.page.close();
      } catch (error) {
        // Ignore errors on close
      }
    }
    this.sessions.clear();
  }

  // Clean up stale sessions
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastUsed > this.sessionTimeout) {
        try {
          // First close the page
          if (session.stagehand.page) {
            await session.stagehand.page.close();
          }

          if (session.stagehand) {
            await session.stagehand.close();
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log(`Error while closing stale session: ${errorMsg}`, 'error');
        }

        keysToRemove.push(key);
      }
    }

    // Remove sessions from the map
    keysToRemove.forEach(key => this.sessions.delete(key));

    if (keysToRemove.length > 0) {
      log(`Cleaned up ${keysToRemove.length} stale sessions`, 'info');
    }
  }

  // Log memory usage stats
  private logMemoryUsage(): void {
    const memoryUsage = process.memoryUsage();
    const formatMemory = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

    log(`Memory usage: RSS: ${formatMemory(memoryUsage.rss)}, ` +
        `Heap Total: ${formatMemory(memoryUsage.heapTotal)}, ` +
        `Heap Used: ${formatMemory(memoryUsage.heapUsed)}, ` +
        `External: ${formatMemory(memoryUsage.external)}, ` +
        `Active sessions: ${this.sessions.size}`, 'info');
  }
}

// Initialize the session manager
const sessionManager = new SessionManager();

// Ensure Stagehand is initialized with the current configuration
export async function ensureStagehand(apiKeys?: ApiKeys) {
  try {
    return await sessionManager.getSession(apiKeys);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Failed to get Stagehand session: ${errorMsg}`, 'error');
    throw error;
  }
}

// Export session cleanup functions
export async function closeSession(apiKeys?: ApiKeys) {
  return sessionManager.closeSession(apiKeys);
}

export async function closeAllSessions() {
  return sessionManager.closeAllSessions();
}

// Create the server
export function createServer(apiKeys?: ApiKeys) {
  const server = new Server(
    {
      name: "stagehand",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        logging: {},
        prompts: {}
      },
    }
  );

  // Store server instance for logging
  setServerInstance(server);

  // Setup request handlers
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      logRequest('ListTools', request.params);
      const response = { tools: TOOLS };
      const sanitizedResponse = sanitizeMessage(response);
      logResponse('ListTools', JSON.parse(sanitizedResponse));
      return JSON.parse(sanitizedResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      logRequest('CallTool', request.params);
      operationLogs.length = 0; // Clear logs for new operation

      if (!request.params?.name || !TOOLS.find(t => t.name === request.params.name)) {
        throw new Error(`Invalid tool name: ${request.params?.name}`);
      }

      // Ensure Stagehand is initialized
      try {
        const stagehandInstance = await ensureStagehand(apiKeys);
        if (!stagehandInstance) {
          throw new Error("Failed to initialize Stagehand: instance is undefined");
        }

        const result = await handleToolCall(
          request.params.name,
          request.params.arguments ?? {},
          stagehandInstance
        );

        const sanitizedResult = sanitizeMessage(result);
        logResponse('CallTool', JSON.parse(sanitizedResult));
        return JSON.parse(sanitizedResult);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to initialize Stagehand: ${errorMsg}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: true,
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    try {
      logRequest('ListResources', request.params);
      const response = listResources();
      const sanitizedResponse = sanitizeMessage(response);
      logResponse('ListResources', JSON.parse(sanitizedResponse));
      return JSON.parse(sanitizedResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    try {
      logRequest('ListResourceTemplates', request.params);
      const response = listResourceTemplates();
      const sanitizedResponse = sanitizeMessage(response);
      logResponse('ListResourceTemplates', JSON.parse(sanitizedResponse));
      return JSON.parse(sanitizedResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      logRequest('ReadResource', request.params);
      const uri = request.params.uri.toString();
      const response = readResource(uri);
      const sanitizedResponse = sanitizeMessage(response);
      logResponse('ReadResource', JSON.parse(sanitizedResponse));
      return JSON.parse(sanitizedResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    try {
      logRequest('ListPrompts', request.params);
      const response = { prompts: PROMPTS };
      const sanitizedResponse = sanitizeMessage(response);
      logResponse('ListPrompts', JSON.parse(sanitizedResponse));
      return JSON.parse(sanitizedResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      logRequest('GetPrompt', request.params);
      
      // Check if prompt name is valid and get the prompt
      try {
        const prompt = getPrompt(request.params?.name || "");
        const sanitizedResponse = sanitizeMessage(prompt);
        logResponse('GetPrompt', JSON.parse(sanitizedResponse));
        return JSON.parse(sanitizedResponse);
      } catch (error) {
        throw new Error(`Invalid prompt name: ${request.params?.name}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      };
    }
  });

  return server;
}

// Import missing function from logging
import { formatLogResponse, logLineToString } from "./logging.js"; 