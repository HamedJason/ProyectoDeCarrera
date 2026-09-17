"""
Genera los diagramas del Taller 5:
  1. Diagrama de conexion del hardware de la prueba de concepto
  2. Diagrama del flujo implementado (las cinco capas con su tecnologia real)

Cada flecha se ancla al borde exacto de la caja de origen y destino, para que
ninguna termine en un punto vacio del lienzo.
"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle, Rectangle

SALIDA = "/home/claude/poc-alarma/docs"


def make_box(ax, x, y, w, h, text, fc="#EAF1FB", ec="#2C3E50", fs=9.5, bold=False):
    b = FancyBboxPatch((x, y), w, h,
                       boxstyle="round,pad=0.02,rounding_size=0.02",
                       linewidth=1.3, edgecolor=ec, facecolor=fc)
    ax.add_patch(b)
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, color="#1a1a1a",
            fontweight="bold" if bold else "normal")
    return {
        "x": x, "y": y, "w": w, "h": h,
        "left": (x, y + h / 2),
        "right": (x + w, y + h / 2),
        "top": (x + w / 2, y + h),
        "bottom": (x + w / 2, y),
        "cx": x + w / 2, "cy": y + h / 2,
    }


def arrow(ax, p1, p2, color="#2C3E50", lw=1.4, ls="solid", style="-|>"):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=14,
                                 linewidth=lw, color=color, linestyle=ls))


# =========================================================
# 1. Diagrama de flujo implementado
# =========================================================
fig, ax = plt.subplots(figsize=(12, 7.0))
ax.set_xlim(0, 12)
ax.set_ylim(0, 7.0)
ax.axis("off")

ax.text(6.0, 6.62, "Flujo planteado para la prueba de concepto",
        fontsize=16, ha="center", weight="bold")
ax.text(6.0, 6.22,
        "Cada bloque indica la tecnología seleccionada y ya codificada para esta etapa",
        fontsize=11, ha="center", color="#5D6D7E")

y = 3.4
h = 1.35

b1 = make_box(ax, 0.25, y, 2.05, h, "Entrada física\n\npush button\n(equivale a reed)", fc="#FDEBD0", fs=10.5)
b2 = make_box(ax, 2.55, y, 2.2, h, "Sistema embebido\n\nESP32 DevKit\ndebounce + JSON", fc="#D6EAF8", fs=10.5)
b3 = make_box(ax, 5.0, y, 2.2, h, "Backend en la nube\n\nNode + Express\nen Render", fc="#EBDEF0", fs=10.5)
b4 = make_box(ax, 7.45, y, 2.15, h, "Base de datos\n\nPostgreSQL\ntabla mediciones", fc="#E8DAEF", fs=10.5)
b5 = make_box(ax, 9.85, y, 1.9, h, "Frontend\n\nReact Native\n(Expo)", fc="#D1F2EB", fs=10.5)

# --- Camino de escritura: del sensor hasta la base de datos ---
arrow(ax, b1["right"], b2["left"])
arrow(ax, b2["right"], b3["left"])
arrow(ax, b3["right"], b4["left"])

etiquetas = [
    (b1["right"][0], b2["left"][0], "GPIO 4\npull-up"),
    (b2["right"][0], b3["left"][0], "Wi-Fi + HTTPS\nPOST /mediciones"),
    (b3["right"][0], b4["left"][0], "INSERT SQL\n(marca de tiempo)"),
]
for x1, x2, txt in etiquetas:
    ax.text((x1 + x2) / 2, y + h + 0.24, txt, fontsize=9, ha="center", color="#2874A6")

# --- Camino de lectura ---
# El frontend NO consulta la base de datos directamente. Pide los datos al
# backend y este ejecuta el SELECT, por eso la flecha de lectura se dibuja
# del frontend hacia el backend y no de la base de datos hacia el frontend.
ruta_lectura_y = 5.75
puntos_lectura = [
    (b5["cx"], b5["y"] + b5["h"]),
    (b5["cx"], ruta_lectura_y),
    (b3["cx"] + 0.45, ruta_lectura_y),
]
ax.plot([p[0] for p in puntos_lectura], [p[1] for p in puntos_lectura],
        color="#117864", linewidth=1.6)
arrow(ax, (b3["cx"] + 0.45, ruta_lectura_y), (b3["cx"] + 0.45, b3["y"] + b3["h"]),
      color="#117864", lw=1.6)
ax.text(8.6, ruta_lectura_y + 0.18, "GET /mediciones   (el frontend consulta al backend)",
        fontsize=9.2, ha="center", color="#117864")

# El backend responde con el resultado del SELECT
ax.text((b3["right"][0] + b4["left"][0]) / 2, y - 0.42, "SELECT\n(respuesta al backend)",
        fontsize=8.8, ha="center", color="#117864")
arrow(ax, (b4["x"], y + 0.32), (b3["x"] + b3["w"], y + 0.32), color="#117864", lw=1.3)

# Retorno del comando del actuador: frontend -> backend -> ESP32 -> LED
b_led = make_box(ax, 2.55, 1.3, 2.2, 0.85, "Actuador: LED\n(sustituye la sirena)", fc="#F9E79F", fs=10)

ruta_y = 0.65
puntos = [
    (b5["cx"], b5["y"]),
    (b5["cx"], ruta_y),
    (b3["cx"], ruta_y),
]
ax.plot([p[0] for p in puntos], [p[1] for p in puntos],
        color="#B03A2E", linestyle="dashed", linewidth=1.6)
arrow(ax, (b3["cx"], ruta_y), (b3["cx"], b3["y"]), color="#B03A2E", ls="dashed", lw=1.6)
ax.text(8.3, ruta_y - 0.32, "POST /comando", fontsize=9.2, ha="center", color="#B03A2E")

arrow(ax, b2["bottom"], b_led["top"], color="#B03A2E", ls="dashed", lw=1.6)
ax.text(3.9, 2.5, "el ESP32 consulta\nGET /comando cada 2 s",
        fontsize=8.8, ha="left", color="#B03A2E")

plt.tight_layout()
plt.savefig(f"{SALIDA}/diagrama_flujo.png", dpi=170)
plt.close()
print("flujo ok")


# =========================================================
# 2. Diagrama de conexion del hardware
# =========================================================
fig, ax = plt.subplots(figsize=(11, 6.8))
ax.set_xlim(0, 11)
ax.set_ylim(0, 6.8)
ax.axis("off")

ax.text(5.5, 6.45, "Diagrama de conexión de la prueba de concepto",
        fontsize=14, ha="center", weight="bold")

# --- Placa ESP32 ---
placa = Rectangle((3.6, 1.5), 3.6, 3.6, linewidth=1.6,
                  edgecolor="#2C3E50", facecolor="#D6EAF8")
ax.add_patch(placa)
ax.text(5.4, 4.65, "ESP32 DevKit V1", ha="center", fontsize=11, weight="bold")
ax.text(5.4, 4.3, "alimentación por USB desde\nla computadora (5 V)",
        ha="center", fontsize=8, color="#5D6D7E")

# Pines del lado izquierdo
pines_izq = [("GPIO 4", 3.6), ("GND", 3.0)]
for nombre, py in pines_izq:
    ax.add_patch(Circle((3.6, py), 0.075, color="#2C3E50"))
    ax.text(3.78, py, nombre, fontsize=8.5, va="center", ha="left")

# Pines del lado derecho
pines_der = [("GPIO 2", 3.6), ("GND", 3.0)]
for nombre, py in pines_der:
    ax.add_patch(Circle((7.2, py), 0.075, color="#2C3E50"))
    ax.text(7.02, py, nombre, fontsize=8.5, va="center", ha="right")

# --- Entrada: push button ---
ax.text(1.55, 4.35, "Entrada física", fontsize=10, weight="bold", ha="center")
boton = Rectangle((0.85, 3.25), 1.4, 0.75, linewidth=1.4,
                  edgecolor="#2C3E50", facecolor="#FDEBD0")
ax.add_patch(boton)
ax.text(1.55, 3.62, "Push button", ha="center", fontsize=8.8)

# cable GPIO 4 -> boton
ax.plot([2.25, 2.9, 2.9, 3.6], [3.85, 3.85, 3.6, 3.6], color="#C0392B", linewidth=1.8)
ax.text(2.9, 4.0, "señal", fontsize=7.5, ha="center", color="#C0392B")

# cable boton -> GND
ax.plot([2.25, 2.6, 2.6, 3.6], [3.4, 3.4, 3.0, 3.0], color="#2C3E50", linewidth=1.8)
ax.text(2.55, 2.82, "GND", fontsize=7.5, ha="center", color="#2C3E50")

ax.text(1.55, 2.5,
        "Se usa la resistencia\npull-up interna del ESP32,\npor eso no se requiere\nresistencia externa.",
        fontsize=7.8, ha="center", color="#5D6D7E")

# --- Salida: LED ---
ax.text(9.3, 4.35, "Actuador", fontsize=10, weight="bold", ha="center")
led = Rectangle((8.6, 3.25), 1.4, 0.75, linewidth=1.4,
                edgecolor="#2C3E50", facecolor="#F9E79F")
ax.add_patch(led)
ax.text(9.3, 3.62, "LED", ha="center", fontsize=8.8)

# cable GPIO 2 -> resistencia -> LED
ax.plot([7.2, 7.75], [3.6, 3.6], color="#C0392B", linewidth=1.8)
res = Rectangle((7.75, 3.48), 0.5, 0.24, linewidth=1.2,
                edgecolor="#2C3E50", facecolor="#F5EEF8")
ax.add_patch(res)
ax.text(8.0, 3.87, "220 Ω", fontsize=7.5, ha="center")
ax.plot([8.25, 8.6], [3.6, 3.6], color="#C0392B", linewidth=1.8)

# cable LED -> GND
ax.plot([8.6, 8.3, 8.3, 7.2], [3.35, 3.35, 3.0, 3.0], color="#2C3E50", linewidth=1.8)
ax.text(8.35, 2.82, "GND", fontsize=7.5, ha="center", color="#2C3E50")

ax.text(9.3, 2.5,
        "El LED sustituye a la sirena\nen la prueba de concepto.\nLa sirena de 12 V requiere\nrelevador y fuente aparte.",
        fontsize=7.8, ha="center", color="#5D6D7E")

# --- Nota de alimentacion ---
ax.text(5.4, 0.9,
        "Nota: el push button es un contacto seco igual que el sensor reed magnético definitivo,\n"
        "por lo que el cableado y el firmware no cambian al sustituirlo.",
        fontsize=8.4, ha="center", color="#5D6D7E", style="italic")

plt.tight_layout()
plt.savefig(f"{SALIDA}/diagrama_conexion.png", dpi=170)
plt.close()
print("conexion ok")
