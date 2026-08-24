# Node runs the TypeScript directly, so there is no build step and nothing compiled
# that could differ from what the tests ran against.
FROM node:24-alpine

RUN corepack enable
WORKDIR /srv

# Workspace manifests first, so a dependency change is what invalidates the layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/store/package.json packages/store/
COPY services/ingest/package.json services/ingest/
RUN pnpm install --frozen-lockfile --filter @sheaf/ingest... --prod=false --ignore-scripts

COPY packages/protocol/src packages/protocol/src
COPY packages/store/src packages/store/src
COPY services/ingest/src services/ingest/src

ENV SHEAF_DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "--experimental-strip-types", "services/ingest/src/main.ts"]
