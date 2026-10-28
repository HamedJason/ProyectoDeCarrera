// Estado de la comunicacion con el servidor: aviso de fallo y texto del pie

import { reactive } from 'vue';

export const conexion = reactive({ aviso: '', visible: false, muerto: false, pie: 'Conectando' });

export function mostrarAviso(mensaje) {
  conexion.aviso = mensaje;
  conexion.visible = true;
  conexion.muerto = true;
  conexion.pie = 'Sin conexión';
}

export function ocultarAviso() {
  conexion.visible = false;
  conexion.muerto = false;
}
