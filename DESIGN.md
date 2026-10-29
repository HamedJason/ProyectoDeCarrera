# DESIGN.md

## Identidad

- **Nombre:** Sentinel Home. Es el único nombre visible en la interfaz (pantalla de acceso, título, app instalada y notificaciones).
- **Qué es:** sistema escalable de seguridad residencial con detección de intrusos, que se adapta al número de puertas, ventanas y zonas de cada casa.
- **Para quién:** propietarios, residentes y familias de viviendas particulares en Tijuana, Baja California.
- **Qué lo distingue:** cada sensor tiene su propia ilustración animada en lugar de un ícono genérico (puertas y ventanas que se abren, ondas del detector de movimiento, haz giratorio de la sirena).
- **Origen:** proyecto de carrera, UABC FCQI.

## Personalidad

- **Cómo se siente:** cercana, fresca y con un toque crema; nunca ruda.
- **Cómo habla:** español de México, en tuteo, directo y breve, sin adjetivos de marketing ni emojis. Ejemplos del tono actual: "La casa está armada", "Todavía no hay sensores", "Escribe el nombre exacto para confirmar".
- **Cuando suena la alarma:** el cambio no es solo de tono. Un haz de luz rojo gira sobre toda la pantalla, como la torreta de una patrulla, con un marco rojo que pulsa. Es solo visual: deja pasar los toques y el botón "Apagar alarma" sigue accesible. Con las animaciones reducidas queda un marco rojo fijo.

## Paleta

Cada color tiene un solo significado.

### Modo claro

| Rol | Color | Razón |
|---|---|---|
| Fondo | yeso `#E6EBE7` | Base fresca y suave que no cansa. |
| Superficie | papel `#F6F8F5` | Separa las tarjetas del fondo sin sombra pesada. |
| Texto | tinta `#15302B` y tinta-2 `#4B625C` | Verde muy oscuro que mantiene la calidez en lugar de negro puro. |
| Líneas | línea `#C5D0CA` | Borde discreto de las tarjetas. |
| Bordes de controles | `#7F918A` | Los campos y botones deben distinguirse con 3:1 de contraste. |
| Acento | pino `#17695A`, pino-claro `#D3E6DF` | Significa "armado": la tranquilidad del sistema activo. |
| Actividad | ámbar `#E39B12`, texto `#8A5A00` | Significa actividad o algo abierto, sin ser todavía alarma. |
| Alarma | sirena `#D22F27`, texto `#B3231C`, fondo `#F8DAD6` | Se usa únicamente para una alarma; el texto rojo es más oscuro para que se lea bien sobre el fondo rosado. |

### Modo oscuro

Mismos tonos con la saturación reducida sobre un gris neutro y cálido que no cansa la vista. Se elige en el panel lateral: Sistema (sigue al dispositivo), Claro u Oscuro.

| Rol | Color | Razón |
|---|---|---|
| Fondo | gris `#262624` | Gris suave, sin el negro puro que cansa. |
| Superficie | `#30302E` | Separa las tarjetas del fondo. |
| Texto | crema `#ECE8DC` y `#B3AFA2` | Conserva el toque crema de la identidad. |
| Líneas | `#4A4945`; bordes de controles `#8A8780` | Mismo uso que en claro. |
| Acento | pino `#6FB3A1` | Pino con menos saturación. |
| Actividad | ámbar `#D9A441`, texto `#E3B866` | Ámbar con menos saturación. |
| Alarma | sirena `#E5766D`, texto `#F0A29B`, fondo `#3F2927` | Rojo con menos saturación que sigue destacando sobre el gris. |

### Pendiente

- **Crema en el modo claro:** los fondos claros siguen siendo verdes grisáceos. Si se quiere un fondo más crema, falta definir el color: [POR DEFINIR].

## Tipografía

- **Bricolage Grotesque** (variable, licencia OFL), única fuente de la interfaz.
  - Razón: se sirve desde el propio backend, así funciona sin Internet y sobre HTTP.
  - Razón de carácter: su forma redondeada y expresiva da el tono cercano que se busca.
- **Titulares:** peso 800, ancho 86%, interletrado ajustado.
  - Razón: que el estado de la casa se lea de un vistazo.
- **Cifras y horas:** numerales tabulares.
  - Razón: que las horas no salten al actualizarse.
- **Token:** fuente monoespaciada del sistema.
  - Razón: es un valor técnico que se copia.

## Mood

- Cercano y cálido, fresco, con la identidad visual actual como base.
- Movimiento protagonista. Las animaciones infinitas de las ilustraciones se conservan.
  - Razón: son lo que distingue al producto.
  - Mejoras: las tarjetas nuevas entran deslizándose en cascada, el titular del estado se cruza al cambiar y el panel lateral entra desde el borde.
  - Control: el panel lateral tiene "Reducir animaciones", que detiene todo movimiento (también se respeta la preferencia del sistema).
- El resplandor de los LEDs se conserva.
  - Razón: representa los LED físicos de cada sensor.
- La rejilla de tarjetas se conserva.
  - Razón: cada tarjeta tiene su propia ilustración y el patrón repetido ordena el panel.
- Panel lateral con los datos de la cuenta (usuario, vivienda, apariencia, cerrar sesión).
  - Razón: la pantalla principal queda para el estado de la casa y lo demás se consulta aparte.
- Layout: columna central de 760 px como máximo.
  - Razón: se usa desde el teléfono.
- Escala de radios y de espaciado: [POR DEFINIR].
- Referencias visuales externas: [POR DEFINIR]. No hay referencias, y la identidad actual es la referencia.

Dial: ENERGY 2 / RHYTHM 1 / MOTION 3
