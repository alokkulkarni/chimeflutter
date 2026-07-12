# chimeflutter-backend — container deployment with functional parity to the SAM/Lambda deployment.
# The image hosts the SAME Lambda handlers behind a dependency-free Node HTTP adapter
# (src/server/main.ts); routing, validation, error envelope and logging are identical.
#
# AWS credentials: NONE are baked in. The AWS SDK's default provider chain resolves ROLE-BASED
# credentials at runtime — ECS task role / EKS IRSA / EC2 instance profile (docs/BACKEND.md §7).

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as the unprivileged 'node' user shipped with the base image.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]
