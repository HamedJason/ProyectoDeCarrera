/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Taller 5: Prueba de concepto reducida
 *
 * Frontend minimo en React Native (Expo).
 *
 * Se eligio React Native desde la prueba de concepto, en lugar de una pagina
 * web desechable, porque la aplicacion movil es el frontend definitivo del
 * proyecto. De esta forma el codigo escrito en esta etapa se conserva en el
 * prototipo alfa en lugar de rehacerse.
 *
 * Esta pantalla demuestra:
 *   - Comunicacion real con el backend desplegado
 *   - Dato mas reciente con su fecha y hora
 *   - Lista con el historico almacenado
 *   - Estados de carga, ausencia de datos y error de comunicacion
 *   - Envio de un comando al actuador
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  SafeAreaView, View, Text, FlatList, StyleSheet,
  ActivityIndicator, RefreshControl, Pressable, StatusBar, Platform
} from 'react-native';

// ===================== Configuracion =====================

// URL del backend desplegado. Debe apuntar al servicio en la nube, no a
// localhost, porque la aplicacion corre en el telefono y no en la computadora.
const BACKEND_BASE = 'https://alarma-poc.onrender.com';
const VIVIENDA_ID = 'casa-001';
const TIMEOUT_MS = 10000;

// ===================== Utilidades =====================

// fetch con tiempo limite, para poder distinguir una red caida de una espera larga
async function fetchConTimeout(url, opciones = {}) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opciones, signal: controlador.signal });
    return r;
  } finally {
    clearTimeout(temporizador);
  }
}

function formatearFecha(iso) {
  if (!iso) return 'sin fecha';
  const d = new Date(iso);
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function interpretarValor(medicion) {
  if (!medicion) return '--';
  if (medicion.variable === 'estado_puerta') {
    return Number(medicion.valor) === 1 ? 'ABIERTA' : 'CERRADA';
  }
  return `${medicion.valor} ${medicion.unidad || ''}`.trim();
}

// ===================== Pantalla =====================

export default function App() {
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState(null);
  const [mediciones, setMediciones] = useState([]);
  const [actuadorActivo, setActuadorActivo] = useState(false);
  const [enviandoComando, setEnviandoComando] = useState(false);

  const cargarDatos = useCallback(async () => {
    setError(null);
    try {
      const url = `${BACKEND_BASE}/mediciones?vivienda_id=${VIVIENDA_ID}&limite=50`;
      const respuesta = await fetchConTimeout(url);

      if (!respuesta.ok) {
        throw new Error(`El servidor respondio con codigo ${respuesta.status}`);
      }

      const datos = await respuesta.json();
      setMediciones(datos.mediciones || []);

      // Estado actual del actuador
      const rc = await fetchConTimeout(`${BACKEND_BASE}/comando?vivienda_id=${VIVIENDA_ID}`);
      if (rc.ok) {
        const dc = await rc.json();
        setActuadorActivo(Boolean(dc.actuador_activo));
      }
    } catch (e) {
      // Se distingue el corte por tiempo limite de otros fallos, porque durante
      // las pruebas de perdida de conexion son situaciones diferentes.
      if (e.name === 'AbortError') {
        setError('No hubo respuesta del servidor. Revisa tu conexion a Internet.');
      } else {
        setError(`No se pudo contactar al backend. ${e.message}`);
      }
    } finally {
      setCargando(false);
      setRefrescando(false);
    }
  }, []);

  useEffect(() => {
    cargarDatos();
    // Actualizacion periodica para ver llegar los eventos durante la demostracion
    const intervalo = setInterval(cargarDatos, 5000);
    return () => clearInterval(intervalo);
  }, [cargarDatos]);

  const alRefrescar = () => {
    setRefrescando(true);
    cargarDatos();
  };

  const alternarActuador = async () => {
    setEnviandoComando(true);
    const nuevoEstado = !actuadorActivo;
    try {
      const r = await fetchConTimeout(`${BACKEND_BASE}/comando`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vivienda_id: VIVIENDA_ID, actuador_activo: nuevoEstado })
      });
      if (!r.ok) throw new Error(`codigo ${r.status}`);
      setActuadorActivo(nuevoEstado);
    } catch (e) {
      setError(`No se pudo enviar el comando. ${e.message}`);
    } finally {
      setEnviandoComando(false);
    }
  };

  const ultima = mediciones.length > 0 ? mediciones[0] : null;

  // ---------- Estado: cargando por primera vez ----------
  if (cargando) {
    return (
      <SafeAreaView style={[estilos.pantalla, estilos.centrado]}>
        <ActivityIndicator size="large" color="#2874A6" />
        <Text style={estilos.textoEstado}>Consultando el backend...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={estilos.pantalla}>
      <StatusBar barStyle="dark-content" />

      <View style={estilos.encabezado}>
        <Text style={estilos.titulo}>Seguridad residencial</Text>
        <Text style={estilos.subtitulo}>Vivienda {VIVIENDA_ID} · prueba de concepto</Text>
      </View>

      {/* ---------- Estado: error de comunicacion ---------- */}
      {error && (
        <View style={estilos.banderaError}>
          <Text style={estilos.textoError}>{error}</Text>
          <Pressable onPress={cargarDatos} style={estilos.botonReintentar}>
            <Text style={estilos.textoBotonReintentar}>Reintentar</Text>
          </Pressable>
        </View>
      )}

      {/* ---------- Dato mas reciente ---------- */}
      <View style={estilos.tarjeta}>
        <Text style={estilos.etiquetaTarjeta}>Último evento registrado</Text>
        <Text style={estilos.valorGrande}>{interpretarValor(ultima)}</Text>
        <Text style={estilos.fechaTarjeta}>
          {ultima ? formatearFecha(ultima.creado_en) : 'sin registros'}
        </Text>
        {ultima && (
          <Text style={estilos.detalleTarjeta}>
            {ultima.zona} · {ultima.nodo_id} · registro #{ultima.numero_registro}
          </Text>
        )}
      </View>

      {/* ---------- Control del actuador ---------- */}
      <Pressable
        onPress={alternarActuador}
        disabled={enviandoComando}
        style={[estilos.botonActuador, actuadorActivo ? estilos.actuadorOn : estilos.actuadorOff]}
      >
        <Text style={estilos.textoBotonActuador}>
          {enviandoComando
            ? 'Enviando comando...'
            : actuadorActivo ? 'Desactivar salida (sirena)' : 'Activar salida (sirena)'}
        </Text>
      </Pressable>

      {/* ---------- Historico ---------- */}
      <Text style={estilos.tituloLista}>Historial ({mediciones.length})</Text>

      <FlatList
        data={mediciones}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={alRefrescar} />}
        // ---------- Estado: sin datos ----------
        ListEmptyComponent={
          <View style={estilos.centrado}>
            <Text style={estilos.textoEstado}>
              Todavía no hay mediciones registradas.{'\n'}
              Genera un evento en el sensor para ver el primer dato.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={estilos.fila}>
            <View style={[
              estilos.indicador,
              { backgroundColor: Number(item.valor) === 1 ? '#C0392B' : '#229954' }
            ]} />
            <View style={{ flex: 1 }}>
              <Text style={estilos.filaTitulo}>{interpretarValor(item)}</Text>
              <Text style={estilos.filaDetalle}>
                {formatearFecha(item.creado_en)} · {item.zona}
              </Text>
            </View>
            <Text style={estilos.filaRegistro}>#{item.numero_registro}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

// ===================== Estilos =====================

const estilos = StyleSheet.create({
  pantalla: {
    flex: 1,
    backgroundColor: '#F4F6F7',
    paddingTop: Platform.OS === 'android' ? 32 : 0
  },
  centrado: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  encabezado: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  titulo: { fontSize: 22, fontWeight: '700', color: '#1B2631' },
  subtitulo: { fontSize: 13, color: '#5D6D7E', marginTop: 2 },

  banderaError: {
    backgroundColor: '#FDEDEC',
    borderLeftWidth: 4,
    borderLeftColor: '#C0392B',
    marginHorizontal: 20,
    marginTop: 8,
    padding: 12,
    borderRadius: 6
  },
  textoError: { color: '#922B21', fontSize: 13 },
  botonReintentar: { marginTop: 8, alignSelf: 'flex-start' },
  textoBotonReintentar: { color: '#C0392B', fontWeight: '700', fontSize: 13 },

  tarjeta: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginTop: 12,
    padding: 20,
    borderRadius: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 }
  },
  etiquetaTarjeta: { fontSize: 12, color: '#7F8C8D', textTransform: 'uppercase', letterSpacing: 0.5 },
  valorGrande: { fontSize: 34, fontWeight: '800', color: '#1B2631', marginTop: 6 },
  fechaTarjeta: { fontSize: 14, color: '#34495E', marginTop: 4 },
  detalleTarjeta: { fontSize: 12, color: '#7F8C8D', marginTop: 6 },

  botonActuador: {
    marginHorizontal: 20,
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center'
  },
  actuadorOn: { backgroundColor: '#C0392B' },
  actuadorOff: { backgroundColor: '#2874A6' },
  textoBotonActuador: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },

  tituloLista: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1B2631',
    marginTop: 22,
    marginBottom: 8,
    marginHorizontal: 20
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 14,
    borderRadius: 8
  },
  indicador: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  filaTitulo: { fontSize: 15, fontWeight: '600', color: '#1B2631' },
  filaDetalle: { fontSize: 12, color: '#7F8C8D', marginTop: 2 },
  filaRegistro: { fontSize: 12, color: '#AAB7B8' },

  textoEstado: { marginTop: 12, fontSize: 14, color: '#5D6D7E', textAlign: 'center' }
});
