FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV CATAN_DATA_DIR=/app/server/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/index.ts /app/server/rankings.ts /app/server/rankings-store.ts /app/server/rankings-storage.ts /app/server/rankings-firestore.ts /app/server/rankings-import.ts /app/server/firebase.ts ./server/
COPY --from=build /app/src/rankings/model.ts ./src/rankings/
COPY --from=build /app/src/game/engine.ts /app/src/game/board.ts /app/src/game/types.ts ./src/game/
RUN mkdir -p /app/server/data
RUN chown node:node /app/server/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "server/index.ts"]
