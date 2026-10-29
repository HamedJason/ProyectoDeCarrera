import { createApp } from 'vue';
import App from './App.vue';
import { aplicarApariencia } from './stores/tema.js';

import './estilos/base.css';
import './estilos/panel.css';
import './estilos/tarjetas.css';
import './estilos/ilustraciones.css';
import './estilos/dialogos.css';
import './estilos/ajustes-historial.css';
import './estilos/acceso.css';
import './estilos/viviendas.css';
import './estilos/camara.css';
import './estilos/haz-alarma.css';
import './estilos/panel-lateral.css';
import './estilos/responsivo.css';

// El tema se aplica antes de montar para evitar un destello del modo equivocado
aplicarApariencia();
createApp(App).mount('#raiz');
