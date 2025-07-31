FROM node:22-alpine

WORKDIR /app

# Copy everything at once
COPY . .

# Install all dependencies
RUN npm install

# Install playwright
RUN npx playwright install

# Build the TypeScript code
RUN npm run build

# Remove development dependencies
RUN npm prune --production

# Expose the server port
EXPOSE 3001

# Start the server with garbage collection enabled
CMD ["node", "--expose-gc", "dist/index-sse.js"]