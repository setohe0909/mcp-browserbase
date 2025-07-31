/**
 * Resources module for the Stagehand MCP server
 * Contains resources definitions and handlers for resource-related requests
 */

// Define the resources
export const RESOURCES = [];

// Define the resource templates
export const RESOURCE_TEMPLATES = [];

// Store screenshots in a map with session tracking
export const screenshots = new Map<string, string>();

// Track which screenshots belong to which session
export const sessionScreenshots = new Map<string, Set<string>>();

/**
 * Add a screenshot and associate it with a session
 * @param sessionId The ID of the session
 * @param name The screenshot name
 * @param data The screenshot data
 */
export function addScreenshot(sessionId: string, name: string, data: string) {
  screenshots.set(name, data);
  
  // Add to session tracking
  if (!sessionScreenshots.has(sessionId)) {
    sessionScreenshots.set(sessionId, new Set());
  }
  sessionScreenshots.get(sessionId)?.add(name);
}

/**
 * Clean up screenshots for a specific session
 * @param sessionId The ID of the session to clean up
 * @returns The number of screenshots cleaned
 */
export function cleanupSessionScreenshots(sessionId: string): number {
  const sessionShots = sessionScreenshots.get(sessionId);
  if (!sessionShots) return 0;
  
  let count = 0;
  // Remove all screenshots for this session
  for (const name of sessionShots) {
    if (screenshots.delete(name)) {
      count++;
    }
  }
  
  // Remove session tracking
  sessionScreenshots.delete(sessionId);
  
  return count;
}

/**
 * Handle listing resources request
 * @returns A list of available resources including screenshots
 */
export function listResources() {
  return { 
    resources: [
      ...Array.from(screenshots.keys()).map((name) => ({
        uri: `screenshot://${name}`,
        mimeType: "image/png",
        name: `Screenshot: ${name}`,
      })),
    ]
  };
}

/**
 * Handle listing resource templates request
 * @returns An empty resource templates list response
 */
export function listResourceTemplates() {
  return { resourceTemplates: [] };
}

/**
 * Read a resource by its URI
 * @param uri The URI of the resource to read
 * @returns The resource content or throws if not found
 */
export function readResource(uri: string) {
  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [
          {
            uri,
            mimeType: "image/png",
            blob: screenshot,
          },
        ],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
} 