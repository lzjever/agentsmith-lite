FROM node:24-bookworm-slim
WORKDIR /app
ARG APP_PUBLIC_BASE_URL
ARG NODE_BUILD_HEAP_MB=2048
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ports/package.json packages/ports/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/adapters-postgres/package.json packages/adapters-postgres/package.json
COPY packages/sandbox-controller/package.json packages/sandbox-controller/package.json
COPY packages/botified-runtime/package.json packages/botified-runtime/package.json
COPY packages/openai-compatible-client/package.json packages/openai-compatible-client/package.json
COPY packages/api-entry-node/package.json packages/api-entry-node/package.json
RUN npm ci
COPY . .
ENV APP_PUBLIC_BASE_URL=$APP_PUBLIC_BASE_URL
ENV APP_BUILD_PUBLIC_BASE_URL=$APP_PUBLIC_BASE_URL
RUN NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_HEAP_MB}" npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/packages/api-entry-node/src/main.js"]
