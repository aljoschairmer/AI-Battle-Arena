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

# Run as the unprivileged user that the node image ships with.
USER node

# ROLE (engine|brain|all) and BUS (redis|memory) come from the environment.
CMD ["node", "dist/main.js"]
