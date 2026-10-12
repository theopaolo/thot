FROM node:26.11.1-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.4.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY src/ src/
RUN pnpm exec vp build
# Une installation --prod par-dessus la complète garde les dépendances de développement.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

FROM node:26.11.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY migrations/ migrations/
COPY src/ src/
COPY static/ static/
COPY --from=build /app/static/dist/ static/dist/
RUN mkdir -p data/tmp && chmod 700 data data/tmp && chown -R node:node data

ENV THOT_HOST=0.0.0.0 THOT_PORT=8000 THOT_DATA_DIR=/app/data
ENV TMPDIR=/app/data/tmp SQLITE_TMPDIR=/app/data/tmp
VOLUME /app/data
EXPOSE 8000
USER node
CMD ["node", "src/main.ts"]
