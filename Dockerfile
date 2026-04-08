FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json config.example.yaml ./
COPY src ./src

RUN npm run build

RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && adduser --disabled-password --no-create-home agent \
    && mkdir -p /app/.digital_me_agent \
    && chown -R agent:agent /app

COPY entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

EXPOSE 8088

ENTRYPOINT ["/app/entrypoint.sh"]
