FROM denoland/deno:debian-2.9.7

RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deno.json deno.lock ./
COPY migrations/ migrations/
COPY src/ src/
COPY static/ static/
RUN deno cache src/main.ts src/server.ts src/worker.ts src/cli.ts \
  && mkdir -p data && chown -R deno:deno data

ENV THOT_HOST=0.0.0.0 THOT_PORT=8000 THOT_DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8000
USER deno
CMD ["run", "-RWNE", "--allow-run", "src/main.ts"]
