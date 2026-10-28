<!-- Seccion de la camara: eventos de deteccion y galeria de fotos -->
<script setup>
import { computed } from 'vue';
import {
  deteccion, eventos, fotos, camaraVisible, limiteEventos, limiteFotos, verMasEventos, verMasFotos
} from '../stores/camara.js';
import { ui } from '../stores/ui.js';
import { agruparEventos, etiquetaEvento } from '../utils/eventosCamara.js';
import { formatearFecha } from '../utils/formato.js';

const grupos = computed(() => agruparEventos(eventos.value));
const activa = computed(() => !!(deteccion.value && deteccion.value.activa));
const mostrarDeteccion = computed(() => activa.value || grupos.value.length > 0);
const visibles = computed(() => grupos.value.slice(0, limiteEventos.value).map((g) => {
  const [texto, clase] = etiquetaEvento(g);
  return { ...g, texto, clase, que: g.detector === 'persona' ? 'Persona detectada' : 'Movimiento detectado' };
}));

// Resumen de lo que ve la deteccion; las partes en negrita se marcan con b
const resumen = computed(() => {
  if (!activa.value) return [];
  const d = deteccion.value;
  const nombres = { persona: 'persona', movimiento: 'movimiento' };
  const lista = (l) => l.map((x) => nombres[x] || x).join(' y ');
  const p = [];
  if (!d.conectado) {
    p.push({ b: true, t: 'Sin conexión con la detección de la cámara.' }, { t: ' Se reintenta sola.' });
  } else {
    const ahora = [];
    if (d.persona === true) ahora.push('persona');
    if (d.movimiento === true) ahora.push('movimiento');
    if (ahora.length) p.push({ t: 'Ahora detecta: ' }, { b: true, t: ahora.join(' y ') }, { t: '. ' });
    else p.push({ t: 'Detección activa, sin nada en el encuadre. ' });
  }
  const pol = d.politica || {};
  if (pol.sirena && pol.sirena.length) p.push({ t: ' La alarma suena por ' + lista(pol.sirena) + ' (con la casa armada).' });
  else if (pol.alertar && pol.alertar.length) p.push({ t: ' Avisa por ' + lista(pol.alertar) + ' (con la casa armada).' });
  return p;
});

function abrirFoto(f) { ui.fotoAbierta = f; ui.foto = true; }
</script>

<template>
  <section v-if="camaraVisible" class="grupo" aria-label="Cámara">
    <div class="grupo-cab"><h2>Cámara</h2></div>

    <div v-if="mostrarDeteccion" class="det">
      <h3 class="det-titulo" style="margin:0 0 2px;font-size:16px">Detección de la cámara</h3>
      <div class="det-estado">
        <template v-for="(x, i) in resumen" :key="i"><b v-if="x.b">{{ x.t }}</b><template v-else>{{ x.t }}</template></template>
      </div>
      <ul class="eventos">
        <li v-for="g in visibles" :key="g.t + g.detector" :class="[g.detector, g.clase]">
          <span class="punto"></span>
          <div class="cuerpo">
            <div class="que">{{ g.que }}<span v-if="g.n > 1" class="cuando"> ×{{ g.n }}</span></div>
            <div class="cuando">{{ formatearFecha(g.t) }}</div>
          </div>
          <span class="etiqueta">{{ g.texto }}</span>
        </li>
        <li v-if="!visibles.length" class="vacio">Todavía no se detecta nada. Cuando la cámara vea una persona o movimiento, aparecerá aquí.</li>
      </ul>
      <button v-if="grupos.length > limiteEventos" class="boton-texto" style="margin-top:8px" @click="verMasEventos">Ver más eventos</button>
    </div>

    <div class="galeria">
      <button
        v-for="f in fotos" :key="f.id" type="button"
        :aria-label="'Foto: ' + (f.motivo || '')" @click="abrirFoto(f)"
      >
        <img loading="lazy" decoding="async" alt="" :src="'/fotos/' + f.id + '/imagen'">
        <span class="sello">{{ formatearFecha(f.creado_en) }}</span>
      </button>
    </div>
    <button v-if="fotos.length >= limiteFotos" class="boton-texto" style="margin-top:10px" @click="verMasFotos">Ver más fotos</button>
  </section>
</template>
