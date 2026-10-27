# Node 20 reached end of life in April 2026.
FROM node:22
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
RUN npm i -g pnpm@10
# Install before copying the source so code changes don't redo the install layer.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Baked into the client bundle at build time; the running server reads the same value at runtime.
ARG PUBLIC_PERSEC_WISP_PATH=""
ENV PUBLIC_PERSEC_WISP_PATH=${PUBLIC_PERSEC_WISP_PATH}
RUN pnpm build
EXPOSE 8080
CMD ["pnpm", "start"]
