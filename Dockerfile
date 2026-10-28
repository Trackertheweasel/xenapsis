# Node 20 reached end of life in April 2026.
# Pinned by digest so a rebuild gets the same image; Dependabot bumps the digest.
FROM node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
# Install before copying the source so code changes don't redo the install layer.
COPY package.json pnpm-lock.yaml ./
# Corepack installs the exact pnpm named in package.json's packageManager field. Kept outside root's
# home, so the unprivileged user below can run it without downloading it again.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
RUN pnpm install --frozen-lockfile
COPY . .
# Baked into the client bundle at build time; the running server reads the same value at runtime.
ARG PUBLIC_PERSEC_WISP_PATH=""
ENV PUBLIC_PERSEC_WISP_PATH=${PUBLIC_PERSEC_WISP_PATH}
ARG PUBLIC_PERSEC_URL_KEY=""
ENV PUBLIC_PERSEC_URL_KEY=${PUBLIC_PERSEC_URL_KEY}
ARG PUBLIC_PERSEC_PROXY_KEY=""
ENV PUBLIC_PERSEC_PROXY_KEY=${PUBLIC_PERSEC_PROXY_KEY}
RUN pnpm build
# Not root, so a hole in anything that handles proxy traffic can't take over the container. Only
# data/ (saved-login backups) is written at runtime; a new volume copies this owner.
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8080
CMD ["pnpm", "start"]
