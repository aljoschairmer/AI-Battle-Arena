# --- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Optional corporate root CAs (Zscaler etc.): drop *.crt files into certs/
# (gitignored — never commit a corporate certificate) before building. The
# bundle file always exists so NODE_EXTRA_CA_CERTS is safe to set; it's simply
# empty when no certs were provided.
COPY certs/ /app/certs/
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/* \
 && touch /usr/local/share/ca-certificates/corp-ca-bundle.crt \
 && if ls /app/certs/*.crt >/dev/null 2>&1; then \
      cat /app/certs/*.crt > /usr/local/share/ca-certificates/corp-ca-bundle.crt \
      && update-ca-certificates; \
    fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-ca-bundle.crt

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

# Same optional corporate CA bundle as the build stage (see above).
COPY --from=build /usr/local/share/ca-certificates/corp-ca-bundle.crt /usr/local/share/ca-certificates/corp-ca-bundle.crt
RUN apt-get update && apt-get install -y ca-certificates && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-ca-bundle.crt

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
