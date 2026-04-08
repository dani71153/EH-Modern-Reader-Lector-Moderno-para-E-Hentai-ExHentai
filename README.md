# EH Modern Reader (Traducción al Español)

Este repositorio es una **traducción al español** del proyecto original  
[EH-Modern-Reader](https://github.com/MeiYongAI/EH-Modern-Reader).

---

![Versión](https://img.shields.io/badge/version-2.5.1-blue)
![Licencia](https://img.shields.io/badge/license-MIT-green)
![Plataforma](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20(Chromium)-brightgreen)

## 📌 Descripción

**EH Modern Reader** es una extensión moderna para **E-Hentai / ExHentai / nhentai / hitomi.la**, que mejora la experiencia de lectura con:

- **Doble modo de lectura**: MPV y Galería.  
- **Tres estilos de lectura**: página única, horizontal continuo y vertical continuo.  
- **Memoria de progreso**: guarda tu posición en cada galería incluso tras reiniciar el navegador.  
- **Navegación rápida**: barra de miniaturas con salto directo a cualquier página.  
- **Caché persistente**: URLs de imágenes y miniaturas se guardan para evitar recargas innecesarias.  
- **Seguridad y control de velocidad**: evita bloqueos por exceso de peticiones.  

---

## 🆕 NUEVO

- **Sistema de marcadores**: guarda tus galerías favoritas y accede a ellas fácilmente.  
- **Descarga en ZIP**: permite descargar galerías completas en un archivo comprimido.  

---

## 🚀 Instalación

### Extensión para navegador (Chrome/Edge)

1. Descarga el archivo ZIP desde la sección **Releases**.  
2. Abre `chrome://extensions/` o `edge://extensions/`.  
3. Activa el **modo desarrollador**.  
4. Opción A: arrastra el ZIP directamente (sin descomprimir).  
5. Opción B: descomprime y selecciona **“Cargar extensión descomprimida”** → elige la carpeta.

Más detalles en `docs/INSTALL.md`.

---

## 🎮 Uso

- **MPV**: se activa automáticamente al entrar en `/mpv/`.  
- **Galería**: botón lateral en `/g/` para abrir todas las páginas en modo lector.  
- **nhentai**: botón en `/g/{id}/` o clic en miniaturas para abrir el lector.  
- **hitomi.la**: botón en páginas de detalle o lector para iniciar la extensión.  
- **Marcadores**: guarda galerías en tu lista personal y accede desde el panel de marcadores.  
- **Descarga ZIP**: botón en la interfaz para descargar la galería completa en un archivo comprimido.  

---

## ⌨️ Atajos de teclado

- ← / → o A / D / Espacio: pasar página / desplazamiento horizontal.  
- Home / End: ir al inicio o al final.  
- H / S: cambiar modo de lectura.  
- P: reproducción automática.  
- F11: pantalla completa.  
- Esc: cerrar panel o salir.  

---

## 📂 Estructura del proyecto

EH-Modern-Reader/
├─ manifest.json
├─ content.js        # Lector MPV
├─ gallery.js        # Modo galería
├─ nhentai.js        # Integración nhentai
├─ hitomi.js         # Integración hitomi.la
├─ style/            # Estilos
├─ icons/            # Iconos
├─ scripts/          # Scripts de construcción/publicación
├─ README.md / CHANGELOG.md / LICENSE
└─ dist/             # Archivos empaquetados

---

## 📜 Licencia y aviso

- Licencia: **MIT License**  
- Aviso: este proyecto es solo para fines de **aprendizaje e investigación**. Respeta las leyes locales y las reglas de cada sitio.

---

✨ Si esta traducción te resulta útil, no olvides dejar un **Star ⭐** en el repositorio.
