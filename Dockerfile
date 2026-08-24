FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /config && chown -R 99:100 /config && chmod -R a+rX /app
USER 99:100
VOLUME ["/config"]
EXPOSE 8787
CMD ["node", "src/index.js"]
