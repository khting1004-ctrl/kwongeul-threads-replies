FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATA_DIR=/app/data POLL_SECONDS=120
EXPOSE 3000
CMD ["node", "server.js"]
