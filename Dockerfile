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
ENV FASHION_AGENT_WEB_PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/public ./public
COPY --from=build /app/data ./data
COPY --from=build /app/examples ./examples
COPY --from=build /app/skills ./skills

RUN mkdir -p out examples/captured

EXPOSE 8080

CMD ["node", "dist/server/webServer.js"]
