FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node-base

FROM node-base AS whisper-build
ARG WHISPER_REVISION=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARG WHISPER_SHA256=645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${WHISPER_REVISION}" -o /tmp/whisper.tar.gz \
    && echo "${WHISPER_SHA256}  /tmp/whisper.tar.gz" | sha256sum -c - \
    && mkdir /whisper && tar -xzf /tmp/whisper.tar.gz -C /whisper --strip-components=1 \
    && cmake -S /whisper -B /whisper/build -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_CCACHE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build /whisper/build --target whisper-cli -j 1

FROM node-base AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY src ./src
COPY tsconfig*.json ./
RUN npm run build

FROM dependencies AS test
COPY src ./src
COPY tests ./tests
COPY tsconfig*.json vitest.config.ts .prettierrc.json ./
RUN npm run check && npm test

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node-base AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10003 controller \
    && useradd --uid 10003 --gid controller --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin controller \
    && install -d -m 0700 -o controller -g controller /data \
    && mkdir -p /workspace /models /home/agent/.config/opencode/skills
COPY --from=whisper-build /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 10003:10003
CMD ["node", "dist/index.js"]
