# Node runs the TypeScript directly, so there is no build step and nothing compiled
# that could differ from what the tests ran against.
FROM node:25-alpine

WORKDIR /srv

# Three third-party packages, all pure JavaScript with no install scripts: pdf-lib
# for page edits, double-sided collation and barcode splitting, jpeg-js and
# @zxing/library for reading barcodes. Installed at /srv, where Node finds them by
# walking up from the service; the versions match services/ingest/package.json.
# The workspace packages are symlinked below: what pnpm would have linked.
COPY packages/core/package.json      packages/core/package.json
COPY packages/core/src               packages/core/src
COPY packages/extract/package.json   packages/extract/package.json
COPY packages/extract/src            packages/extract/src
COPY packages/http/package.json      packages/http/package.json
COPY packages/http/src               packages/http/src
COPY packages/protocol/package.json  packages/protocol/package.json
COPY packages/protocol/src           packages/protocol/src
COPY packages/paperless/package.json packages/paperless/package.json
COPY packages/paperless/src          packages/paperless/src
COPY packages/store/package.json     packages/store/package.json
COPY packages/store/src              packages/store/src
COPY services/ingest/package.json    services/ingest/package.json
COPY services/ingest/src             services/ingest/src

RUN npm install --no-save --no-package-lock --ignore-scripts --omit=dev \
      pdf-lib@1.17.1 jpeg-js@0.4.4 @zxing/library@0.21.3 \
  && npm cache clean --force

# One symlink per workspace package the service imports, directly or transitively.
# Made after npm install, which removes from node_modules anything it did not put
# there itself. Miss one and it fails at startup rather than at build, so they are
# listed explicitly rather than globbed.
RUN mkdir -p node_modules/@sheaf \
  && for pkg in core extract http protocol paperless store; do \
       ln -s "/srv/packages/$pkg" "node_modules/@sheaf/$pkg"; \
     done

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
