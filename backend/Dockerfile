# Imagen del backend de la prueba de concepto.
# Se usa Alpine por ser ligera, lo que reduce el tiempo de construcción en el VPS.

FROM node:20-alpine

WORKDIR /app

# Se copian primero los archivos de dependencias para aprovechar la caché de Docker.
# Si el código cambia pero las dependencias no, esta capa no se reconstruye.
COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
