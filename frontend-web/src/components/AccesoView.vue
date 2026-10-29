<!-- Pantalla de acceso: iniciar sesion o crear cuenta -->
<script setup>
import { reactive, ref, watch } from 'vue';
import { pantalla, acceso } from '../stores/sesion.js';
import { entrar, crearCuenta, arrancar } from '../stores/cuenta.js';

const dentro = reactive({ email: '', clave: '' });
const nueva = reactive({ nombre: '', email: '', clave: '', codigo: '' });
const errorEntrar = ref('');
const errorCrear = ref('');
const ocupado = ref(false);

// Si llega un enlace de invitacion (?codigo=...), el codigo ya viene escrito
watch(() => acceso.codigoInicial, (c) => { if (c) nueva.codigo = c; }, { immediate: true });
// Al cambiar de pestana se borran los errores
watch(() => acceso.pestana, () => { errorEntrar.value = ''; errorCrear.value = ''; });

async function enviarEntrar() {
  errorEntrar.value = '';
  ocupado.value = true;
  const r = await entrar(dentro.email.trim(), dentro.clave);
  if (r) errorEntrar.value = r; else dentro.clave = '';
  ocupado.value = false;
}

async function enviarCrear() {
  errorCrear.value = '';
  ocupado.value = true;
  const r = await crearCuenta({
    nombre: nueva.nombre.trim(), email: nueva.email.trim(), clave: nueva.clave, codigo: nueva.codigo.trim()
  });
  if (r) errorCrear.value = r; else nueva.clave = '';
  ocupado.value = false;
}
</script>

<template>
  <main id="acceso" :class="{ visible: pantalla === 'acceso' }" aria-label="Acceso">
    <div class="acceso-caja">
      <h1 class="titular">Sentinel Home</h1>
      <p class="subtitular">{{ acceso.subtitulo }}</p>

      <div v-show="!acceso.ocultarPestanas" class="pestanas" role="tablist">
        <button type="button" role="tab" :class="{ activa: acceso.pestana === 'entrar' }" @click="acceso.pestana = 'entrar'">Entrar</button>
        <button type="button" role="tab" :class="{ activa: acceso.pestana === 'crear' }" @click="acceso.pestana = 'crear'">Crear cuenta</button>
      </div>

      <form v-show="acceso.pestana === 'entrar'" @submit.prevent="enviarEntrar">
        <label class="campo"><span>Correo</span><input v-model="dentro.email" type="email" autocomplete="username" required maxlength="120"></label>
        <label class="campo"><span>Contraseña</span><input v-model="dentro.clave" type="password" autocomplete="current-password" required maxlength="200"></label>
        <p class="error-msg" :class="{ visible: !!errorEntrar }" role="alert">{{ errorEntrar }}</p>
        <button type="submit" class="boton armar" :disabled="ocupado">Entrar</button>
      </form>

      <form v-show="acceso.pestana === 'crear'" @submit.prevent="enviarCrear">
        <label class="campo"><span>Nombre</span><input v-model="nueva.nombre" type="text" autocomplete="name" required maxlength="60"></label>
        <label class="campo"><span>Correo</span><input v-model="nueva.email" type="email" autocomplete="username" required maxlength="120"></label>
        <label class="campo"><span>Contraseña (mínimo 8 caracteres)</span><input v-model="nueva.clave" type="password" autocomplete="new-password" required minlength="8" maxlength="200"></label>
        <label v-show="!acceso.ocultarCodigo" class="campo"><span>{{ acceso.codigoEtiqueta }}</span><input v-model="nueva.codigo" type="text" autocomplete="off" maxlength="12" placeholder="XXXX-XXXX" style="text-transform:uppercase" :required="acceso.codigoRequerido"></label>
        <p class="nota-acceso">{{ acceso.nota }}</p>
        <p class="error-msg" :class="{ visible: !!errorCrear }" role="alert">{{ errorCrear }}</p>
        <button type="submit" class="boton armar" :disabled="ocupado">Crear cuenta</button>
      </form>

      <div v-if="acceso.avisoError" class="aviso-acceso">
        <div>{{ acceso.avisoError }}</div>
        <button type="button" class="boton-texto" style="margin-top:8px" @click="arrancar">Reintentar</button>
      </div>
    </div>
  </main>
</template>
