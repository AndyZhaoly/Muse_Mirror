FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY . .
RUN npm run web:build && npm run build

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV FASHION_AGENT_OUTPUT_DIR=/app/out
ENV FASHION_AGENT_MEMORY_DATA=/app/out/muse-memory-v1.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/public ./public
COPY --from=build /app/data ./data
COPY --from=build /app/examples ./examples
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/skills ./skills

RUN mkdir -p /app/out /app/examples/captured \
  && chown -R node:node /app/out /app/examples/captured

EXPOSE 8080

USER node

CMD ["node", "dist/src/server/webServer.js"]
