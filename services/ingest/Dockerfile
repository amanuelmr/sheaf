# Node runs the TypeScript directly, so there is no build step and nothing compiled
# that could differ from what the tests ran against.
FROM node:24-alpine

WORKDIR /srv

# The service has no third-party runtime dependencies -- node:http, node:sqlite and
# node:fs are all of it -- so there is nothing to install. The only resolution it
# needs is for its two workspace packages, which is exactly what these symlinks are:
# what pnpm would have linked, without an install step, a lockfile, or a network.
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/store/package.json packages/store/package.json
COPY packages/store/src packages/store/src
COPY services/ingest/package.json services/ingest/package.json
COPY services/ingest/src services/ingest/src

RUN mkdir -p node_modules/@sheaf \
  && ln -s /srv/packages/protocol node_modules/@sheaf/protocol \
  && ln -s /srv/packages/store    node_modules/@sheaf/store

ENV SHEAF_DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787

# Create the data directory owned by the unprivileged user *before* declaring the
# volume: a fresh named volume inherits ownership from the image directory it is
# mounted over. Declaring the volume first leaves it owned by root, and the server
# then fails to open its database with a bare "unable to open database file".
RUN mkdir -p /data && chown -R node:node /data /srv
VOLUME ["/data"]

USER node

CMD ["node", "--experimental-strip-types", "services/ingest/src/main.ts"]
