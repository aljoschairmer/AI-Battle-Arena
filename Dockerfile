# --- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Prune to production deps for the runtime image.
RUN npm ci --omit=dev

# --- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Pre-create every dir the app writes at runtime and hand them to the
# unprivileged runtime user — /app is COPY'd in as root, so without this the
# scout/brain/engine hit "EACCES: permission denied" on logs/ and
# data/knowledge/ (bind mounts override these with host ownership; the
# volume-init service in docker-compose.yml covers that side).
RUN mkdir -p logs/brain logs/outcomes logs/telemetry data/knowledge/brain \
 && chown -R node:node /app/logs /app/data

# Run as the unprivileged user that the node image ships with.
USER node

# ROLE (engine|brain|all) and BUS (redis|memory) come from the environment.
CMD ["node", "dist/main.js"]
