# Node 20 reached end of life in April 2026.
# Both images pinned by digest so a rebuild gets the same ones; Dependabot bumps the digests.

# --- Build: needs every dependency, the compilers and the source.
FROM node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384 AS build
WORKDIR /app
# Corepack installs the exact pnpm named in package.json's packageManager field.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
# Install before copying the source so code changes don't redo the install layer.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Baked into the client bundle at build time; the running server reads the same value at runtime.
ARG PUBLIC_PERSEC_WISP_PATH=""
ENV PUBLIC_PERSEC_WISP_PATH=${PUBLIC_PERSEC_WISP_PATH}
ARG PUBLIC_PERSEC_URL_KEY=""
ENV PUBLIC_PERSEC_URL_KEY=${PUBLIC_PERSEC_URL_KEY}
ARG PUBLIC_PERSEC_PROXY_KEY=""
ENV PUBLIC_PERSEC_PROXY_KEY=${PUBLIC_PERSEC_PROXY_KEY}
ARG PUBLIC_PERSEC_SCRUB=""
ENV PUBLIC_PERSEC_SCRUB=${PUBLIC_PERSEC_SCRUB}
ARG PUBLIC_PERSEC_MASK_TEXT=""
ENV PUBLIC_PERSEC_MASK_TEXT=${PUBLIC_PERSEC_MASK_TEXT}
RUN pnpm build
# Swap in only what the server needs at runtime, from the packages already in pnpm's store.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod --offline

# --- Run: the built site, the bundled server and runtime dependencies only. No compilers, source
# or package manager, which keeps the image small and leaves less in it to exploit.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Not root, so a hole in anything that handles proxy traffic can't take over the container. Only
# data/ (saved-login backups) is written at runtime; a new volume copies this owner.
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node itself is PID 1 (not a package manager), so it gets docker stop's SIGTERM and shuts down
# cleanly (see index.ts).
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
