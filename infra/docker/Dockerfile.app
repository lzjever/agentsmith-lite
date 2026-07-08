FROM node:24-bookworm-slim
WORKDIR /app
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
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/packages/api-entry-node/src/main.js"]
