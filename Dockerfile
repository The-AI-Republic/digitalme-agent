FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json config.example.yaml ./
COPY src ./src

RUN npm run build

RUN adduser --disabled-password --no-create-home agent \
    && mkdir -p /app/.digital_me_agent \
    && chown -R agent:agent /app

USER agent

EXPOSE 8088

CMD ["npm", "start"]
