FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Los datos (base de datos y fotos) van en un volumen persistente montado en /data.
# (No se usa la instrucción VOLUME porque Railway no la admite: el volumen se crea desde su panel.)
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/index.js"]
