# --- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Trust Zscaler root CA for TLS connections behind corporate proxy
COPY ZscalerRootCertificate-2048-SHA256.crt /usr/local/share/ca-certificates/ZscalerRootCertificate.crt
RUN apt-get update && apt-get install -y ca-certificates && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ZscalerRootCertificate.crt

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

# Trust Zscaler root CA for TLS connections behind corporate proxy
COPY ZscalerRootCertificate-2048-SHA256.crt /usr/local/share/ca-certificates/ZscalerRootCertificate.crt
RUN apt-get update && apt-get install -y ca-certificates && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ZscalerRootCertificate.crt

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as the unprivileged user that the node image ships with.
USER node

# ROLE (engine|brain|all) and BUS (redis|memory) come from the environment.
CMD ["node", "dist/main.js"]
