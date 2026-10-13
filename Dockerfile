# Сервер сетевой игры. В образ попадают только сервер и три файла игрового движка.
FROM node:22-alpine

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/src ./server/src
COPY poker/js/cards.js poker/js/ai.js poker/js/game.js ./poker/js/

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
RUN mkdir -p server/data && chown node:node server/data
USER node
CMD ["node", "server/src/index.js"]
