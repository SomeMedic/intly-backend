FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    INTLY_PDF_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    TESSERACT_LANG_PATH=/app/tessdata \
    TESSERACT_CACHE_PATH=/tmp/tesseract-cache
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core gzip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/admin-bootstrap-production.mjs ./scripts/admin-bootstrap-production.mjs
COPY --chown=node:node eng.traineddata rus.traineddata ./tessdata/
RUN gzip -9 ./tessdata/eng.traineddata ./tessdata/rus.traineddata \
  && mkdir -p /tmp/tesseract-cache \
  && chown -R node:node /tmp/tesseract-cache
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
