import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// La aplicacion compilada se escribe en backend/publico, que es lo que sirve el backend
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: '../backend/publico',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    // En desarrollo las llamadas a la API van al backend local
    proxy: Object.fromEntries(
      ['/auth', '/estado', '/mediciones', '/acciones', '/sensores', '/viviendas', '/invitaciones', '/push',
       '/configuracion', '/limpiar', '/camara', '/fotos'].map((r) => [r, 'http://localhost:3000'])
    )
  }
});
