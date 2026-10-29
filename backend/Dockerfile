# Imagen del backend de la prueba de concepto.
# Se usa Alpine por ser ligera, lo que reduce el tiempo de construcción en el VPS.

FROM node:20-alpine

# Sin esto Express muestra la pila de errores en las respuestas y corre mas lento
ENV NODE_ENV=production

WORKDIR /app

# ffmpeg lo usa el agente de la camara (camara_rtsp.js) para sacar fotos y cuadros
# de la MC210 por RTSP, solo cuando hay una tarea. Sin CAMARA_RTSP_ACTIVO=1 no se ejecuta.
RUN apk add --no-cache ffmpeg

# Se copian primero los archivos de dependencias para aprovechar la caché de Docker.
# Si el código cambia pero las dependencias no, esta capa no se reconstruye.
COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
