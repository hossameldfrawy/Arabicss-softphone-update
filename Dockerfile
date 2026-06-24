# Deterministic container for the manifest micro-backend (Railway can also build this
# with Nixpacks automatically; the Dockerfile is here for reproducible/self-hosted runs).
FROM node:20-alpine
WORKDIR /app
# No dependencies to install — the server is pure Node stdlib.
COPY package.json ./
COPY server.js ./
COPY manifest.json ./
ENV HOST=0.0.0.0
EXPOSE 8080
# Run as the built-in unprivileged user.
USER node
CMD ["node", "server.js"]
