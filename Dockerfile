# Minimal runtime image for blind-peer-cli
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install build deps for any native modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY bin.js bare-bin.js ./

ARG TARGETARCH
# Keep only the prebuilds for the target arch to cut image size.
RUN arch="${TARGETARCH:-$(uname -m)}" \
  && case "$arch" in \
    amd64|x86_64) keep="linux-x64" ;; \
    arm64|aarch64) keep="linux-arm64" ;; \
    *) keep="linux-$arch" ;; \
  esac \
  && find node_modules -type d -name prebuilds \
    -exec sh -c 'for d in "$1"/*; do [ "$d" = "$1/$2" ] || rm -rf "$d"; done' _ {} "$keep" \;

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json bin.js bare-bin.js ./

VOLUME ["/data"]

# Default storage path can be overridden with args.
ENTRYPOINT ["node", "/app/bin.js", "--storage", "/data"]
