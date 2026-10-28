# Node 20 reached end of life in April 2026.
# Pinned by digest so a rebuild gets the same image; Dependabot bumps the digest.
FROM node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
# Install before copying the source so code changes don't redo the install layer.
COPY package.json pnpm-lock.yaml ./
# Corepack installs the exact pnpm named in package.json's packageManager field.
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
EXPOSE 8080
CMD ["pnpm", "start"]
