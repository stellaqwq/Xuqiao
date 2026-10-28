FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts/cli.mjs ./scripts/cli.mjs
COPY scripts/native-check.mjs ./scripts/native-check.mjs
COPY scripts/container.mjs ./scripts/container.mjs
COPY examples ./examples
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 5700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:5700/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/container.mjs"]
