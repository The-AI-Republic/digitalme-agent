FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json config.example.yaml ./
COPY src ./src

RUN npm run build

COPY entrypoint.sh ./
RUN adduser --disabled-password --no-create-home agent \
    && chown -R agent:agent /app \
    && chmod +x /app/entrypoint.sh

EXPOSE 8088

ENTRYPOINT ["/app/entrypoint.sh"]
