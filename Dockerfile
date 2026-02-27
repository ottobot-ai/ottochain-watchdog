# OttoChain Watchdog
# Multi-stage build for minimal production image

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -g 1001 -S watchdog && \
    adduser -S watchdog -u 1001 -G watchdog

# SSH key needs to be mounted at runtime for restart capabilities
# Mount to: /home/watchdog/.ssh/id_rsa
RUN mkdir -p /home/watchdog/.ssh && chown -R watchdog:watchdog /home/watchdog/.ssh

USER watchdog

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

# Default: daemon mode
ENV NODE_ENV=production
CMD ["node", "dist/index.js", "--daemon"]
