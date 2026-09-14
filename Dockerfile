# Use an official Node.js runtime as a parent image
FROM node:18-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy the package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the TypeScript application
RUN npm run build

# Use a smaller Node.js runtime for the production build
FROM node:18-alpine AS runner

# Set the working directory
WORKDIR /app

# Copy the built application from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

# The HTTP transport is the reason this image exists; stdio needs no container.
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000

EXPOSE 3000

# Liveness only. /ready is the orchestrator's probe, and neither of them
# reports on SAP: restarting this process would not fix SAP, and failing
# every replica over a shared dependency only removes the error message.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.MCP_PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "./dist/main.js"]
