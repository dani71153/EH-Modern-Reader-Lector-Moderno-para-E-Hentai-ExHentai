/**
 * Content Script - Script de contenido
 * Inyectar lector personalizado al cargar la página E-Hentai MPV
 */

(function() {
  'use strict';

  // Evitar inyección duplicada
  if (window.ehModernReaderInjected) {
    return;
  }
  window.ehModernReaderInjected = true;

  // 🎯 Interruptor de registro de depuración (leído desde chrome.storage.local, desactivado por defecto)
  let debugModeEnabled = false;
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['eh_debug_mode'], (result) => {
        debugModeEnabled = result.eh_debug_mode === true;
      });
    }
  } catch {}
  
  // Función de registro de depuración (solo se muestra cuando el modo de depuración está activo)
  function debugLog(...args) {
    if (debugModeEnabled) {
      console.log(...args);
    }
  }

  // Bloquear excepciones del script MPV del sitio original (p.ej. ehg_mpv.c.js accede a nodos eliminados tras nuestra toma de control)
  // Optimización: registrar lo antes posible para estar antes que el script del sitio
  try {
    const swallowErr = (ev) => {
      try {
        const src = ev && (ev.filename || (ev.error && ev.error.fileName) || '');
        const msg = (ev && (ev.message || (ev.reason && ev.reason.message))) || '';
        const stack = ev && ev.error && ev.error.stack || '';
        
        // Coincide con errores relacionados con ehg_mpv o errores de offsetTop
        if ((src && /ehg_mpv/i.test(src)) || 
            /ehg_mpv/i.test(String(msg)) || 
            /offsetTop|preload_generic|preload_scroll_images|load_image/.test(msg) ||
            /ehg_mpv\.c\.js/.test(stack)) {
          // Evitar propagación de errores en consola
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
          // Silenciar, no emitir ningún registro
          return true;
        }
      } catch {}
      return false;
    };
    
    // Capturar en fase capture, máxima prioridad
    window.addEventListener('error', swallowErr, { capture: true, passive: false });
    window.addEventListener('unhandledrejection', swallowErr, { capture: true, passive: false });
    
    // Adicional: sobreescribir window.onerror para maximizar interceptación
    const oldOnError = window.onerror;
    window.onerror = function(message, source, lineno, colno, error) {
      const msgStr = String(message);
      const srcStr = String(source || '');
      const stackStr = error && error.stack || '';
      
      if (/ehg_mpv|offsetTop|preload_generic|preload_scroll_images/.test(msgStr) || 
          /ehg_mpv/.test(srcStr) ||
          /ehg_mpv\.c\.js/.test(stackStr)) {
        return true; // Suprimir, no mostrar en consola
      }
      if (typeof oldOnError === 'function') {
        return oldOnError.apply(this, arguments);
      }
    };
    
    // Envolver console.error para filtrar errores específicos
    const origConsoleError = console.error;
    console.error = function(...args) {
      try {
        const joined = args.map(a => {
          if (typeof a === 'string') return a;
          if (a && a.message) return a.message;
          if (a && a.stack) return a.stack;
          return String(a);
        }).join(' ');
        
        if (/ehg_mpv|offsetTop|preload_generic|preload_scroll_images/.test(joined)) {
          return; // Silenciar, no mostrar en consola
        }
      } catch {}
      return origConsoleError.apply(console, args);
    };
  } catch (e) {
    console.warn('[EH Modern Reader] Error al inicializar el interceptor de errores:', e);
  }
  
  // Usar MutationObserver para eliminar activamente scripts ehg_mpv insertados dinámicamente
  // Optimización: solo escuchar nodos hijos directos de <head> y <body>, sin subtree: true (reduce frecuencia de activación)
  let scriptBlockObserver = null;
  const startScriptBlocker = () => {
      if (scriptBlockObserver) return; // Ya iniciado, no repetir
      scriptBlockObserver = new MutationObserver(mutations => {
        try {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.tagName === 'SCRIPT') {
                const src = node.getAttribute('src') || '';
                if (/ehg_mpv|mpv/.test(src)) {
                  node.type = 'javascript/blocked';
                  node.remove();
                } else if (!src && /mpvkey|preload_scroll_images|load_image/.test(node.textContent || '')) {
                  node.remove();
                }
              }
            }
          }
        } catch {}
      });
      try {
        // Solo escuchar nodos hijos directos de <head> y <body>, sin recursión en todo el DOM
        const head = document.head;
        const body = document.body;
        if (head) scriptBlockObserver.observe(head, { childList: true });
        if (body) scriptBlockObserver.observe(body, { childList: true });
      } catch {}
    };
    // Iniciar bloqueo de scripts con retraso para evitar interferencia durante inicialización
    setTimeout(startScriptBlocker, 100);

  // Extraer datos de página (variables de script de página MPV + respaldo DOM)
  function extractPageData() {
    const pageData = {
      title: document.title || 'Galería desconocida',
      pagecount: 0,
      imagelist: [],
      imageSizes: [], // Dimensiones de imágenes extraídas del DOM original [{width, height, ratio}]
      gid: '',
      mpvkey: '',
      gallery_url: ''
    };
    try {
      const scripts = Array.from(document.scripts).map(s => s.textContent || '');
      const all = scripts.join('\n');
      const mgid = all.match(/var\s+gid\s*=\s*(\d+)/);
      if (mgid) pageData.gid = mgid[1];
      const mkey = all.match(/var\s+mpvkey\s*=\s*['"]([^'"\n]+)['"]/);
      if (mkey) pageData.mpvkey = mkey[1];
      const mcount = all.match(/var\s+pagecount\s*=\s*(\d+)/);
      if (mcount) pageData.pagecount = parseInt(mcount[1], 10);
      const mtitle = all.match(/var\s+mpvtitle\s*=\s*['"]([^'"\n]+)['"]/);
      if (mtitle) pageData.title = mtitle[1];
      const mlist = all.match(/var\s+imagelist\s*=\s*(\[[\s\S]*?\]);/);
      if (mlist) {
        try { pageData.imagelist = JSON.parse(mlist[1]); } catch {}
      }
    } catch {}
    
    // 🎯 Clave: extraer dimensiones de imágenes de los elementos .mimg del DOM original (la página MPV ya incluye dimensiones reales)
    try {
      const mimgs = document.querySelectorAll('#pane_images .mimg, .mimg');
      mimgs.forEach((mimg, i) => {
        const style = mimg.style || {};
        const maxWidth = parseInt(style.maxWidth) || 0;
        const height = parseInt(style.height) || 0;
        if (maxWidth > 0 && height > 0) {
          // Restar la altura de mbar (aprox. 24px)
          const actualHeight = Math.max(1, height - 24);
          const ratio = maxWidth / actualHeight;
          pageData.imageSizes[i] = { width: maxWidth, height: actualHeight, ratio: ratio };
        }
      });
      if (pageData.imageSizes.length > 0) {
        console.log('[EH Modern Reader] Extraído del DOM original', pageData.imageSizes.length, 'dimensiones de imágenes');
      }
    } catch (e) {
      console.warn('[EH Modern Reader] Error al extraer dimensiones de imágenes:', e);
    }
    
    // gallery_url respaldo: enlace DOM o referrer
    try {
      const a = document.querySelector('a[href^="/g/"], a[href*="/g/"]');
      if (a) pageData.gallery_url = new URL(a.getAttribute('href'), location.origin).href;
    } catch {}
    if (!pageData.gallery_url && document.referrer && /\/g\/\d+\//.test(document.referrer)) {
      try { pageData.gallery_url = new URL(document.referrer).href; } catch {}
    }
    if (!pageData.pagecount) pageData.pagecount = pageData.imagelist.length || 0;
    if (!pageData.title) pageData.title = 'Galería desconocida';
    return pageData;
  }

  /**
   * Reemplazar el contenido original de la página
   */
  function injectModernReader(pageData) {
    // Bloquear la ejecución del script original - método más completo
    try {
      // Eliminar todos los scripts originales
      document.querySelectorAll('script[src*="ehg_mpv"], link[href*="ehg_mpv"]').forEach(s => s.remove());
      // Eliminar además nodos de scripts en línea con palabras clave mpv (con el mejor esfuerzo)
      document.querySelectorAll('script:not([src])').forEach(s => {
        try {
          const t = s.textContent || '';
          if (/mpvkey|preload_scroll_images|load_image/.test(t)) s.remove();
        } catch {}
      });
      
      // Detener la carga de la página
      window.stop();
    } catch (e) {
      console.warn('[EH Modern Reader] Error al bloquear script original:', e);
    }
    
    // Desactivar variables globales del script original (antes de vaciar el DOM, para evitar errores)
    try {
      window.preload_generic = function() {};
      window.preload_scroll_images = function() {};
      window.load_image = function() {};
    } catch (e) {
      // Ignorar errores
    }
    
    // Crear nueva estructura del lector (basado en JHentai, miniaturas en la parte inferior)
    const readerHTML = `
      <div id="eh-reader-container">
        <!-- Barra de herramientas superior -->
        <header id="eh-header">
          <div class="eh-header-left">
            <button id="eh-close-btn" class="eh-icon-btn" title="Volver a la galería">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
            <h1 id="eh-title">${pageData.title || 'Cargando...'}</h1>
          </div>
          <div class="eh-header-center">
            <span id="eh-page-info" title="Atajos de teclado: ← → Cambiar página | + - Zoom | 0 Restablecer | Espacio Página siguiente">1 / ${pageData.pagecount}</span>
          </div>
          <div class="eh-header-right">
            <button id="eh-reverse-btn" class="eh-icon-btn" title="Lectura inversa (cambiar dirección izquierda/derecha)">
              <span style="font-size: 20px; font-weight: bold;">⇄</span>
            </button>
            
            <button id="eh-auto-btn" class="eh-icon-btn" title="Avance de página programado (clic para activar/desactivar, Alt+clic para configurar intervalo)">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 7v5l3 3"/>
              </svg>
            </button>
            <button id="eh-fullscreen-btn" class="eh-icon-btn" title="Pantalla completa (F11)">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>
            </button>
            <button id="eh-theme-btn" class="eh-icon-btn" title="Cambiar tema">
              <!-- Mostrar luna en modo oscuro inicial, sol en modo claro -->
              <svg id="eh-theme-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            </button>
            <button id="eh-settings-btn" class="eh-icon-btn" title="Configuración de lectura">
              <!-- Ícono de configuración estilo Feather (trazo limpio, uniforme con otros íconos) -->
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l0 0a2 2 0 1 1-2.83 2.83l0 0a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l0 0a2 2 0 1 1-2.83-2.83l0 0a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09c.67 0 1.28-.39 1.51-1 .23-.6.1-1.26-.33-1.82l0 0a2 2 0 1 1 2.83-2.83l0 0c.56.43 1.22.56 1.82.33.61-.23 1-.84 1-1.51V3a2 2 0 0 1 4 0v.09c0 .67.39 1.28 1 1.51.6.23 1.26.1 1.82-.33l0 0a2 2 0 1 1 2.83 2.83l0 0c-.43.56-.56 1.22-.33 1.82.23.61.84 1 1.51 1H21a2 2 0 0 1 0 4h-.09c-.67 0-1.28.39-1.51 1Z"></path>
              </svg>
            </button>
          </div>
        </header>

        <!-- Área de contenido principal: visualización de imágenes -->
        <main id="eh-main">
          <section id="eh-viewer">
            <!-- Contenedor de carril deslizante tipo perlas (modo página única con arrastre) -->
            <div id="eh-page-slider" class="eh-page-slider">
              <div id="eh-page-track" class="eh-page-track">
                <!-- Página anterior -->
                <div class="eh-page-slide eh-slide-prev" data-slide="prev">
                  <img class="eh-slide-image" alt="Página anterior" />
                </div>
                <!-- Página actual -->
                <div class="eh-page-slide eh-slide-current" data-slide="current">
                  <!-- Capa de superposición de progreso de carga de imágenes -->
                  <div id="eh-image-loading-overlay" class="eh-image-loading-overlay" style="display: none;">
                    <div class="eh-circular-progress">
                      <svg width="80" height="80" viewBox="0 0 80 80">
                        <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="8"/>
                        <circle id="eh-progress-ring" cx="40" cy="40" r="32" fill="none" 
                                stroke="#FF6B9D" stroke-width="8" 
                                stroke-linecap="round"
                                stroke-dasharray="201.06 201.06"
                                stroke-dashoffset="201.06"
                                transform="rotate(-90 40 40)"
                                style="transition: stroke-dashoffset 0.15s ease"/>
                      </svg>
                    </div>
                    <div class="eh-loading-hint">Loading</div>
                    <div id="eh-loading-page-number" class="eh-loading-page-number">Page 1</div>
                  </div>
                  <img id="eh-current-image" class="eh-slide-image" alt="Página actual" />
                </div>
                <!-- Página siguiente -->
                <div class="eh-page-slide eh-slide-next" data-slide="next">
                  <img class="eh-slide-image" alt="Página siguiente" />
                </div>
              </div>
            </div>

            <!-- Botones de cambio de página -->
            <button id="eh-prev-btn" class="eh-nav-btn eh-nav-prev" title="Página anterior (←)">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 18l-6-6 6-6"/>
              </svg>
            </button>
            <button id="eh-next-btn" class="eh-nav-btn eh-nav-next" title="Página siguiente (→)">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>
          </section>
        </main>

        <!-- Menú inferior (miniaturas + barra de progreso + botones de acceso rápido) -->
        <footer id="eh-bottom-menu" class="eh-bottom-menu">
          <!-- Área de desplazamiento horizontal de miniaturas -->
          <div id="eh-thumbnails-container" class="eh-thumbnails-container">
            <div id="eh-thumbnails" class="eh-thumbnails-horizontal"></div>
          </div>

          <!-- Área de barra de progreso -->
          <div class="eh-slider-container">
            <span id="eh-progress-current" class="eh-progress-number">1</span>
            <div class="eh-slider-track" id="eh-slider-track">
              <div class="eh-slider-fill" id="eh-slider-fill"></div>
              <input 
                type="range" 
                id="eh-progress-bar" 
                min="1" 
                max="${pageData.pagecount}" 
                value="1" 
                class="eh-progress-slider"
              />
            </div>
            <span id="eh-progress-total" class="eh-progress-number">${pageData.pagecount}</span>
          </div>
        </footer>

        <!-- Panel de configuración -->
        <div id="eh-settings-panel" class="eh-panel eh-hidden">
          <div class="eh-panel-content">
            <div class="eh-panel-header">
              <h3>Configuración de lectura</h3>
              <button id="eh-settings-close" class="eh-panel-close" title="Cerrar configuración">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            
            <!-- Configuración de diseño -->
            <div class="eh-setting-group">
              <div class="eh-setting-label-group">Modo de diseño</div>
              <div class="eh-setting-item">
                <div class="eh-radio-group">
                  <label class="eh-radio-label">
                    <input type="radio" name="eh-read-mode-radio" value="single" checked>
                    <span>Página única horizontal</span>
                  </label>
                  <label class="eh-radio-label">
                    <input type="radio" name="eh-read-mode-radio" value="single-vertical">
                    <span>Página única vertical</span>
                  </label>
                  <label class="eh-radio-label">
                    <input type="radio" name="eh-read-mode-radio" value="continuous-horizontal">
                    <span>Continuo horizontal</span>
                  </label>
                  <label class="eh-radio-label">
                    <input type="radio" name="eh-read-mode-radio" value="continuous-vertical">
                    <span>Continuo vertical</span>
                  </label>
                </div>
              </div>
            </div>
            
            <!-- Configuración exclusiva del modo continuo -->
            <div class="eh-setting-group" id="eh-vertical-settings">
              <div class="eh-setting-label-group">Exclusivo modo continuo</div>
              <div class="eh-setting-item">
                <label for="eh-vertical-padding">Margen lateral modo vertical</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-vertical-padding" min="0" max="1000" step="4" value="0" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-vertical-padding-value">0</span> px</span>
                </div>
              </div>
              <div class="eh-setting-item">
                <label for="eh-horizontal-gap">Espaciado imágenes horizontal continuo</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-horizontal-gap" min="0" max="100" step="2" value="0" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-horizontal-gap-value">0</span> px</span>
                </div>
              </div>
              <div class="eh-setting-item">
                <label for="eh-vertical-gap">Espaciado imágenes vertical continuo</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-vertical-gap" min="0" max="100" step="2" value="0" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-vertical-gap-value">0</span> px</span>
                </div>
              </div>
            </div>
            
            <!-- Configuración de rendimiento -->
            <div class="eh-setting-group">
              <div class="eh-setting-label-group">Optimización de rendimiento</div>
              <div class="eh-setting-item">
                <label for="eh-preload-count">Páginas de precarga</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-preload-count" min="0" max="10" step="1" value="2" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-preload-count-value">2</span> página(s)</span>
                </div>
              </div>
            </div>

            <!-- Configuración de avance automático de página -->
            <div class="eh-setting-group">
              <div class="eh-setting-label-group">Avance automático de página</div>
              <div class="eh-setting-item">
                <label for="eh-auto-interval">Intervalo de cambio de página</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-auto-interval" min="1" max="60" step="0.5" value="3" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-auto-interval-value">3.0</span> segundo(s)</span>
                </div>
              </div>
              <div class="eh-setting-item">
                <label for="eh-scroll-speed">Velocidad de desplazamiento automático</label>
                <div class="eh-slider-wrapper">
                  <input type="range" id="eh-scroll-speed" min="0.1" max="5" step="0.1" value="0.5" class="eh-slider">
                  <span class="eh-slider-value"><span id="eh-scroll-speed-value">0.5</span> px/fotograma(s)</span>
                </div>
              </div>
            </div>
            
            <!-- Restaurar configuración predeterminada -->
            <div class="eh-setting-group" style="border-bottom: none; padding-bottom: 0; margin-bottom: 0;">
              <button id="eh-reset-settings" class="eh-reset-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                  <path d="M21 3v5h-5"/>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                  <path d="M3 21v-5h5"/>
                </svg>
                Restaurar configuración predeterminada
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Optimizar reconstrucción del DOM: vaciar primero e insertar después, para evitar que el navegador procese scripts del sitio original
    // Usar requestAnimationFrame para diferir el vaciado y que el navegador renderice el indicador de carga primero
    requestAnimationFrame(() => {
      // Vaciar el contenido original de la página (manteniendo el elemento body)
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }
      document.body.className = 'eh-modern-reader';
      
      // Usar insertAdjacentHTML en lugar de innerHTML para mejor rendimiento
      document.body.insertAdjacentHTML('beforeend', readerHTML);
      
      // Iniciar carga de CSS inmediatamente
      loadReaderCSS();
    });
    
    function loadReaderCSS() {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('style/reader.css');
      document.head.appendChild(link);

      // Esperar a que se cargue el CSS antes de inicializar el lector
      const onCSSLoad = () => {
        console.log('[EH Modern Reader] Carga completada del CSS');
        initializeReader(pageData);
      };
      
      link.onload = onCSSLoad;
      // Si falla la carga del CSS, inicializar de todas formas
      link.onerror = () => {
        console.warn('[EH Modern Reader] Error de carga del CSS, usando estilos predeterminados');
        onCSSLoad();
      };
    }
  }

  /**
   * Inicializar funcionalidad del lector
   */
  function initializeReader(pageData) {
    if (window.__EH_READER_INIT) {
      console.warn('[EH Modern Reader] Ya inicializado, omitiendo ejecución duplicada');
      return;
    }
    window.__EH_READER_INIT = true;
    console.log('[EH Modern Reader] Inicializando lector');
    console.log('[EH Modern Reader] Número de páginas:', pageData.pagecount);
    console.log('[EH Modern Reader] Longitud de la lista de imágenes:', pageData.imagelist?.length);
    console.log('[EH Modern Reader] Ejemplo de datos de la primera imagen:', pageData.imagelist?.[0]);
    console.log('[EH Modern Reader] GID:', pageData.gid);

    // Verificar datos necesarios
    if (!pageData.imagelist || pageData.imagelist.length === 0) {
      console.error('[EH Modern Reader] Lista de imágenes vacía');
      alert('Error: No se puede cargar la lista de imágenes');
      return;
    }

    if (!pageData.pagecount || pageData.pagecount === 0) {
      console.error('[EH Modern Reader] El número de páginas es 0');
      return;
    }

    // Estado del lector
    const galleryId = pageData.gid || window.location.pathname.split('/')[2];
    // Configuración predeterminada
    const DEFAULT_SETTINGS = {
      prefetchAhead: 2,
      autoIntervalMs: 3000,
      scrollSpeed: 0.5,
      verticalSidePadding: 0, // Modo vertical por defecto sin margen, se puede agregar con el deslizador
      horizontalGap: 0, // Espaciado de imágenes en modo horizontal continuo
      verticalGap: 0, // Espaciado de imágenes en modo vertical continuo
      readMode: 'single',
      reverse: false
    };
    
    // Cargar configuración desde localStorage
    function loadSettings() {
      try {
        const saved = localStorage.getItem('eh_reader_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          return {
            prefetchAhead: parsed.prefetchAhead ?? DEFAULT_SETTINGS.prefetchAhead,
            autoIntervalMs: parsed.autoIntervalMs ?? DEFAULT_SETTINGS.autoIntervalMs,
            scrollSpeed: parsed.scrollSpeed ?? DEFAULT_SETTINGS.scrollSpeed,
            verticalSidePadding: parsed.verticalSidePadding ?? DEFAULT_SETTINGS.verticalSidePadding,
            horizontalGap: parsed.horizontalGap ?? DEFAULT_SETTINGS.horizontalGap,
            verticalGap: parsed.verticalGap ?? DEFAULT_SETTINGS.verticalGap,
            readMode: parsed.readMode ?? DEFAULT_SETTINGS.readMode,
            reverse: parsed.reverse ?? DEFAULT_SETTINGS.reverse
          };
        }
      } catch (e) {
        console.warn('[EH Modern Reader] Error al cargar configuración:', e);
      }
      return { ...DEFAULT_SETTINGS };
    }
    
    // Guardar configuración en localStorage
    function saveSettings() {
      try {
        const settings = {
          prefetchAhead: state.settings.prefetchAhead,
          autoIntervalMs: state.autoPage.intervalMs,
          scrollSpeed: state.autoPage.scrollSpeed,
          verticalSidePadding: state.settings.verticalSidePadding,
          horizontalGap: state.settings.horizontalGap,
          verticalGap: state.settings.verticalGap,
          readMode: state.settings.readMode,
          reverse: state.settings.reverse
        };
        localStorage.setItem('eh_reader_settings', JSON.stringify(settings));
      } catch (e) {
        console.warn('[EH Modern Reader] Error al guardar configuración:', e);
      }
    }

    // Cargar configuración desde localStorage y aplicar
    const savedSettings = loadSettings();
    
    const state = {
      currentPage: 1,
      pageCount: pageData.pagecount,
      imagelist: pageData.imagelist,
      imageSizes: pageData.imageSizes || [], // Dimensiones de imágenes extraídas del DOM original
      galleryId: galleryId,
      imageCache: new Map(),
      imageRequests: new Map(),
      thumbnailObserver: null,
    draggingProgress: false,
      settings: {
        menuVisible: false,
        darkMode: true,
        imageScale: 1,
        imageOffsetX: 0,
        imageOffsetY: 0,
        readMode: savedSettings.readMode,
        prefetchAhead: savedSettings.prefetchAhead,
            reverse: savedSettings.reverse,
            verticalSidePadding: savedSettings.verticalSidePadding,
            horizontalGap: savedSettings.horizontalGap,
            verticalGap: savedSettings.verticalGap
      },
      autoPage: {
        running: false,
        intervalMs: savedSettings.autoIntervalMs,
        timer: null,
        scrollSpeed: savedSettings.scrollSpeed
      }
    };
    // Caché de proporciones: pageIndex -> ratio (parseado desde URL real o imágenes cargadas)
    const ratioCache = new Map();

    // Precargar proporciones de todas las imágenes (evitar saltos de diseño al cargar)
    // 🎯 Priorizar dimensiones extraídas del DOM original (síncronas, disponibles inmediatamente, sin necesidad de cargar imágenes)
    // Luego usar caché de localStorage, finalmente carga asíncrona de imágenes como último recurso
    async function preloadImageRatios() {
      const cacheKey = `eh_image_ratios_${state.gid}`;
      let ratios = {};
      let needsFetch = false;
      
      // 1️⃣ Priorizar dimensiones extraídas del DOM original (más rápido, sin solicitudes de red)
      if (state.imageSizes && state.imageSizes.length > 0) {
        state.imageSizes.forEach((size, i) => {
          if (size && size.ratio) {
            const clampedRatio = Math.max(0.02, Math.min(5, size.ratio));
            ratios[i] = clampedRatio;
            ratioCache.set(i, clampedRatio);
          }
        });
        console.log('[EH Modern Reader] Extraído del DOM original', Object.keys(ratios).length, 'proporciones de imágenes (sin saltos)');
        
        // Si las dimensiones del DOM cubren todas las imágenes, guardar y retornar directamente
        if (Object.keys(ratios).length >= state.pageCount) {
          try {
            localStorage.setItem(cacheKey, JSON.stringify(ratios));
          } catch {}
          return;
        }
        // De lo contrario, marcar que se necesita obtener datos adicionales
        needsFetch = true;
      }
      
      // 2️⃣ Verificar caché de localStorage como segunda opción
      const cachedData = localStorage.getItem(cacheKey);
      if (cachedData && !needsFetch) {
        try {
          const cached = JSON.parse(cachedData);
          Object.entries(cached).forEach(([idx, ratio]) => {
            if (!ratios[idx]) {
              ratios[idx] = ratio;
              ratioCache.set(parseInt(idx), ratio);
            }
          });
          console.log('[EH Modern Reader] Restaurado desde caché local', Object.keys(ratios).length, 'proporciones de imágenes');
          if (Object.keys(ratios).length >= state.pageCount) {
            return;
          }
        } catch (e) {
          console.warn('[EH Modern Reader] Error al analizar caché:', e);
        }
      }
      
      // 3️⃣ Si aún faltan datos, cargar imágenes asíncronamente (más lento, pero como respaldo)
      // Solo obtener los índices faltantes
      const missingIndices = [];
      for (let i = 0; i < state.pageCount; i++) {
        if (!ratios[i]) {
          missingIndices.push(i);
        }
      }
      
      if (missingIndices.length === 0) {
        // Guardar en localStorage
        try {
          localStorage.setItem(cacheKey, JSON.stringify(ratios));
        } catch {}
        return;
      }

      console.log('[EH Modern Reader] Necesita obtener de forma asíncrona', missingIndices.length, 'proporciones de imágenes');
      
      // Obtención por lotes concurrentes (máximo 3 por lote, para evitar límites de velocidad)
      const batchSize = 3;
      for (let batch = 0; batch < Math.ceil(missingIndices.length / batchSize); batch++) {
        const start = batch * batchSize;
        const end = Math.min(start + batchSize, missingIndices.length);
        const promises = [];
        
        for (let j = start; j < end; j++) {
          const i = missingIndices[j];
          const promise = (async () => {
            try {
              const imageData = state.imagelist[i];
              if (!imageData) return;
              
              // Intentar obtener desde URL de miniatura (si existe campo t)
              let url = null;
              if (typeof imageData === 'object' && imageData.t) {
                url = imageData.t; // URL de miniatura
              }
              if (!url) return;
              
              const img = new Image();
              img.crossOrigin = 'anonymous';
              
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
                img.onload = () => {
                  clearTimeout(timeout);
                  const w = img.naturalWidth;
                  const h = img.naturalHeight;
                  if (w && h) {
                    const ratio = w / h;
                    const clampedRatio = Math.max(0.02, Math.min(5, ratio));
                    ratios[i] = clampedRatio;
                    ratioCache.set(i, clampedRatio);
                  }
                  resolve();
                };
                img.onerror = () => {
                  clearTimeout(timeout);
                  reject(new Error('Image load failed'));
                };
                img.src = url;
              });
            } catch (e) {
              // El fallo de una imagen no afecta a las demás
            }
          })();
          promises.push(promise);
        }
        
        await Promise.allSettled(promises);
        
        if (batch < Math.ceil(missingIndices.length / batchSize) - 1) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      
      // Guardar en localStorage
      try {
        localStorage.setItem(cacheKey, JSON.stringify(ratios));
        console.log('[EH Modern Reader] Precarga completa, total', Object.keys(ratios).length, 'proporciones de imágenes');
      } catch (e) {
        console.warn('[EH Modern Reader] Error al guardar caché de proporciones:', e);
      }
    }

    // Leer/guardar progreso
    function loadProgress() { return 1; }
    // 🎯 Memoria de lectura en modo continuo: activar almacenamiento permanente a través de saveProgress
    let _persistTimer = null;
    function saveProgress(page) {
      if (_persistTimer) clearTimeout(_persistTimer);
      _persistTimer = setTimeout(() => {
        if (typeof _saveLastPagePermanent === 'function') {
          _saveLastPagePermanent(page);
        }
      }, 400);
    }

    // Obtener elementos DOM (con verificación de null)
      const elements = {
      currentImage: document.getElementById('eh-current-image'),
  // loading: Animación de carga antigua eliminada
      pageInfo: document.getElementById('eh-page-info'),
      progressBar: document.getElementById('eh-progress-bar'),
      sliderTrack: document.getElementById('eh-slider-track'),
      sliderFill: document.getElementById('eh-slider-fill'),
      thumbnails: document.getElementById('eh-thumbnails'),
      bottomMenu: document.getElementById('eh-bottom-menu'),
      viewer: document.getElementById('eh-viewer'),
      prevBtn: document.getElementById('eh-prev-btn'),
      nextBtn: document.getElementById('eh-next-btn'),
      closeBtn: document.getElementById('eh-close-btn'),
      themeBtn: document.getElementById('eh-theme-btn'),
      fullscreenBtn: document.getElementById('eh-fullscreen-btn'),
    settingsBtn: document.getElementById('eh-settings-btn'),
  autoBtn: document.getElementById('eh-auto-btn'),
    // thumbnailsToggleBtn: Eliminado
      reverseBtn: document.getElementById('eh-reverse-btn'),
      settingsPanel: document.getElementById('eh-settings-panel'),
      settingsCloseBtn: document.getElementById('eh-settings-close'),
      resetSettingsBtn: document.getElementById('eh-reset-settings'),
      resetSettingsBtn: document.getElementById('eh-reset-settings'),
      
  readModeRadios: document.querySelectorAll('input[name="eh-read-mode-radio"]'),
  preloadCountInput: document.getElementById('eh-preload-count'),
  autoIntervalInput: document.getElementById('eh-auto-interval'),
  scrollSpeedInput: document.getElementById('eh-scroll-speed'),
  verticalPaddingInput: document.getElementById('eh-vertical-padding'),
  horizontalGapInput: document.getElementById('eh-horizontal-gap'),
  verticalGapInput: document.getElementById('eh-vertical-gap'),
      
      // Elementos de visualización de valores del deslizador
      preloadCountValue: document.getElementById('eh-preload-count-value'),
      autoIntervalValue: document.getElementById('eh-auto-interval-value'),
      scrollSpeedValue: document.getElementById('eh-scroll-speed-value'),
      verticalPaddingValue: document.getElementById('eh-vertical-padding-value'),
      horizontalGapValue: document.getElementById('eh-horizontal-gap-value'),
      verticalGapValue: document.getElementById('eh-vertical-gap-value'),
      
      // Elementos del indicador de progreso de carga de imágenes
      imageLoadingOverlay: document.getElementById('eh-image-loading-overlay'),
      progressRing: document.getElementById('eh-progress-ring'),
      progressText: document.getElementById('eh-progress-text'),
      loadingPageNumber: document.getElementById('eh-loading-page-number')
    };
    // Verificar elementos DOM necesarios
    const requiredElements = ['currentImage', 'viewer', 'thumbnails'];
    const missingElements = requiredElements.filter(key => !elements[key]);
    if (missingElements.length > 0) {
      throw new Error(`Faltan elementos DOM necesarios: ${missingElements.join(', ')}`);
    }

    // Ocultar botones de paginación circular antiguos, usar clic en zona izquierda/derecha
    try {
      if (elements.prevBtn) { elements.prevBtn.style.display = 'none'; elements.prevBtn.setAttribute('aria-hidden', 'true'); }
      if (elements.nextBtn) { elements.nextBtn.style.display = 'none'; elements.nextBtn.setAttribute('aria-hidden', 'true'); }
    } catch {}

    // Sincronizar botones de radio del modo de lectura de la UI con el estado
    if (elements.readModeRadios && elements.readModeRadios.length > 0) {
      try {
        elements.readModeRadios.forEach(radio => {
          if (radio.value === state.settings.readMode) radio.checked = true;
        });
      } catch {}
    }

    // Sincronizar el estado del botón de inversión
    function updateReverseBtn() {
      if (elements.reverseBtn) {
        if (state.settings.reverse) {
          elements.reverseBtn.classList.add('eh-active');
        } else {
          elements.reverseBtn.classList.remove('eh-active');
        }
      }
    }
    updateReverseBtn();

    // Sincronizar los campos de intervalo de avance automático y velocidad de desplazamiento con el estado
    if (elements.autoIntervalInput) {
      elements.autoIntervalInput.value = (state.autoPage.intervalMs || 3000) / 1000;
      if (elements.autoIntervalValue) {
        elements.autoIntervalValue.textContent = ((state.autoPage.intervalMs || 3000) / 1000).toFixed(1);
      }
    }
    if (elements.scrollSpeedInput) {
      elements.scrollSpeedInput.value = state.autoPage.scrollSpeed || 0.5;
      if (elements.scrollSpeedValue) {
        elements.scrollSpeedValue.textContent = (state.autoPage.scrollSpeed || 0.5).toFixed(1);
      }
    }
    if (elements.verticalPaddingInput) {
      elements.verticalPaddingInput.value = state.settings.verticalSidePadding ?? 0;
      if (elements.verticalPaddingValue) {
        elements.verticalPaddingValue.textContent = state.settings.verticalSidePadding ?? 0;
      }
    }
    if (elements.preloadCountInput) {
      elements.preloadCountInput.value = state.settings.prefetchAhead || 2;
      if (elements.preloadCountValue) {
        elements.preloadCountValue.textContent = state.settings.prefetchAhead || 2;
      }
    }
    if (elements.horizontalGapInput) {
      elements.horizontalGapInput.value = state.settings.horizontalGap ?? 0;
      if (elements.horizontalGapValue) {
        elements.horizontalGapValue.textContent = state.settings.horizontalGap ?? 0;
      }
    }
    if (elements.verticalGapInput) {
      elements.verticalGapInput.value = state.settings.verticalGap ?? 0;
      if (elements.verticalGapValue) {
        elements.verticalGapValue.textContent = state.settings.verticalGap ?? 0;
      }
    }

    // showLoading/hideLoading antiguos están obsoletos, se mantienen vacíos para evitar errores de referencia
    function showLoading() {}
    function hideLoading() {}

    // Mostrar mensaje de error y botón de reintento
    function showErrorMessage(pageNum, errorMsg) {
      hideLoading();
      
      // Si el contenedor de imagen existe, ocultarlo
      if (elements.currentImage) {
        elements.currentImage.style.display = 'none';
      }
      
      // Crear u obtener el contenedor de mensajes de error
      let errorContainer = document.getElementById('eh-reader-error-container');
      if (!errorContainer) {
        errorContainer = document.createElement('div');
        errorContainer.id = 'eh-reader-error-container';
        errorContainer.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: rgba(0, 0, 0, 0.9);
          color: #fff;
          padding: 30px;
          border-radius: 8px;
          text-align: center;
          z-index: 10001;
          max-width: 500px;
        `;
        document.body.appendChild(errorContainer);
      }
      
      // Establecer mensaje de error
      errorContainer.innerHTML = `
        <div style="font-size: 18px; margin-bottom: 10px;">⚠️ Error al cargar imagen</div>
        <div style="font-size: 14px; margin-bottom: 5px;">Página ${pageNum}</div>
        <div style="font-size: 12px; color: #aaa; margin-bottom: 20px;">${errorMsg}</div>
        <button id="eh-reader-retry-btn" style="
          background: #007bff;
          color: #fff;
          border: none;
          padding: 10px 30px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
          margin-right: 10px;
        ">Reintentar</button>
        <button id="eh-reader-close-error-btn" style="
          background: #6c757d;
          color: #fff;
          border: none;
          padding: 10px 30px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        ">Cerrar</button>
      `;
      
      errorContainer.style.display = 'block';
      
      // Vincular botón de reintento
      const retryBtn = document.getElementById('eh-reader-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = () => {
          errorContainer.style.display = 'none';
          // Limpiar caché y recargar
          state.imageCache.delete(pageNum - 1);
          scheduleShowPage(pageNum, { force: true });
        };
      }
      
      // Vincular botón de cierre
      const closeBtn = document.getElementById('eh-reader-close-error-btn');
      if (closeBtn) {
        closeBtn.onclick = () => {
          errorContainer.style.display = 'none';
        };
      }
    }

    // Ocultar mensaje de error
    function hideErrorMessage() {
      const errorContainer = document.getElementById('eh-reader-error-container');
      if (errorContainer) {
        errorContainer.style.display = 'none';
      }
    }

    // ==================== Indicador de progreso de carga de imágenes ====================

    // ID del temporizador de animación de ocultamiento del indicador de progreso
    let hideProgressTimer = null;
    
    // Mostrar capa de superposición de progreso de carga de imágenes
    function showImageLoadingProgress(pageNum) {
      if (!elements.imageLoadingOverlay) return;
      
      // Cancelar el temporizador de ocultamiento anterior (si existe)
      if (hideProgressTimer) {
        clearTimeout(hideProgressTimer);
        hideProgressTimer = null;
      }

      // Eliminar animación de desvanecimiento y mostrar inmediatamente
      elements.imageLoadingOverlay.classList.remove('eh-fade-out');
      elements.imageLoadingOverlay.style.display = 'flex';
      
      // Restablecer progreso a 0
      updateImageLoadingProgress(0);
      
      // Actualizar número de página
      if (elements.loadingPageNumber) {
        elements.loadingPageNumber.textContent = `Page ${pageNum}`;
      }
      
      debugLog('[EH Loading Progress] Mostrar indicador de progreso, página:', pageNum);
    }
    
    // Actualizar progreso de carga de imagen (0-1)
    function updateImageLoadingProgress(progress) {
      if (!elements.progressRing) return;
      
      // Asegurar que el progreso esté en el rango 0-1
      const clampedProgress = Math.max(0.01, Math.min(1, progress));
      const percentage = Math.round(clampedProgress * 100);
      
      // Cálculo de la circunferencia del anillo SVG: 2 * π * r = 2 * 3.1416 * 32 ≈ 201.06
      const circumference = 201.06;
      const offset = circumference * (1 - clampedProgress);
      
      // Actualizar stroke-dashoffset para controlar la visualización del progreso del anillo hueco
      elements.progressRing.style.strokeDashoffset = offset;
      
      // Opcional: actualizar elemento de texto de progreso si existe (eliminado en versión actual)
      if (elements.progressText) {
        elements.progressText.textContent = `${percentage}%`;
      }
    }
    
    // Ocultar capa de superposición de progreso de carga de imágenes
    function hideImageLoadingProgress() {
      if (!elements.imageLoadingOverlay) return;
      
      // Cancelar el temporizador de ocultamiento anterior (si existe)
      if (hideProgressTimer) {
        clearTimeout(hideProgressTimer);
        hideProgressTimer = null;
      }

      // Agregar animación de desvanecimiento
      elements.imageLoadingOverlay.classList.add('eh-fade-out');
      
      // Ocultar después de que termine la animación
      hideProgressTimer = setTimeout(() => {
        if (elements.imageLoadingOverlay) {
          elements.imageLoadingOverlay.style.display = 'none';
        }
        hideProgressTimer = null;
      }, 300);
      
      debugLog('[EH Loading Progress] Ocultar indicador de progreso');
    }


    // Obtener URL de imagen - E-Hentai MPV usa API para carga dinámica
    function getSiteOrigin() {
      try {
        if (pageData && pageData.gallery_url) {
          return new URL(pageData.gallery_url).origin;
        }
      } catch {}
      try { return location.origin; } catch {}
      return 'https://e-hentai.org';
    }
    function getImageUrl(pageIndex) {
      const imageData = state.imagelist[pageIndex];
      if (!imageData) return null;
      const base = getSiteOrigin();
      
      // Formato E-Hentai MPV: {n: 'filename', k: 'key', t: 'thumbnail'}
      // Necesitamos usar la API de E-Hentai para obtener la imagen completa
      if (typeof imageData === 'object' && imageData.k) {
        // Devolver URL de página de imagen, dejar que el navegador maneje la carga
        return `${base}/s/${imageData.k}/${pageData.gid}-${pageIndex + 1}`;
      }
      
      // Compatibilidad con otros formatos
      if (Array.isArray(imageData)) {
        if (typeof imageData[0] === 'string' && imageData[0].startsWith('http')) {
          return imageData[0];
        }
        const key = imageData[0];
        return `${base}/s/${key}/${pageData.gid}-${pageIndex + 1}`;
      }
      
      if (typeof imageData === 'object') {
        return imageData.url || imageData.src || imageData.u || imageData.s;
      }
      
      if (typeof imageData === 'string' && imageData.startsWith('http')) {
        return imageData;
      }
      
      console.error('[EH Modern Reader] No se puede analizar los datos de la imagen:', imageData);
      return null;
    }
    
    // Caché de URLs reales de imágenes y reutilización de solicitudes (con persistencia de sesión para mejorar velocidad en visitas repetidas)
    const realUrlCache = new Map(); // pageIndex -> url
    const realUrlRequests = new Map(); // pageIndex -> {promise, controller}
    const realUrlFallbackToken = new Map(); // pageIndex -> nl token (para cambiar de espejo en caso de fallo)
    const persistentCacheKey = () => {
      // Usar combinación gid + mpvkey para reducir falsos positivos; si falta, usar solo la ruta
      const gid = pageData.gid || 'nogid';
      const mpvkey = pageData.mpvkey || 'nokey';
      return `eh_mpv_realurl_${gid}_${mpvkey}`;
    };
    const REALURL_TTL = 24 * 60 * 60 * 1000; // 24h, puede considerarse caché de largo plazo hasta limpieza manual
    function preconnectToOrigin(sampleUrl) {
      try {
        const origin = new URL(sampleUrl).origin;
        if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
          const l = document.createElement('link');
          l.rel = 'preconnect';
          l.href = origin;
          l.crossOrigin = 'anonymous';
          document.head.appendChild(l);
          console.log('[EH Modern Reader] Preconectando al dominio de imágenes:', origin);
        }
      } catch {}
    }
    // Restaurar caché persistente (localStorage prioritario, sessionStorage como respaldo), con TTL
    try {
      let payload = null;
      const ls = localStorage.getItem(persistentCacheKey());
      if (ls) {
        try { payload = JSON.parse(ls); } catch {}
      } else {
        const ss = sessionStorage.getItem(persistentCacheKey());
        if (ss) { try { payload = { ts: Date.now(), arr: JSON.parse(ss) }; } catch {} }
      }
      if (payload && Array.isArray(payload.arr)) {
        if (!payload.ts || (Date.now() - payload.ts) < REALURL_TTL) {
          payload.arr.forEach((u, idx) => { if (typeof u === 'string' && u.startsWith('http')) realUrlCache.set(idx, u); });
          console.log('[EH Modern Reader] Número de URLs reales restauradas desde caché:', realUrlCache.size);
          for (let i = 0; i < payload.arr.length; i++) { const u = payload.arr[i]; if (typeof u === 'string' && u.startsWith('http')) { preconnectToOrigin(u); break; } }
        }
      }
    } catch (e) { console.warn('[EH Modern Reader] Error al restaurar caché de URLs reales de imágenes', e); }
    function persistRealUrlCacheLater() {
      // Throttle ligero: escritura en lotes, evitar escribir sessionStorage por cada imagen
      if (persistRealUrlCacheLater.timer) clearTimeout(persistRealUrlCacheLater.timer);
      persistRealUrlCacheLater.timer = setTimeout(() => {
        try {
          const maxSave = 1000; // Limitar cantidad guardada para reducir tamaño
          const arr = [];
          for (let i = 0; i < Math.min(state.pageCount, maxSave); i++) {
            arr[i] = realUrlCache.get(i) || null;
          }
          const payload = { ts: Date.now(), arr };
          try { localStorage.setItem(persistentCacheKey(), JSON.stringify(payload)); } catch {}
          // Compatibilidad con versiones antiguas: continuar escribiendo en sessionStorage (sin ts)
          try { sessionStorage.setItem(persistentCacheKey(), JSON.stringify(arr)); } catch {}
        } catch (e) { console.warn('[EH Modern Reader] Error al persistir caché de URLs reales de imágenes', e); }
      }, 400); // Agrupación de 400ms
    }

    async function ensureRealImageUrl(pageIndex) {
      if (realUrlCache.has(pageIndex)) {
        return { url: realUrlCache.get(pageIndex), controller: null };
      }
      const pageUrl = getImageUrl(pageIndex);
      if (!pageUrl) throw new Error('La URL de la página de imagen no existe');

      // Sitios de imagen de enlace directo (nhentai/hitomi, etc.): sin necesidad de extraer imagen real del HTML, devolver URL directamente.
      const isDirectImageUrl = /^https?:\/\//i.test(pageUrl) && /\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#].*)?$/i.test(pageUrl);
      if (isDirectImageUrl) {
        realUrlCache.set(pageIndex, pageUrl);
        persistRealUrlCacheLater();
        preconnectToOrigin(pageUrl);
        return { url: pageUrl, controller: null };
      }

      const inflight = realUrlRequests.get(pageIndex);
      if (inflight) return inflight.promise;
      const controller = new AbortController();
      const promise = fetchRealImageUrlAndToken(pageUrl, controller.signal)
        .then(({ url, nlToken }) => {
          realUrlCache.set(pageIndex, url);
          if (nlToken) realUrlFallbackToken.set(pageIndex, nlToken);
          persistRealUrlCacheLater();
          preconnectToOrigin(url);
          // Analizar posible información de ancho/alto en la URL, como ...-1280-1523-xxx o -3000-3000-png
          try {
            const sizeMatch = url.match(/-(\d{2,5})-(\d{2,5})-(?:jpg|jpeg|png|gif|webp)/i) || url.match(/-(\d{2,5})-(\d{2,5})-(?:png|jpg|webp|gif)/i);
            if (sizeMatch) {
              const w = parseInt(sizeMatch[1]);
              const h = parseInt(sizeMatch[2]);
              if (w > 0 && h > 0) {
                const r = Math.max(0.02, Math.min(5, w / h));
                ratioCache.set(pageIndex, r);
                // Si ya se entró al modo horizontal y el wrapper sigue siendo esqueleto, actualizar la proporción del marcador inmediatamente
                const imgEl = document.querySelector(`#eh-continuous-horizontal img[data-page-index="${pageIndex}"]`);
                if (imgEl) {
                  const wrap = imgEl.closest('.eh-ch-wrapper');
                  if (wrap && wrap.classList.contains('eh-ch-skeleton')) {
                    wrap.style.setProperty('--eh-aspect', String(r));
                  }
                }
              }
            }
          } catch {}
          realUrlRequests.delete(pageIndex);
          return { url, controller };
        })
        .catch(e => {
          realUrlRequests.delete(pageIndex);
          throw e;
        });
      realUrlRequests.set(pageIndex, { promise, controller });
      return promise;
    }

    // Cola de precarga (concurrencia limitada, cancelable)
    const prefetch = { queue: [], running: 0, max: 2, controllers: new Map() }; // Reducir concurrencia de 3 a 2
    function cancelPrefetchExcept(targetIndex) {
      prefetch.controllers.forEach((ctl, idx) => {
        if (idx !== targetIndex && ctl) { try { ctl.abort('prefetch-cancel'); } catch {}
        }
      });
      prefetch.queue = prefetch.queue.filter(it => it.pageIndex === targetIndex);
    }
    function startNextPrefetch() {
      while (prefetch.running < prefetch.max && prefetch.queue.length > 0) {
        const item = prefetch.queue.shift();
        const idx = item.pageIndex;
        const cached = state.imageCache.get(idx);
        if (cached && (cached.status === 'loaded' || cached.status === 'loading')) continue; // Omitir los que están cargando
        prefetch.running++;
        const ctl = new AbortController();
        prefetch.controllers.set(idx, ctl);
        ensureRealImageUrl(idx)
          .then(({ url }) => {
            if (ctl.signal.aborted) throw new DOMException('aborted','AbortError');
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = (e) => reject(e);
              img.src = url;
            }).then(img => {
              if (ctl.signal.aborted) throw new DOMException('aborted','AbortError');
              state.imageCache.set(idx, { status: 'loaded', img });
            });
          })
          .catch(e => {
            if (!(e && e.name === 'AbortError')) {
              state.imageCache.set(idx, { status: 'error' });
            }
          })
          .finally(() => {
            prefetch.controllers.delete(idx);
            prefetch.running--;
            startNextPrefetch();
          });
      }
    }
    function enqueuePrefetch(indices, prioritize = false) {
      if (!indices || indices.length === 0) return;
      
      debugLog('[EH Prefetch] Solicitud de precarga:', indices, 'Prioridad:', prioritize);
      
      const queued = new Set(prefetch.queue.map(i => i.pageIndex));
      indices.forEach(idx => {
        if (idx < 0 || idx >= state.pageCount) return;
        const cached = state.imageCache.get(idx);
        if (cached?.status === 'loaded') {
          debugLog('[EH Prefetch] Omitir ya en caché:', idx);
          return;
        }
        if (!queued.has(idx)) {
          if (prioritize) prefetch.queue.unshift({ pageIndex: idx });
          else prefetch.queue.push({ pageIndex: idx });
          queued.add(idx);
          debugLog('[EH Prefetch] Añadir a la cola:', idx);
        }
      });
      startNextPrefetch();
    }
    
    // Extraer URL real de imagen de la página de imagen de E-Hentai + token nl de respaldo
    async function fetchRealImageUrlAndToken(pageUrl, signal) {
      try {
        debugLog('[EH Modern Reader] Comenzar a obtener la página de imagen:', pageUrl);
        
        const response = await fetch(pageUrl, {
          signal,
          credentials: 'include',
          mode: 'cors',
          referrer: location.href,
          referrerPolicy: 'strict-origin-when-cross-origin'
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const html = await response.text();
        debugLog('[EH Modern Reader] Longitud del HTML de la página:', html.length);
        
        // Extraer URL de imagen de la página (método principal)
        const match = html.match(/<img[^>]+id="img"[^>]+src="([^"]+)"/);
        let foundUrl = null;
        if (match && match[1]) {
          foundUrl = match[1];
          debugLog('[EH Modern Reader] URL de imagen encontrada (método 1):', foundUrl);
        }
        
        // Probar patrón de coincidencia alternativo
        if (!foundUrl) {
          const match2 = html.match(/src="(https?:\/\/[^\"]+\.(?:jpg|jpeg|png|gif|webp)[^\"]*)"/i);
          if (match2 && match2[1]) {
            foundUrl = match2[1];
            debugLog('[EH Modern Reader] URL de imagen encontrada (método 2):', foundUrl);
          }
        }
        
        // Intentar coincidencia directa de URL
        if (!foundUrl) {
          const match3 = html.match(/(https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp))/i);
          if (match3 && match3[1]) {
            foundUrl = match3[1];
            debugLog('[EH Modern Reader] URL de imagen encontrada (método 3):', foundUrl);
          }
        }

        // Extraer token nl de respaldo
        let nlToken = null;
        try {
          const nlMatch = html.match(/nl\(['"]([^'\"]+)['"]\)/i) || html.match(/id=['"]loadfail['"][^>]*onclick=['"][^'"]*nl\(['"]([^'\"]+)['"]\)/i);
          if (nlMatch && nlMatch[1]) nlToken = nlMatch[1];
        } catch {}
        
        if (foundUrl) return { url: foundUrl, nlToken };
        
        console.error('[EH Modern Reader] No se puede extraer la URL de imagen de la página');
        debugLog('[EH Modern Reader] Fragmento HTML:', html.substring(0, 1000));
        throw new Error('No se puede extraer la URL de imagen de la página');
      } catch (error) {
        console.error('[EH Modern Reader] Error al obtener URL de imagen:', pageUrl, error);
        throw error;
      }
    }

    async function fetchRealImageUrlWithToken(pageUrl, nlToken, signal) {
      const url = pageUrl + (pageUrl.includes('?') ? '&' : '?') + 'nl=' + encodeURIComponent(nlToken);
      return fetchRealImageUrlAndToken(url, signal);
    }

    // 🎯 Cargar imágenes usando objeto Image (animación de progreso simulada)
    // Nota: Debido a restricciones CORS del navegador, XMLHttpRequest en Content Script no puede hacer solicitudes entre dominios para imágenes
    // Por eso se usa objeto Image, con animación de progreso simulada para mejorar la experiencia del usuario
    function loadImageWithProgress(imageUrl, onProgress) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const startTime = Date.now();
        let progressInterval = null;
        let currentProgress = 0;
        
        // 🎯 Simulación de actualización de progreso (curva de crecimiento suave)
        const simulateProgress = () => {
          const elapsed = Date.now() - startTime;
          
          // Usar curva logarítmica para simular progreso de carga: crecimiento rápido luego gradual
          // 0-1s: 0% -> 30%
          // 1-3s: 30% -> 60%
          // 3-5s: 60% -> 80%
          // 5s+: 80% -> 95% (nunca llega al 100%, espera la carga real)
          if (elapsed < 1000) {
            currentProgress = elapsed / 1000 * 0.3;
          } else if (elapsed < 3000) {
            currentProgress = 0.3 + (elapsed - 1000) / 2000 * 0.3;
          } else if (elapsed < 5000) {
            currentProgress = 0.6 + (elapsed - 3000) / 2000 * 0.2;
          } else {
            currentProgress = 0.8 + Math.min((elapsed - 5000) / 10000 * 0.15, 0.15);
          }
          
          if (onProgress) {
            onProgress(currentProgress);
          }
        };
        
        // Actualizar progreso cada 100ms
        progressInterval = setInterval(simulateProgress, 100);
        
        img.onload = () => {
          clearInterval(progressInterval);
          // Carga completada, saltar inmediatamente al 100%
          if (onProgress) {
            onProgress(1.0);
          }
          debugLog(`[EH Loading Progress] Carga completada de imagen: ${imageUrl.substring(0, 80)}...`);
          resolve(img);
        };
        
        img.onerror = (e) => {
          clearInterval(progressInterval);
          console.error('[EH Loading Progress] Error al cargar imagen:', imageUrl, e);
          reject(new Error('Error al cargar imagen'));
        };
        
        // Establecer tiempo de espera
        const timeout = setTimeout(() => {
          clearInterval(progressInterval);
          if (!img.complete) {
            reject(new Error('Tiempo de espera de carga de imagen agotado'));
          }
        }, 60000); // 60 segundos de tiempo límite
        
        img.onload = () => {
          clearTimeout(timeout);
          clearInterval(progressInterval);
          if (onProgress) {
            onProgress(1.0);
          }
          // 🎯 Usar decode() para decodificar imagen en segundo plano, evitar bloqueo del hilo principal
          if (typeof img.decode === 'function') {
            img.decode().then(() => {
              debugLog(`[EH Loading Progress] Decodificación de imagen completada`);
              resolve(img);
            }).catch(() => {
              // Si decode falla, también devolver la imagen (algunos navegadores no lo soportan)
              resolve(img);
            });
          } else {
            resolve(img);
          }
        };
        
        img.src = imageUrl;
      });
    }

    // Cargar imagen (con mecanismo de reintento)
    async function loadImage(pageIndex, retryCount = 0) {
      const MAX_RETRIES = 3;
      const TIMEOUT = 60000; // Aumentado a 60 segundos
      
      try {
        // Acierto de caché: devolver directamente
        if (state.imageCache.has(pageIndex)) {
          const cached = state.imageCache.get(pageIndex);
          if (cached.status === 'loaded' && cached.img) return cached.img;
          if (cached.status === 'loading' && cached.promise) return cached.promise;
          // Si falló antes, limpiar caché y recargar
          if (cached.status === 'error') {
            state.imageCache.delete(pageIndex);
          }
        }

        // Modo Gallery: obtener URL de página individual y luego extraer el HTML igual que en MPV
        if (window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled) {
          debugLog('[EH Modern Reader] Cargando imagen en modo Gallery:', pageIndex);

          const fetchFn = window.__ehGalleryBootstrap.fetchPageImageUrl;
          if (!fetchFn) {
            throw new Error('La función fetchPageImageUrl no existe');
          }

          // Obtener URL de página única
          const pageData = await fetchFn(pageIndex);
          debugLog('[EH Modern Reader] Datos de página Gallery:', pageData);

          const pageUrl = pageData.pageUrl;
          if (!pageUrl) {
            throw new Error('No se puede obtener la URL de la página');
          }

          // Actualizar key en imagelist
          if (window.__ehReaderData && window.__ehReaderData.imagelist[pageIndex]) {
            const direct = /^https?:\/\//i.test(pageUrl) && /\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#].*)?$/i.test(pageUrl);
            // Solo los enlaces de página individual de E-Hentai necesitan imgkey; los sitios de enlace directo (como hitomi) no deben escribir k para evitar confusión con páginas /s/.
            if (!direct) {
              window.__ehReaderData.imagelist[pageIndex].k = pageData.imgkey || '';
            }
          }

          const isDirectImageUrl = /^https?:\/\//i.test(pageUrl) && /\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#].*)?$/i.test(pageUrl);

          // URL de imagen directa (como nhentai): no necesita extraer HTML
          if (isDirectImageUrl) {
            const tryDirectLoad = async (urlToLoad) => {
              return loadImageWithProgress(urlToLoad, (progress) => {
                updateImageLoadingProgress(progress);
              });
            };

            const pending = loadImageWithProgress(pageUrl, (progress) => {
              updateImageLoadingProgress(progress);
            }).then((img) => {
              debugLog('[EH Modern Reader] Carga directa de imagen Gallery exitosa:', pageUrl);
              state.imageCache.set(pageIndex, { status: 'loaded', img });
              state.imageRequests.delete(pageIndex);
              return img;
            }).catch(async (error) => {
              console.error('[EH Modern Reader] Fallo en carga directa de imagen Gallery:', pageUrl, error);

              // Si se tienen URLs candidatas del script bridge del sitio, reintentarlas en orden para evitar inestabilidad de dominio único.
              const entry = window.__ehReaderData && window.__ehReaderData.imagelist
                ? window.__ehReaderData.imagelist[pageIndex]
                : null;
              const altUrls = entry && Array.isArray(entry.altUrls) ? entry.altUrls : [];

              for (const altUrl of altUrls) {
                if (!altUrl || altUrl === pageUrl) continue;
                try {
                  const img2 = await tryDirectLoad(altUrl);
                  if (entry) {
                    entry.url = altUrl;
                  }
                  debugLog('[EH Modern Reader] Retroceso de imagen directa Gallery exitoso:', altUrl);
                  state.imageCache.set(pageIndex, { status: 'loaded', img: img2 });
                  state.imageRequests.delete(pageIndex);
                  return img2;
                } catch (e2) {
                  console.warn('[EH Modern Reader] Fallo en retroceso de imagen directa Gallery:', altUrl, e2);
                }
              }

              state.imageCache.delete(pageIndex);
              state.imageRequests.delete(pageIndex);
              throw new Error(`Error al cargar imagen: ${pageUrl}`);
            });

            state.imageCache.set(pageIndex, { status: 'loading', promise: pending });
            return pending;
          }

          // Enlace de página única E-Hentai: extraer URL de imagen real del HTML
          const abortController = new AbortController();
          state.imageRequests.set(pageIndex, abortController);

          const { url: imageUrl, nlToken } = await fetchRealImageUrlAndToken(pageUrl, abortController.signal);
          if (nlToken) realUrlFallbackToken.set(pageIndex, nlToken);
          
          // 🎯 Usar XMLHttpRequest para cargar imagen y seguir el progreso
          const pending = loadImageWithProgress(imageUrl, (progress) => {
            updateImageLoadingProgress(progress);
          }).then((img) => {
            debugLog('[EH Modern Reader] Imagen Gallery cargada con éxito:', imageUrl);
            state.imageCache.set(pageIndex, { status: 'loaded', img });
            state.imageRequests.delete(pageIndex);
            return img;
          }).catch(async (error) => {
            console.error('[EH Modern Reader] Fallo al cargar imagen Gallery:', imageUrl, error);
            state.imageCache.delete(pageIndex);
            // Intentar cambiar de espejo usando token nl
            try {
              const token = realUrlFallbackToken.get(pageIndex);
              if (token) {
                const ac2 = new AbortController();
                const { url: altUrl } = await fetchRealImageUrlWithToken(pageUrl, token, ac2.signal);
                const img2 = await loadImageWithProgress(altUrl, (p)=>updateImageLoadingProgress(p));
                state.imageCache.set(pageIndex, { status: 'loaded', img: img2 });
                state.imageRequests.delete(pageIndex);
                return img2;
              }
            } catch (e2) {
              console.warn('[EH Modern Reader] Gallery: fallo de retroceso nl:', e2);
            }
            state.imageRequests.delete(pageIndex);
            throw new Error(`Error al cargar imagen: ${imageUrl}`);
          });

          state.imageCache.set(pageIndex, { status: 'loading', promise: pending });
          return pending;
        }

        // Modo MPV: lógica original
        const pageUrl = getImageUrl(pageIndex);
        if (!pageUrl) {
          throw new Error('La URL de la imagen no existe');
        }

        const retryMsg = retryCount > 0 ? ` (reintento ${retryCount}/${MAX_RETRIES})` : '';
        debugLog('[EH Modern Reader] Obteniendo página de imagen:', pageUrl, retryMsg);

        // Si es una URL de página de imagen de E-Hentai, necesita obtener la URL real de la imagen primero
        if (pageUrl.includes('/s/')) {
          // Crear/sobreescribir un AbortController para esta página, para facilitar la cancelación de solicitudes
          const existing = state.imageRequests.get(pageIndex);
          if (existing && existing.controller) existing.controller.abort('navigate-cancel');
          const controller = new AbortController();
          state.imageRequests.set(pageIndex, { controller });

          const { url: realImageUrl } = await ensureRealImageUrl(pageIndex);
          if (!realImageUrl) {
            throw new Error('No se puede obtener la URL real de la imagen');
          }

          debugLog('[EH Modern Reader] URL real de imagen:', realImageUrl);

          // 🎯 Usar XMLHttpRequest para cargar imagen y seguir el progreso
          const pending = loadImageWithProgress(realImageUrl, (progress) => {
            updateImageLoadingProgress(progress);
          }).then((img) => {
            debugLog('[EH Modern Reader] Imagen cargada con éxito:', realImageUrl);
            state.imageCache.set(pageIndex, { status: 'loaded', img });
            return img;
          }).catch(async (error) => {
            console.error('[EH Modern Reader] Error al cargar imagen:', realImageUrl, error);
            state.imageCache.delete(pageIndex); // Limpiar caché para permitir reintento
            // Intentar cambiar de espejo una vez usando token nl
            try {
              const token = realUrlFallbackToken.get(pageIndex);
              if (token) {
                const controller2 = new AbortController();
                const { url: altUrl } = await fetchRealImageUrlWithToken(pageUrl, token, controller2.signal);
                realUrlCache.set(pageIndex, altUrl);
                persistRealUrlCacheLater();
                preconnectToOrigin(altUrl);
                const img2 = await loadImageWithProgress(altUrl, (p)=>updateImageLoadingProgress(p));
                state.imageCache.set(pageIndex, { status: 'loaded', img: img2 });
                return img2;
              }
            } catch (e2) {
              console.warn('[EH Modern Reader] Error al usar retroceso con token nl:', e2);
            }
            throw new Error(`Error al cargar imagen: ${realImageUrl}`);
          });

          state.imageCache.set(pageIndex, { status: 'loading', promise: pending });
          return pending;
        }
        
  // Si ya es una URL de imagen directa
        const pending = loadImageWithProgress(pageUrl, (progress) => {
          updateImageLoadingProgress(progress);
        }).then((img) => {
          state.imageCache.set(pageIndex, { status: 'loaded', img });
          return img;
        }).catch((error) => {
          state.imageCache.delete(pageIndex);
          throw error;
        });
        
        state.imageCache.set(pageIndex, { status: 'loading', promise: pending });
        return pending;
      } catch (error) {
        console.error('[EH Modern Reader] Error en loadImage:', error);

        // Mecanismo de reintento automático
        if (retryCount < MAX_RETRIES) {
          debugLog(`[EH Modern Reader] Reintentando en 2 segundos... (${retryCount + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          return loadImage(pageIndex, retryCount + 1);
        }
        
        throw error;
      }
    }

    // Control de salto diferido y condición de carrera
    let navTimer = null;
    let navDelay = 140; // Retraso para fusionar saltos (ms)
    let lastRequestedPage = null;
    let loadToken = 0; // Para control de condición de carrera
    let scrollJumping = false; // Marca de salto programático en curso
    let activeScrollAnim = null; // Manejador de animación personalizada en modo horizontal
    let forceNextShowPage = false; // Forzar actualización en el siguiente showPage (evita problemas de paso de parámetros)

    // Animación scrollLeft de duración fija, unifica el “tacto de animación de página” (JHenTai usa 200ms de easing)
    function animateScrollLeft(el, target, opts = {}) {
      const duration = typeof opts.duration === 'number' ? opts.duration : 200; // ms
      const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      const to = clamp(target, 0, maxScroll);
      const from = el.scrollLeft;
      const delta = to - from;
      if (Math.abs(delta) < 0.5) {
        el.scrollLeft = to;
        return Promise.resolve();
      }
      // Cancelar la animación anterior
      if (activeScrollAnim && typeof activeScrollAnim.cancel === 'function') {
        try { activeScrollAnim.cancel(); } catch {}
      }
      let rafId = 0;
      let cancelled = false;
      const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      scrollJumping = true;
      return new Promise((resolve) => {
        const startTs = performance.now();
        const step = (now) => {
          if (cancelled) { scrollJumping = false; resolve(); return; }
          const t = clamp((now - startTs) / duration, 0, 1);
          const eased = easeInOutCubic(t);
          el.scrollLeft = from + delta * eased;
          if (t < 1) rafId = requestAnimationFrame(step); else { scrollJumping = false; resolve(); }
        };
        rafId = requestAnimationFrame(step);
        activeScrollAnim = {
          cancel() { cancelled = true; if (rafId) cancelAnimationFrame(rafId); }
        };
      });
    }

    function scheduleShowPage(pageNum, options = {}) {
      if (pageNum < 1 || pageNum > state.pageCount) return;
      const immediate = !!options.immediate; // Escenarios que requieren “respuesta inmediata” como clic del usuario (no usa retraso de fusión)
      // Modo horizontal continuo: desplazar al centro de la página objetivo en lugar de reemplazar imagen directamente
      const horizontalContainer = (state.settings.readMode === 'continuous-horizontal')
        ? document.getElementById('eh-continuous-horizontal')
        : null;
      if (horizontalContainer) {
        const idx = pageNum - 1;
        
        // Modo de desplazamiento virtual horizontal: usar función de salto dedicada
        if (virtualScrollH.enabled) {
          debugLog('[EH VirtualH] Solicitud de salto -> page=', pageNum);
          jumpToVirtualPageH(pageNum);
          state.currentPage = pageNum;
          if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
          if (elements.progressBar) elements.progressBar.value = pageNum;
          updateThumbnailHighlight(pageNum);
          preloadAdjacentPages(pageNum);
          saveProgress(pageNum);
          const eager = [idx, idx-1, idx+1].filter(i => i >=0 && i < state.pageCount);
          enqueuePrefetch(eager, true);
          return;
        }
        
        // Modo horizontal continuo normal
        const img = horizontalContainer.querySelector(`img[data-page-index="${idx}"]`);
        if (img) {
          const wrapper = img.closest('.eh-ch-wrapper') || img.parentElement || img;
          debugLog('[EH Modern Reader] Posicionamiento de desplazamiento en modo horizontal continuo -> page=', pageNum);
          // Usar scrollIntoView para simplificar el posicionamiento, más confiable
          scrollJumping = true;
          wrapper.scrollIntoView({
            behavior: options.instant ? 'auto' : 'smooth',
            block: 'center',
            inline: 'center'
          });
          setTimeout(() => { scrollJumping = false; }, options.instant ? 50 : 300);
          // Sincronizar número de página y resaltado de miniatura (evitar esperar evento scroll)
          state.currentPage = pageNum;
          if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
          if (elements.progressBar) elements.progressBar.value = pageNum;
          updateThumbnailHighlight(pageNum);
          preloadAdjacentPages(pageNum);
          saveProgress(pageNum);
          // Precargar imagen objetivo y adyacentes
          const eager = [idx, idx-1, idx+1].filter(i => i >=0 && i < state.pageCount);
          enqueuePrefetch(eager, true);
          return;
        }
        // Si no se encuentra el elemento, retroceder a visualización normal
      }

      // Modo vertical continuo: desplazar al centro de la página objetivo
      const verticalContainer = (state.settings.readMode === 'continuous-vertical')
        ? document.getElementById('eh-continuous-vertical')
        : null;
      if (verticalContainer) {
        const idx = pageNum - 1;
        
        // Modo de desplazamiento virtual: usar función de salto dedicada
        if (virtualScroll.enabled) {
          debugLog('[EH Virtual] Solicitud de salto -> page=', pageNum);
          jumpToVirtualPage(pageNum);
          // Sincronizar número de página y resaltado de miniatura
          state.currentPage = pageNum;
          if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
          if (elements.progressBar) elements.progressBar.value = pageNum;
          updateThumbnailHighlight(pageNum);
          preloadAdjacentPages(pageNum);
          saveProgress(pageNum);
          // Precargar imagen objetivo y adyacentes con anticipación
          const eager = [idx, idx-1, idx+1].filter(i => i >=0 && i < state.pageCount);
          enqueuePrefetch(eager, true);
          return;
        }

        // Modo continuo vertical normal
        const img = verticalContainer.querySelector(`img[data-page-index="${idx}"]`);
        if (img) {
          const wrapper = img.closest('.eh-cv-wrapper') || img.parentElement || img;
          debugLog('[EH Modern Reader] Modo continuo vertical, posicionamiento por scroll -> page=', pageNum);
          // Usar scrollIntoView para simplificar el posicionamiento, más fiable
          scrollJumping = true;
          wrapper.scrollIntoView({
            behavior: options.instant ? 'auto' : 'smooth',
            block: 'center',
            inline: 'center'
          });
          setTimeout(() => { scrollJumping = false; }, options.instant ? 50 : 300);
          // Sincronizar número de página y resaltado de miniatura
          state.currentPage = pageNum;
          if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
          if (elements.progressBar) elements.progressBar.value = pageNum;
          updateThumbnailHighlight(pageNum);
          preloadAdjacentPages(pageNum);
          saveProgress(pageNum);
          // Precargar imagen objetivo y adyacentes
          const eager = [idx, idx-1, idx+1].filter(i => i >=0 && i < state.pageCount);
          enqueuePrefetch(eager, true);
          return;
        }
        // Si no se encuentra el elemento, retroceder a visualización normal
      }

      // Modo normal (página única): fusionar en una única carga real con retraso
      lastRequestedPage = pageNum;
      const forceRefresh = !!options.force; // Guardar opción force
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        navTimer = null;
        // Cancelar solicitudes en curso excepto la página objetivo, para no ocupar ancho de banda
        state.imageRequests.forEach((entry, idx) => {
          if (idx !== lastRequestedPage - 1 && entry && entry.controller) {
            try { entry.controller.abort('navigation-switch'); } catch {}
          }
        });
        cancelPrefetchExcept(lastRequestedPage - 1);
        internalShowPage(lastRequestedPage, { force: forceRefresh });
      }, navDelay);
    }

    async function internalShowPage(pageNum, options = {}) {
      const token = ++loadToken;
      // Usar variable a nivel de módulo para pasar la señal force (evita problemas extraños de paso de parámetros)
      if (options.force) {
        forceNextShowPage = true;
      }
      await showPage(pageNum, token);
    }

    // Mostrar la página especificada (con token de condición de carrera)
    async function showPage(pageNum, tokenCheck) {
      if (pageNum < 1 || pageNum > state.pageCount) return;
      
      // Comprobar señal force a nivel de módulo
      const forceRefresh = forceNextShowPage;
      if (forceNextShowPage) {
        forceNextShowPage = false; // Restablecer
      }

      // Optimización de cortocircuito: número de página igual + imagen cargada + URL de imagen coincide con la caché de la página actual
      if (!forceRefresh && pageNum === state.currentPage && elements.currentImage && elements.currentImage.src) {
        // Verificación adicional: ¿la imagen mostrada actualmente es realmente la imagen de esa página?
        const cached = state.imageCache.get(pageNum - 1);
        if (cached && cached.img && elements.currentImage.src === cached.img.src) {
          return; // Cortocircuito real: la imagen coincide
        }
        // La imagen no coincide, continuar con la actualización
      }

      state.currentPage = pageNum;
      
      // Restablecer zoom de imagen
      resetImageZoom();

      // Comprobar estado de caché
      const targetIndex = pageNum - 1;
      const cachedTarget = state.imageCache.get(targetIndex);
      const targetLoaded = cachedTarget && cachedTarget.status === 'loaded' && cachedTarget.img;

      // 🎯 Si ya está en caché, usar directamente la imagen en caché, sin animación de carga
      if (targetLoaded) {
        const img = cachedTarget.img;
        if (elements.currentImage) {
          elements.currentImage.src = img.src;
          elements.currentImage.style.display = 'block';
          elements.currentImage.alt = `Página ${pageNum}`;
        }
        // Actualizar UI
        if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
        if (elements.progressBar) elements.progressBar.value = pageNum;
        const progressCurrent = document.getElementById('eh-progress-current');
        if (progressCurrent) progressCurrent.textContent = pageNum;
        updateThumbnailHighlight(pageNum);
        preloadAdjacentPages(pageNum);
        saveProgress(pageNum);
        return; // Retorno directo, sin mostrar animación de carga
      }

      // 🎯 Solo mostrar indicador de progreso si no está en caché
      if (!targetLoaded) {
        if (!elements.currentImage || !elements.currentImage.src || elements.currentImage.style.display === 'none') {
          showLoading();
        }
        // Mostrar superposición de barra de progreso circular
        showImageLoadingProgress(pageNum);
      }

      try {
        const img = await loadImage(targetIndex);

        // Verificación de condición de carrera: si se realizó una nueva solicitud de salto durante la carga, descartar el resultado actual
        if (typeof tokenCheck === 'number' && tokenCheck !== loadToken) {
          hideImageLoadingProgress(); // También ocultar el indicador de progreso al cancelar
          return; // Descartar carga expirada
        }

        // 🎯 Ocultar indicador de progreso
        hideImageLoadingProgress();

        // Ocultar estado de carga
        hideLoading();

        // Ocultar mensaje de error (si existe)
        hideErrorMessage();

        // Actualizar imagen
        if (elements.currentImage) {
          console.log('[EH Modern Reader] Actualizar src de imagen:', img.src?.slice(-50), '-> página:', pageNum);
          elements.currentImage.src = img.src;
          elements.currentImage.style.display = 'block';
          elements.currentImage.alt = `Página ${pageNum}`;
        }

        // Actualizar visualización de número de página
        if (elements.pageInfo) {
          elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
        }

        // Actualizar posición de barra de progreso y números de página en ambos extremos
        if (elements.progressBar) {
          elements.progressBar.value = pageNum;
        }
        const progressCurrent = document.getElementById('eh-progress-current');
        if (progressCurrent) {
          progressCurrent.textContent = pageNum;
        }

        if (elements.pageInput) {
          elements.pageInput.value = pageNum;
        }

  debugLog('[EH Modern Reader] Mostrar página:', pageNum, 'URL imagen:', img.src);

  // Actualizar resaltado de miniaturas (necesario en modo de página única)
  updateThumbnailHighlight(pageNum);

  // Guardar progreso de lectura
  saveProgress(pageNum);

        // Estrategia de precarga: precargar página siguiente y anterior (mejora la experiencia de cambio)
        preloadAdjacentPages(pageNum);

        // Actualizar imágenes adyacentes en el carril deslizante (para arrastrar y cambiar página en modo de página única)
        if (pageSlider.isSinglePageMode()) {
          pageSlider.updateAdjacentImages();
        }

      } catch (error) {
        console.error('[EH Modern Reader] Error al cargar imagen:', error);

        // 🎯 Ocultar indicador de progreso
        hideImageLoadingProgress();

        // Mostrar mensaje de error amigable y botón de reintento
        showErrorMessage(pageNum, error.message);
      }
    }

    // Precargar páginas adyacentes (mejora la experiencia de cambio)
    function preloadAdjacentPages(currentPage) {
      const indices = [];
      const ahead = state.settings.prefetchAhead || 2; // Precargar 2 páginas por defecto

      // Modo Gallery: estrategia de precarga más conservadora (solo 1 página adelante/atrás)
      if (window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled) {
        // 1 página antes y después de la página actual
        const prevIdx = currentPage - 2;
        const nextIdx = currentPage;
        if (prevIdx >= 0) indices.push(prevIdx);
        if (nextIdx < state.pageCount) indices.push(nextIdx);

        // Usar baja prioridad para evitar activar controles de riesgo
        if (indices.length > 0) {
          enqueuePrefetch(indices, false);
        }
        return;
      }
      
      // Modo MPV: estrategia de precarga normal
      for (let i = 1; i <= ahead; i++) {
        const idx = currentPage - 1 + i; // Hacia adelante
        if (idx < state.pageCount) indices.push(idx);
      }
      // También precargar la misma cantidad hacia atrás
      for (let i = 1; i <= Math.min(ahead, 1); i++) {
        const idx = currentPage - 1 - i;
        if (idx >= 0) indices.push(idx);
      }
      
      if (indices.length > 0) {
        enqueuePrefetch(indices, false);
      }
    }

    // Actualizar resaltado de miniaturas (optimización de rendimiento, solo opera en la actual y la anterior)
    function updateThumbnailHighlight(pageNum) {
      const thumbnails = document.querySelectorAll('.eh-thumbnail');
      if (!thumbnails || thumbnails.length === 0) return;
      // El orden DOM de las miniaturas siempre es 1,2,3..., la lectura invertida usa flex-direction: row-reverse para volteo visual
      // Por lo tanto, el índice de resaltado siempre es pageNum - 1 (índice físico)
      const idx = Math.max(0, Math.min(thumbnails.length - 1, pageNum - 1));
      const currentThumb = thumbnails[idx];
      const prevActiveThumb = document.querySelector('.eh-thumbnail.active');

      // Quitar resaltado anterior
      if (prevActiveThumb && prevActiveThumb !== currentThumb) {
        prevActiveThumb.classList.remove('active');
      }

      // Agregar nuevo resaltado
      if (currentThumb) {
        currentThumb.classList.add('active');

        // Verificar si la miniatura ya está en el área visible
        const container = elements.thumbnails;
        if (container) {
          const thumbRect = currentThumb.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const isVisible = (
            thumbRect.left >= containerRect.left &&
            thumbRect.right <= containerRect.right &&
            thumbRect.top >= containerRect.top &&
            thumbRect.bottom <= containerRect.bottom
          );

          // En salto programático: desplazar al objetivo y bloquear el observador, luego cargar manualmente el rango visible (incluyendo un poco a los lados)
          if (!isVisible) {
            // No activar desplazamiento de miniaturas durante el arrastre de la barra de progreso, para evitar jitter y problemas de rendimiento
            if (!state.draggingProgress) {
              thumbnailLoadQueue.setScrollLock();
              // En la primera entrada al lector con startAt/página restaurada, usar posicionamiento instantáneo para evitar desplazamiento suave desde 1 a páginas altas
              const instantFirstScroll = !state._thumbsInitialPositioned;
              if (instantFirstScroll) {
                state._thumbsInitialPositioned = true;
                // Calcular scrollLeft centrado (más estable que scrollIntoView)
                try {
                  const cRect = container.getBoundingClientRect();
                  const tRect = currentThumb.getBoundingClientRect();
                  const deltaLeft = (tRect.left - cRect.left) + (tRect.width - cRect.width) / 2;
                  container.scrollLeft += deltaLeft;
                } catch {
                  currentThumb.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
                }
              } else {
                currentThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              }
            }
          }

          // Independientemente de si ya está en el área visible, cargar manualmente después de un breve retraso: miniatura objetivo + otras miniaturas en el viewport actual
          // Así no depende de IntersectionObserver (bloqueado) y evita inundación de solicitudes durante el desplazamiento
          const isGalleryMode = window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled;
          if (isGalleryMode) {
            setTimeout(() => {
              // 1) Miniatura de la página objetivo
              if (currentThumb.dataset.loaded === 'false') {
                currentThumb.dataset.loaded = 'true';
                const imageData = state.imagelist[pageNum - 1];
                thumbnailLoadQueue.add(currentThumb, imageData, pageNum);
              }
              // 2) Otras miniaturas en el viewport (con un poco de buffer a los lados), máximo 10 para evitar inundación
              manualLoadVisibleThumbnails(10, 120);
            }, 160); // Esperar a que el posicionamiento de desplazamiento sea estable antes de tomar el rango visible
          }
        }
      }
    }

    // Generar miniaturas (versión optimizada con carga diferida)
  function generateThumbnails() {
      if (!elements.thumbnails) {
        console.warn('[EH Modern Reader] El contenedor de miniaturas no existe');
        return;
      }

      // Vaciar el contenedor para evitar adiciones duplicadas
      elements.thumbnails.innerHTML = '';

      // Validación de datos
      if (!Array.isArray(state.imagelist) || state.imagelist.length === 0) {
        console.warn('[EH Modern Reader] La lista de imágenes está vacía');
        elements.thumbnails.innerHTML = '<div style="color: rgba(255,255,255,0.6); padding: 20px; text-align: center;">Sin miniaturas disponibles</div>';
        return;
      }
      
      const list = state.imagelist;
      const fragment = document.createDocumentFragment();
      
      list.forEach((imageData, iterIndex) => {
        const physicalIndex = iterIndex;
        const thumb = document.createElement('div');
        thumb.className = 'eh-thumbnail';
        thumb.dataset.page = physicalIndex + 1; // Almacenar número de página para carga diferida
        thumb.dataset.loaded = 'false'; // Marcar si ya se ha cargado
        // Insertar un marcador de posición simple con antelación para evitar saltos de diseño
        const ph = document.createElement('div');
        ph.className = 'eh-thumb-placeholder';
        thumb.appendChild(ph);
        // Vista previa ligera de primera pantalla: usar fragmento del sprite del sitio como fondo (solo como marcador de posición, sin alineación precisa)
        if (imageData && typeof imageData.t === 'string') {
          try {
            // El campo t de MPV tiene la forma: "(https://.../xxx.webp) -0px -284px"
            // Usar directamente como background para obtener vista previa de marcador de posición inmediata
            thumb.style.background = imageData.t;
            thumb.style.backgroundRepeat = 'no-repeat';
            thumb.style.backgroundColor = 'transparent';
          } catch {}
        }
        
  const displayNum = physicalIndex + 1; // Número de página a mostrar
  const logicalPage = displayNum; // Página lógica coincide con el orden DOM

  // Mostrar la insignia de número de página ya en la etapa de marcador de posición, garantizando “número de página incluso sin carga”
  const badge = document.createElement('div');
  badge.className = 'eh-thumbnail-number';
  badge.textContent = String(displayNum);
  thumb.appendChild(badge);

        thumb.onclick = () => {
          // Salto unificado de página lógica
            scheduleShowPage(logicalPage, { instant: true });
        };
        
        fragment.appendChild(thumb);
      });
      
      // Agregar todos los DOM de miniaturas de una vez (pero no cargar imágenes)
      elements.thumbnails.appendChild(fragment);

      // Configurar observador de carga diferida
      setupThumbnailLazyLoad();
    }
    
    // 🎯 Herramienta de limitación de velocidad (referencia al mecanismo de Throttling de JHenTai)
    function createThrottle(delay = 200) {
      let timer = null;
      let lastCall = 0;
      
      return {
        throttle(fn) {
          const now = Date.now();
          const timeSinceLastCall = now - lastCall;
          
          if (timer) {
            clearTimeout(timer);
          }
          
          // Si el tiempo desde la última llamada supera el delay, ejecutar inmediatamente
          if (timeSinceLastCall >= delay) {
            lastCall = now;
            fn();
          } else {
            // De lo contrario, ejecutar con retraso
            timer = setTimeout(() => {
              lastCall = Date.now();
              timer = null;
              fn();
            }, delay - timeSinceLastCall);
          }
        },
        
        cancel() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      };
    }
    
    // Crear limitador de desplazamiento de miniaturas (200ms, referencia a JHenTai)
    const thumbnailScrollThrottle = createThrottle(200);
    
    // Gestión de cola de solicitudes (para prevenir controles de riesgo)
    const thumbnailLoadQueue = {
      queue: [],
      loading: new Set(),
      maxConcurrent: 3, // Máximo de solicitudes concurrentes
      requestDelay: 250, // Intervalo entre solicitudes (ms), ligeramente más rápido pero seguro
      isProgrammaticScroll: false, // Marca si el desplazamiento es activado por programa
      scrollLockTimer: null, // Temporizador de bloqueo
      scrollAnimationFrame: null, // ID de frame de animación de desplazamiento
      
      setScrollLock() {
        this.isProgrammaticScroll = true;
        
        // Cancelar la tarea pendiente en el limitador
        thumbnailScrollThrottle.cancel();
        
        // Limpiar temporizadores y frames de animación anteriores
        if (this.scrollLockTimer) {
          clearTimeout(this.scrollLockTimer);
        }
        if (this.scrollAnimationFrame) {
          cancelAnimationFrame(this.scrollAnimationFrame);
        }
        
        // 🎯 Mejora: deshabilitar completamente IntersectionObserver durante el bloqueo
        if (state.thumbnailObserver) {
          state.thumbnailObserver.disconnect();
        }
        
        // Modo Gallery: extender el tiempo de bloqueo a 2.5 segundos (animación de desplazamiento + tiempo de estabilización)
        // Modo MPV: 600ms (aumentar tiempo de estabilización)
        const isGalleryMode = window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled;
        const lockDuration = isGalleryMode ? 2500 : 600;
        
        debugLog('[EH Scroll Lock] Bloqueo de carga de miniaturas durante', lockDuration, 'ms');
        
        this.scrollLockTimer = setTimeout(() => {
          this.isProgrammaticScroll = false;
          this.scrollLockTimer = null;
          
          // 🎯 Tras el desbloqueo, solo observar miniaturas cerca del viewport actual (referencia a getCurrentVisibleThumbnails de JHenTai)
          if (state.thumbnailObserver && elements.thumbnails) {
            const container = elements.thumbnails;
            const containerRect = container.getBoundingClientRect();

            // Obtener todas las miniaturas no cargadas
            const allThumbnails = container.querySelectorAll('.eh-thumbnail[data-loaded="false"]');

            // 🎯 Corrección clave: solo observar miniaturas en y cerca del viewport (buffer ±300px)
            const visibleThumbnails = Array.from(allThumbnails).filter(thumb => {
              const thumbRect = thumb.getBoundingClientRect();
              const isNearViewport = (
                thumbRect.right >= containerRect.left - 300 &&
                thumbRect.left <= containerRect.right + 300 &&
                thumbRect.bottom >= containerRect.top - 300 &&
                thumbRect.top <= containerRect.bottom + 300
              );
              return isNearViewport;
            });
            
            debugLog(`[EH Scroll Lock] Desbloqueando carga de miniaturas, re-observando ${visibleThumbnails.length} miniaturas cerca del viewport (total ${allThumbnails.length} sin cargar)`);
            
            visibleThumbnails.forEach(thumb => state.thumbnailObserver.observe(thumb));
          }
        }, lockDuration);
      },
      
      add(thumb, imageData, pageNum) {
        if (this.loading.has(pageNum)) return;
        
        this.queue.push({ thumb, imageData, pageNum });
        this.process();
      },
      
      async process() {
        if (this.loading.size >= this.maxConcurrent) return;
        if (this.queue.length === 0) return;
        
        const item = this.queue.shift();
        if (!item || this.loading.has(item.pageNum)) {
          this.process();
          return;
        }
        
        this.loading.add(item.pageNum);
        
        try {
          await loadThumbnail(item.thumb, item.imageData, item.pageNum);
        } catch (err) {
          console.warn('[EH Modern Reader] Error al cargar miniatura:', item.pageNum, err);
        } finally {
          this.loading.delete(item.pageNum);

          // Procesar el siguiente después de un retraso
          setTimeout(() => {
            this.process();
          }, this.requestDelay);
        }
      },
      
      clear() {
        this.queue = [];
        this.loading.clear();
        if (this.scrollLockTimer) {
          clearTimeout(this.scrollLockTimer);
          this.scrollLockTimer = null;
        }
        this.isProgrammaticScroll = false;
      }
    };
    
    // Configurar carga diferida de miniaturas
    function setupThumbnailLazyLoad() {
      // Si ya hay un observador, desconectarlo primero
      if (state.thumbnailObserver) {
        state.thumbnailObserver.disconnect();
      }
      
      // 🎯 Aumentar el buffer de precarga para evitar cargar justo cuando el desplazamiento casi llega al final de la pantalla
      const isGalleryMode = window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled;
      const rootMargin = isGalleryMode ? '800px' : '1200px'; // Gallery: 800px (aumentado), MPV: 1200px
      
      const options = {
        root: elements.thumbnails,
        rootMargin: rootMargin,
        threshold: 0.01
      };
      
      console.log('[EH Lazy Load] Carga diferida de miniaturas habilitada, rootMargin:', rootMargin);
      
      // 🎯 Callback de IntersectionObserver: no usar cola acumulada, procesar directamente
      state.thumbnailObserver = new IntersectionObserver((entries) => {
        // 🎯 Corrección clave: no acumular, procesar el lote actual directamente
        const currentBatch = [];
        
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            // En desplazamiento activado por programa (salto de página), ignorar la activación de IntersectionObserver
            if (thumbnailLoadQueue.isProgrammaticScroll) {
              return;
            }
            
            const thumb = entry.target;
            if (thumb.dataset.loaded === 'false') {
              currentBatch.push({ thumb, pageNum: parseInt(thumb.dataset.page) });
            }
          }
        });
        
        if (currentBatch.length === 0) return;
        
        // 🎯 Procesar inmediatamente, sin más retraso (IntersectionObserver ya tiene efecto de throttling)
        debugLog(`[EH Lazy Load] Carga masiva de ${currentBatch.length} miniaturas`);
        
        currentBatch.forEach(({ thumb, pageNum }) => {
          thumb.dataset.loaded = 'true';
          const imageData = state.imagelist[pageNum - 1];
          
          // Agregar a la cola en lugar de cargar inmediatamente
          thumbnailLoadQueue.add(thumb, imageData, pageNum);
          
          // Dejar de observar este elemento después de la carga
          state.thumbnailObserver.unobserve(thumb);
        });
      }, options);
      
      // Observar todas las miniaturas
      const thumbnails = elements.thumbnails.querySelectorAll('.eh-thumbnail');
      thumbnails.forEach(thumb => {
        state.thumbnailObserver.observe(thumb);
      });

      // 🎯 Usar throttling para eventos de desplazamiento (referencia al throttling de 200ms de JHenTai)
      if (!isGalleryMode) {
        // Modo MPV: mantener respuesta al scroll de rueda
        elements.thumbnails.addEventListener('wheel', (e) => {
          thumbnailScrollThrottle.throttle(() => {
            if (!thumbnailLoadQueue.isProgrammaticScroll) {
              triggerBatchLoad();
            }
          });
        }, { passive: true });
      }
      
      // Todos los modos: mantener respuesta al arrastre de la barra de desplazamiento (usando throttling)
      elements.thumbnails.addEventListener('scroll', () => {
        thumbnailScrollThrottle.throttle(() => {
          if (!thumbnailLoadQueue.isProgrammaticScroll) {
            triggerBatchLoad();
          }
        });
      }, { passive: true });
    }
    
    // Activar carga masiva de miniaturas en y alrededor del área visible
    function triggerBatchLoad() {
      // Si es desplazamiento activado por programa (salto de página), no ejecutar carga masiva
      if (thumbnailLoadQueue.isProgrammaticScroll) {
        return;
      }
      
      if (!elements.thumbnails || !state.thumbnailObserver) return;
      
      const container = elements.thumbnails;
      const containerRect = container.getBoundingClientRect();
      const isGalleryMode = window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled;
      const observeMargin = isGalleryMode ? 400 : 1500; // Gallery: 400px, MPV: 1500px

      // 🎯 Corrección clave: al desplazarse, eliminar primero todas las observaciones, luego solo observar miniaturas cerca del viewport
      // Esto evita que IntersectionObserver active la carga de miniaturas alejadas de la posición actual
      const allThumbnails = container.querySelectorAll('.eh-thumbnail[data-loaded="false"]');

      // Paso 1: Dejar de observar todas las miniaturas (limpiar lista de observación antigua)
      state.thumbnailObserver.disconnect();

      // Paso 2: Solo re-observar miniaturas cerca del viewport
      let observedCount = 0;
      allThumbnails.forEach(thumb => {
        const thumbRect = thumb.getBoundingClientRect();
        const isNearViewport = (
          thumbRect.right >= containerRect.left - observeMargin &&
          thumbRect.left <= containerRect.right + observeMargin &&
          thumbRect.bottom >= containerRect.top - observeMargin &&
          thumbRect.top <= containerRect.bottom + observeMargin
        );
        
        if (isNearViewport) {
          state.thumbnailObserver.observe(thumb);
          observedCount++;
        }
      });
      
      if (observedCount > 0) {
        debugLog(`[EH Scroll] Detección de desplazamiento, re-observando ${observedCount} miniaturas cerca del viewport (lista de observación antigua limpiada)`);
      }
    }

    // Cargar manualmente las miniaturas “dentro del viewport” del contenedor de miniaturas actual, con un pequeño buffer a los lados, ignorando el bloqueo de scroll programático
    // maxBatch: máximo de imágenes a cargar en esta vez; extraMargin: buffer de píxeles adicional sobre el contexto
    function manualLoadVisibleThumbnails(maxBatch = 10, extraMargin = 120) {
      if (!elements.thumbnails) return;

      const container = elements.thumbnails;
      const containerRect = container.getBoundingClientRect();
      const start = containerRect.top - extraMargin;
      const end = containerRect.bottom + extraMargin;

      const thumbs = container.querySelectorAll('.eh-thumbnail');
      let loaded = 0;

      thumbs.forEach(thumb => {
        if (loaded >= maxBatch) return;
        if (thumb.dataset.loaded === 'true') return;

        const r = thumb.getBoundingClientRect();
        // Determinar si está dentro del área visible extendida (se requiere intersección tanto vertical como horizontal)
        const verticalIn = r.bottom >= start && r.top <= end;
        const horizontalIn = r.right >= containerRect.left && r.left <= containerRect.right;
        if (!(verticalIn && horizontalIn)) return;

        thumb.dataset.loaded = 'true';
        const pageNum = parseInt(thumb.dataset.page);
        const imageData = state.imagelist[pageNum - 1];
        thumbnailLoadQueue.add(thumb, imageData, pageNum);
        loaded++;

        if (state.thumbnailObserver) {
          state.thumbnailObserver.unobserve(thumb);
        }
      });
    }

    // ===== Miniaturas independientes (recortar sprite a canvas, luego centrar según contain) =====
    const spriteCache = new Map(); // url -> { img, promise, tileW:200, tileH }

    function computeTileHeightForSprite(url) {
      // Deducir la altura de la fila a partir del desplazamiento y del mismo sprite; tomar la moda de diferencias o la primera diferencia válida
      try {
        const ys = [];
        for (let i = 0; i < state.imagelist.length; i++) {
          const it = state.imagelist[i];
          if (!it || typeof it.t !== 'string') continue;
          const m = it.t.match(/\(?([^)]+)\)?\s+(-?\d+)(?:px)?\s+(-?\d+)(?:px)?/);
          if (m) {
            const u = m[1].replace(/^url\(['"]?|['"]?\)$/g, '').trim();
            if (u === url) {
              const y = Math.abs(parseInt(m[3] || '0'));
              if (!isNaN(y)) ys.push(y);
            }
          }
        }
        const uniq = Array.from(new Set(ys)).sort((a,b)=>a-b);
        const diffs = [];
        for (let i=1;i<uniq.length;i++) {
          const d = uniq[i]-uniq[i-1];
          if (d>0) diffs.push(d);
        }
        if (diffs.length === 0) return 267; // Retroceso
        // Moda
        const map = new Map();
        diffs.forEach(d=>map.set(d,(map.get(d)||0)+1));
        let best = diffs[0], cnt = 0;
        map.forEach((v,k)=>{ if (v>cnt) { cnt=v; best=k; } });
        return best || 267;
      } catch { return 267; }
    }

    function getSpriteMeta(url) {
      const hit = spriteCache.get(url);
      if (hit) return hit.promise;
      const img = new Image();
      const promise = new Promise((resolve, reject) => {
        img.onload = () => {
          const tileH = computeTileHeightForSprite(url);
          resolve({ img, tileW: 200, tileH });
        };
        img.onerror = (e) => reject(e);
      });
      img.src = url;
      const entry = { img, promise };
      spriteCache.set(url, entry);
      return promise;
    }

    function loadThumbnail(thumb, imageData, pageNum) {
      const idx = pageNum - 1;
      const title = (imageData && imageData.n) ? imageData.n : `Page ${pageNum}`;
      const containerW = 100, containerH = 142;

      // 🎯 Usar imagen real unificada para generar miniaturas (consistente en los modos MPV y Gallery)
      // El recorte de sprite tiene el problema de cálculo impreciso de tileH que causa desplazamiento hacia arriba, simplemente omitirlo
      loadFullThumbnail(thumb, imageData, pageNum, idx, title, containerW, containerH);
    }
    
    // Extraer la lógica de carga de imagen completa original como función independiente
    function loadFullThumbnail(thumb, imageData, pageNum, idx, title, containerW, containerH) {
      // Modo Gallery: usar fetchPageImageUrl para obtener URL de página individual
      let imageUrlPromise;
      if (window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled) {
        const fetchFn = window.__ehGalleryBootstrap.fetchPageImageUrl;
        if (!fetchFn) {
          console.warn('[EH Modern Reader] fetchPageImageUrl not available');
          thumb.innerHTML = `<div class="eh-thumbnail-number">${pageNum}</div>`;
          return;
        }
        
        imageUrlPromise = fetchFn(idx)
          .then((pageData) => {
            const pageUrl = pageData && pageData.pageUrl;
            const isDirectImageUrl = typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl) && /\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#].*)?$/i.test(pageUrl);
            if (isDirectImageUrl) {
              const entry = window.__ehReaderData && window.__ehReaderData.imagelist
                ? window.__ehReaderData.imagelist[idx]
                : null;
              const candidates = [pageUrl].concat(entry && Array.isArray(entry.altUrls) ? entry.altUrls : []);

              let p = Promise.reject(new Error('init'));
              candidates.forEach((candidate) => {
                if (!candidate) return;
                p = p.catch(() => new Promise((resolve, reject) => {
                  const probe = new Image();
                  probe.onload = () => resolve(candidate);
                  probe.onerror = () => reject(new Error(`thumbnail direct url failed: ${candidate}`));
                  probe.src = candidate;
                }));
              });

              return p.then((okUrl) => {
                if (entry) entry.url = okUrl;
                return okUrl;
              });
            }
            return fetchRealImageUrlAndToken(pageUrl, new AbortController().signal)
              .then(res => res && res.url);
          });
      } else {
        // Modo MPV: usar ensureRealImageUrl
        imageUrlPromise = ensureRealImageUrl(idx).then(({ url }) => url);
      }

      // Usar imagen real para generar miniatura
      imageUrlPromise
        .then(url => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            // 🎯 Usar decode() para decodificar en segundo plano, evitar bloqueo del hilo principal
            if (typeof img.decode === 'function') {
              img.decode().then(() => resolve(img)).catch(() => resolve(img));
            } else {
              resolve(img);
            }
          };
          img.onerror = (e) => reject(e);
          img.src = url;
        }))
        .then((img) => {
          const iw = img.naturalWidth || img.width;
          const ih = img.naturalHeight || img.height;
          const scale = Math.min(containerW / iw, containerH / ih);
          const dw = Math.max(1, Math.floor(iw * scale));
          const dh = Math.max(1, Math.floor(ih * scale));
          const dx = Math.floor((containerW - dw) / 2);
          const dy = Math.floor((containerH - dh) / 2);

          const canvas = document.createElement('canvas');
          canvas.width = containerW;
          canvas.height = containerH;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0,0,containerW,containerH);
          ctx.drawImage(img, dx, dy, dw, dh);

          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Page ${pageNum}: ${title}`);
          canvas.style.display = 'block';

          // Eliminar marcador de posición y fondo, insertar miniatura final
          thumb.style.background = 'none';
          thumb.replaceChildren();
          thumb.appendChild(canvas);
          const badge = document.createElement('div');
          badge.className = 'eh-thumbnail-number';
          badge.textContent = String(pageNum);
          thumb.appendChild(badge);
        })
        .catch(err => {
          console.warn('[EH Modern Reader] Error al cargar miniatura (imagen real):', err);
          thumb.style.background = 'none';
          thumb.replaceChildren();
          thumb.innerHTML = `<div class=\"eh-thumbnail-number\">${pageNum}</div>`;
        });
    }

    // Escucha de eventos
    if (elements.prevBtn) {
      elements.prevBtn.onclick = () => {
        // Lectura invertida: el botón prev está visualmente a la derecha, debe ir hacia atrás lógicamente (número mayor)
        const direction = state.settings.reverse ? 1 : -1;
        let target = state.currentPage + direction;
        
  // Cambio de página en modo de página única normal

        if (target < 1 || target > state.pageCount) return;
        scheduleShowPage(target, { immediate: true });
      };
    }

    if (elements.nextBtn) {
      elements.nextBtn.onclick = () => {
        // Lectura invertida: el botón next está visualmente a la izquierda, debe ir hacia adelante lógicamente (número menor)
        const direction = state.settings.reverse ? -1 : 1;
        let target = state.currentPage + direction;
        
  // Cambio de página en modo de página única normal

        if (target < 1 || target > state.pageCount) return;
        scheduleShowPage(target, { immediate: true });
      };
    }

    if (elements.closeBtn) {
      elements.closeBtn.onclick = () => {
        if (pageData.gallery_url) {
          try {
            const target = new URL(pageData.gallery_url, window.location.origin);
            const current = new URL(window.location.href);

            // Al iniciar el lector desde la página de detalles de la galería, la URL objetivo puede ser completamente igual a la actual;
            // En ese caso, asignar href directamente no activará la navegación, es necesario forzar la recarga para restaurar la página original.
            if (target.href === current.href) {
              window.location.reload();
              return;
            }
          } catch {}

          window.location.href = pageData.gallery_url;
        } else {
          window.history.back();
        }
      };
    }

    // Hacer clic en las áreas izquierda/derecha de la imagen para cambiar de página (aplica a todos los modos)
    if (elements.viewer) {
      elements.viewer.onclick = (e) => {
        // Si el arrastre acaba de terminar, ignorar este evento click (prevenir el cambio de menú tras arrastre)
        if (pageSlider.justDragged) {
          e.stopPropagation();
          return;
        }
        
        // Excluir clics en botones, miniaturas, barra de progreso
        if (e.target.tagName === 'BUTTON' || 
            e.target.closest('button') || 
            e.target.closest('#eh-bottom-menu')) {
          return;
        }
        
        // Obtener posición del clic
        const rect = elements.viewer.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const viewerWidth = rect.width;
        
        const leftThreshold = viewerWidth / 3;
        const rightThreshold = viewerWidth * 2 / 3;
        
        // Área central 1/3: alternar visibilidad de la barra superior y menú inferior (común a todos los modos)
        if (clickX >= leftThreshold && clickX <= rightThreshold) {
          const header = document.getElementById('eh-header');
          const main = document.getElementById('eh-main');
          const bottom = elements.bottomMenu;
          if (header) {
            const isHidden = header.classList.toggle('eh-hidden');
            // Ajustar padding del main en sincronía
            if (main) {
              main.classList.toggle('eh-fullheight', isHidden);
            }
            // Sincronizar mostrar/ocultar menú inferior
            if (bottom) {
              if (isHidden) bottom.classList.add('eh-menu-hidden');
              else bottom.classList.remove('eh-menu-hidden');
            }
            debugLog('[EH Modern Reader] Estado de visibilidad de barra superior/inferior:', !isHidden);
          }
          e.stopPropagation();
          return;
        }
        
        // En todos los modos, las áreas izquierda/derecha cambian directamente de página (en modo horizontal continuo, desplazar al centro de la página adyacente)
        let direction = 0;
        if (clickX < leftThreshold) {
          // Clic en la izquierda: en modo invertido ir hacia atrás (+1), normalmente hacia adelante (-1)
          direction = state.settings.reverse ? 1 : -1;
        } else if (clickX > rightThreshold) {
          // Clic en la derecha: en modo invertido ir hacia adelante (-1), normalmente hacia atrás (+1)
          direction = state.settings.reverse ? -1 : 1;
        } else {
          return;
        }
        
        let target = state.currentPage + direction;
        
        // Lógica de cambio de página (en modo horizontal continuo, scheduleShowPage maneja el centrado)
        
        if (target < 1 || target > state.pageCount) return;
        scheduleShowPage(target);
        e.stopPropagation();
      };
    }

    // 🎯 Sistema de arrastre tipo cuentas para cambio de página (modo de página única)
    // Referencia al PhotoViewGallery de JHenTai - las imágenes anteriores y siguientes están encadenadas como cuentas
    const pageSlider = {
      // Elementos DOM
      slider: null,
      track: null,
      slides: { prev: null, current: null, next: null },
      images: { prev: null, current: null, next: null },
      
      // Estado
      isDragging: false,
      isAnimating: false,
      justDragged: false,  // Arrastre recién terminado, para bloquear eventos click
      startX: 0,
      startY: 0,
      currentOffset: 0,  // Desplazamiento actual del arrastre (píxeles)
      startTime: 0,
      velocityX: 0,
      velocityY: 0,
      lastMoveTime: 0,
      lastMoveX: 0,
      lastMoveY: 0,
      baseOffset: 0,     // Desplazamiento base (para calcular porcentaje)

      // Configuración
      threshold: 0.15,         // Umbral de cambio de página (relativo a la proporción ancho/alto del contenedor)
      velocityThreshold: 0.5,  // Umbral de velocidad (píxeles/milisegundo)
      elasticity: 0.25,        // Coeficiente de elasticidad de borde
      animDuration: 280,       // Duración de animación (milisegundos)

      // Inicialización
      init() {
        this.slider = document.getElementById('eh-page-slider');
        this.track = document.getElementById('eh-page-track');
        if (!this.slider || !this.track) return false;
        
        this.slides.prev = this.track.querySelector('[data-slide="prev"]');
        this.slides.current = this.track.querySelector('[data-slide="current"]');
        this.slides.next = this.track.querySelector('[data-slide="next"]');
        
        this.images.prev = this.slides.prev?.querySelector('.eh-slide-image');
        this.images.current = this.slides.current?.querySelector('#eh-current-image');
        this.images.next = this.slides.next?.querySelector('.eh-slide-image');
        
        return true;
      },
      
      // Determinar si el modo actual es de página única
      isSinglePageMode() {
        return state.settings.readMode === 'single' || state.settings.readMode === 'single-vertical';
      },
      
      // Determinar si es modo de página única horizontal
      isHorizontalMode() {
        return state.settings.readMode === 'single';
      },
      
      // Actualizar dirección del carril deslizante
      updateTrackDirection() {
        if (!this.track) return;
        if (this.isHorizontalMode()) {
          this.track.classList.remove('eh-track-vertical');
        } else {
          this.track.classList.add('eh-track-vertical');
        }
      },
      
      // Mostrar/ocultar el carril deslizante (oculto en modo continuo)
      setVisible(visible) {
        if (this.slider) {
          this.slider.classList.toggle('eh-slider-hidden', !visible);
        }
      },
      
      // Obtener dimensiones del contenedor
      getContainerSize() {
        if (!this.slider) return { width: 0, height: 0 };
        const rect = this.slider.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
      
      // Actualizar imágenes de páginas adyacentes
      async updateAdjacentImages() {
        const prevIndex = state.currentPage - 2; // 0-based
        const nextIndex = state.currentPage;     // 0-based (la página actual es currentPage-1)

        // Actualizar imagen de la página anterior
        if (this.images.prev) {
          if (prevIndex >= 0) {
            const cached = state.imageCache.get(prevIndex);
            if (cached && cached.status === 'loaded' && cached.img?.src) {
              this.images.prev.src = cached.img.src;
            } else {
              // Intentar cargar
              try {
                const img = await loadImage(prevIndex);
                if (img?.src) this.images.prev.src = img.src;
              } catch {
                this.images.prev.src = '';
              }
            }
          } else {
            this.images.prev.src = '';
          }
        }
        
        // Actualizar imagen de la página siguiente
        if (this.images.next) {
          if (nextIndex < state.pageCount) {
            const cached = state.imageCache.get(nextIndex);
            if (cached && cached.status === 'loaded' && cached.img?.src) {
              this.images.next.src = cached.img.src;
            } else {
              // Intentar cargar
              try {
                const img = await loadImage(nextIndex);
                if (img?.src) this.images.next.src = img.src;
              } catch {
                this.images.next.src = '';
              }
            }
          } else {
            this.images.next.src = '';
          }
        }
      },
      
      // Restablecer la posición del carril deslizante al centro
      resetPosition(instant = false) {
        if (!this.track) return;
        const isHorizontal = this.isHorizontalMode();
        
        if (instant) {
          this.track.style.transition = 'none';
        } else {
          this.track.style.transition = '';
        }
        
        this.track.style.transform = isHorizontal 
          ? 'translateX(-33.333%)' 
          : 'translateY(-33.333%)';
        this.currentOffset = 0;
        
        if (instant) {
          // Forzar redibujado y luego restaurar transition
          this.track.offsetHeight;
          this.track.style.transition = '';
        }
      },
      
      // Establecer desplazamiento de arrastre
      setDragOffset(offsetPx) {
        if (!this.track) return;
        const size = this.getContainerSize();
        const mainSize = this.isHorizontalMode() ? size.width : size.height;
        if (mainSize === 0) return;
        
        // Calcular desplazamiento en porcentaje (relativo al ancho total del carril = 3 * ancho del contenedor)
        const trackSize = mainSize * 3;
        const offsetPercent = (offsetPx / trackSize) * 100;

        // La posición base es -33.333% (página central)
        const totalPercent = -33.333 + offsetPercent;
        
        this.track.style.transition = 'none';
        this.track.style.transform = this.isHorizontalMode()
          ? `translateX(${totalPercent}%)`
          : `translateY(${totalPercent}%)`;
        this.currentOffset = offsetPx;
      },
      
      // Animar a la posición especificada
      animateTo(targetPercent, duration, callback) {
        if (!this.track) return;
        
        this.isAnimating = true;
        this.track.style.transition = `transform ${duration}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
        this.track.style.transform = this.isHorizontalMode()
          ? `translateX(${targetPercent}%)`
          : `translateY(${targetPercent}%)`;
        
        setTimeout(() => {
          this.isAnimating = false;
          if (callback) callback();
        }, duration);
      },
      
      // Animación de rebote
      animateBounceBack(callback) {
        if (!this.track) return;
        
        this.isAnimating = true;
        this.track.style.transition = 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)';
        this.track.style.transform = this.isHorizontalMode()
          ? 'translateX(-33.333%)'
          : 'translateY(-33.333%)';
        
        setTimeout(() => {
          this.isAnimating = false;
          this.currentOffset = 0;
          this.track.style.transition = '';
          if (callback) callback();
        }, 200);
      }
    };
    
    // Inicializar el carril deslizante de cuentas
    pageSlider.init();
    
    if (elements.viewer && pageSlider.slider) {
      // Inicio de toque/mouse
      const handleDragStart = (clientX, clientY, e) => {
        // Excluir botones, menús y otros elementos
        if (e.target.tagName === 'BUTTON' || 
            e.target.closest('button') || 
            e.target.closest('#eh-bottom-menu') ||
            e.target.closest('#eh-thumbnails-container') ||
            e.target.closest('.eh-slider-container')) {
          return false;
        }
        
        // Verificar si la posición de clic está en el 1/3 central (para alternar el menú)
        const rect = elements.viewer.getBoundingClientRect();
        const relX = clientX - rect.left;
        pageSlider.isInCenterZone = (relX >= rect.width / 3 && relX <= rect.width * 2 / 3);
        
        // No procesar en modo no de página única
        if (!pageSlider.isSinglePageMode()) return false;

        // No procesar si la animación está en curso
        if (pageSlider.isAnimating) return false;
        
        pageSlider.isDragging = true;
        pageSlider.startX = clientX;
        pageSlider.startY = clientY;
        pageSlider.currentOffset = 0;
        pageSlider.startTime = performance.now();
        pageSlider.lastMoveTime = pageSlider.startTime;
        pageSlider.lastMoveX = clientX;
        pageSlider.lastMoveY = clientY;
        pageSlider.velocityX = 0;
        pageSlider.velocityY = 0;
        
        // Precargar imágenes de páginas adyacentes
        pageSlider.updateAdjacentImages();
        
        return true;
      };
      
      // Movimiento de toque/mouse
      const handleDragMove = (clientX, clientY, e) => {
        if (!pageSlider.isDragging || !pageSlider.isSinglePageMode()) return;
        
        const now = performance.now();
        const dt = now - pageSlider.lastMoveTime;
        
        // Calcular desplazamiento
        const deltaX = clientX - pageSlider.startX;
        const deltaY = clientY - pageSlider.startY;

        // Determinar la dirección principal
        const isHorizontal = pageSlider.isHorizontalMode();
        const mainDelta = isHorizontal ? deltaX : deltaY;
        const crossDelta = isHorizontal ? deltaY : deltaX;
        
        // Si el movimiento en la dirección cruzada es mayor, cancelar el arrastre
        if (Math.abs(crossDelta) > Math.abs(mainDelta) * 1.5 && Math.abs(crossDelta) > 20) {
          if (Math.abs(mainDelta) < 30) {
            pageSlider.isDragging = false;
            pageSlider.resetPosition(true);
            return;
          }
        }
        
        // Calcular velocidad
        if (dt > 0) {
          pageSlider.velocityX = (clientX - pageSlider.lastMoveX) / dt;
          pageSlider.velocityY = (clientY - pageSlider.lastMoveY) / dt;
        }
        pageSlider.lastMoveTime = now;
        pageSlider.lastMoveX = clientX;
        pageSlider.lastMoveY = clientY;
        
        // Calcular desplazamiento con elasticidad
        let displayDelta = mainDelta;

        // Verificar si se ha alcanzado el límite
        const canGoPrev = state.currentPage > 1;
        const canGoNext = state.currentPage < state.pageCount;
        const isReverse = state.settings.reverse;
        
        // Determinar la dirección de cambio de página correspondiente a la dirección de deslizamiento
        let wouldGoPrev, wouldGoNext;
        if (isHorizontal) {
          wouldGoPrev = isReverse ? (mainDelta < 0) : (mainDelta > 0);
          wouldGoNext = isReverse ? (mainDelta > 0) : (mainDelta < 0);
        } else {
          wouldGoPrev = mainDelta > 0;
          wouldGoNext = mainDelta < 0;
        }
        
        // Elasticidad de borde
        if ((wouldGoPrev && !canGoPrev) || (wouldGoNext && !canGoNext)) {
          displayDelta = mainDelta * pageSlider.elasticity;
        }

        // Aplicar desplazamiento al carril deslizante
        pageSlider.setDragOffset(displayDelta);

        // Prevenir comportamiento predeterminado
        if (Math.abs(mainDelta) > 10) {
          e.preventDefault();
        }
      };
      
      // Fin de toque/ratón
      const handleDragEnd = (clientX, clientY, e) => {
        if (!pageSlider.isDragging) return;
        
        pageSlider.isDragging = false;
        
        if (!pageSlider.isSinglePageMode()) {
          pageSlider.resetPosition(true);
          return;
        }
        
        const isHorizontal = pageSlider.isHorizontalMode();
        const size = pageSlider.getContainerSize();
        const mainSize = isHorizontal ? size.width : size.height;
        const mainDelta = pageSlider.currentOffset;
        const mainVelocity = isHorizontal ? pageSlider.velocityX : pageSlider.velocityY;
        
        // Determinar si es un toque leve en la zona central (para alternar el menú)
        const totalMove = Math.max(
          Math.abs(clientX - pageSlider.startX),
          Math.abs(clientY - pageSlider.startY)
        );
        
        if (totalMove < 15 && pageSlider.isInCenterZone) {
          // Esto es un clic, restaurar posición
          pageSlider.animateBounceBack();
          return;
        }
        
        // Determinar si se debe cambiar página (basado en proporción de desplazamiento o velocidad)
        const ratio = Math.abs(mainDelta) / mainSize;
        const shouldFlip = ratio > pageSlider.threshold || 
                          Math.abs(mainVelocity) > pageSlider.velocityThreshold;
        
        // Determinar la dirección del cambio de página
        let direction = 0;
        if (shouldFlip && Math.abs(mainDelta) > 5) {
          const isReverse = state.settings.reverse;
          if (isHorizontal) {
            if (mainDelta > 0) {
              direction = isReverse ? 1 : -1;
            } else {
              direction = isReverse ? -1 : 1;
            }
          } else {
            direction = mainDelta > 0 ? -1 : 1;
          }
        }
        
        // Verificar límites
        const targetPage = state.currentPage + direction;
        const canFlip = targetPage >= 1 && targetPage <= state.pageCount;

        if (canFlip && direction !== 0) {
          // Cambiar página: deslizar hasta la posición objetivo
          // direction = -1 (página anterior): carril se mueve derecha/abajo, muestra prev -> objetivo es 0%
          // direction = +1 (página siguiente): carril se mueve izquierda/arriba, muestra next -> objetivo es -66.666%
          const targetPercent = direction < 0 ? 0 : -66.666;

          // Establecer justDragged para bloquear eventos click posteriores
          pageSlider.justDragged = true;
          setTimeout(() => { pageSlider.justDragged = false; }, 50);
          
          pageSlider.animateTo(targetPercent, pageSlider.animDuration, async () => {
            // 🎯 Restablecer estado de zoom de imagen (igual que el comportamiento de scheduleShowPage)
            resetImageZoom();

            // 🎯 Corrección clave: copiar primero la imagen del slide objetivo al slide actual
            // Usar decode() para asegurar que la imagen esté decodificada antes de restablecer la posición, evitar saltos de tamaño
            const sourceSlide = direction < 0 ? pageSlider.images.prev : pageSlider.images.next;
            if (sourceSlide && sourceSlide.src && pageSlider.images.current) {
              pageSlider.images.current.src = sourceSlide.src;
              
              // Esperar a que la imagen esté decodificada (máximo 100ms para evitar bloqueos)
              try {
                await Promise.race([
                  pageSlider.images.current.decode(),
                  new Promise(resolve => setTimeout(resolve, 100))
                ]);
              } catch {
                // Si falla la decodificación, continuar de todas formas para no bloquear
              }
            }
            
            // Restablecer el carril al centro (instantáneo) - en este punto current ya es la nueva imagen y está decodificada
            pageSlider.resetPosition(true);

            // Actualizar state y UI (sin recargar la imagen actual, ya se estableció arriba)
            state.currentPage = targetPage;
            if (elements.pageInfo) elements.pageInfo.textContent = `${targetPage} / ${state.pageCount}`;
            updateThumbnailHighlight(targetPage);
            
            // Activar precarga de páginas adyacentes
            enqueuePrefetch([targetPage - 2, targetPage], false);

            // Actualizar imágenes adyacentes (prepararse para el siguiente cambio de página)
            pageSlider.updateAdjacentImages();
            debugLog('[EH Modern Reader] Cambio de página en cadena:', direction > 0 ? 'página siguiente' : 'página anterior', '-> página', targetPage);
          });
        } else {
          // Rebote: también establecer justDragged para bloquear el cambio de menú (si hubo movimiento notable)
          if (totalMove > 15) {
            pageSlider.justDragged = true;
            setTimeout(() => { pageSlider.justDragged = false; }, 50);
          }
          pageSlider.animateBounceBack();
        }
      };
      
      // Eventos táctiles
      elements.viewer.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        handleDragStart(touch.clientX, touch.clientY, e);
      }, { passive: true });
      
      elements.viewer.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        handleDragMove(touch.clientX, touch.clientY, e);
      }, { passive: false });
      
      elements.viewer.addEventListener('touchend', (e) => {
        const touch = e.changedTouches[0];
        handleDragEnd(touch.clientX, touch.clientY, e);
      }, { passive: true });
      
      elements.viewer.addEventListener('touchcancel', (e) => {
        if (pageSlider.isDragging) {
          pageSlider.isDragging = false;
          pageSlider.animateBounceBack();
        }
      }, { passive: true });
      
      // Eventos de ratón (compatibilidad con escritorio)
      let isMouseDragging = false;
      
      elements.viewer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (handleDragStart(e.clientX, e.clientY, e)) {
          isMouseDragging = true;
          e.preventDefault();
        }
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isMouseDragging) return;
        handleDragMove(e.clientX, e.clientY, e);
      });
      
      document.addEventListener('mouseup', (e) => {
        if (!isMouseDragging) return;
        isMouseDragging = false;
        handleDragEnd(e.clientX, e.clientY, e);
      });
    }

    // Cambio de ícono de tema (oscuro: luna; claro: sol)
  // Ícono de sol estilo Feather (MIT), más limpio, coherente con el estilo de trazado existente
  const SUN_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#000">\
<circle cx="12" cy="12" r="5"/>\
<line x1="12" y1="1" x2="12" y2="3"/>\
<line x1="12" y1="21" x2="12" y2="23"/>\
<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>\
<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>\
<line x1="1" y1="12" x2="3" y2="12"/>\
<line x1="21" y1="12" x2="23" y2="12"/>\
<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>\
<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>\
</svg>';
    const MOON_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

    function updateThemeIcon() {
      if (!elements.themeBtn) return;
      const iconHtml = document.body.classList.contains('eh-dark-mode') ? MOON_ICON : SUN_ICON;
      elements.themeBtn.innerHTML = iconHtml;
    }

    if (elements.themeBtn) {
      elements.themeBtn.onclick = () => {
        state.settings.darkMode = !state.settings.darkMode;
        document.body.classList.toggle('eh-dark-mode');
        updateThemeIcon();
      };
    }

    if (elements.fullscreenBtn) {
      elements.fullscreenBtn.onclick = () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen();
        } else {
          document.exitFullscreen();
        }
      };
    }
    // Función de avance de página programado
    function updateAutoButtonVisual() {
      if (!elements.autoBtn) return;
      elements.autoBtn.classList.toggle('eh-active', state.autoPage.running);
      const inContinuousScroll = state.settings && (state.settings.readMode === 'continuous-horizontal' || state.settings.readMode === 'continuous-vertical');
      if (state.autoPage.running) {
        if (inContinuousScroll) {
          const spd = state.autoPage.scrollSpeed || 3;
          elements.autoBtn.title = `Desplazamiento automático (${spd}px/fotograma) - clic para detener, Alt+clic para ajustar velocidad`;
        } else {
          elements.autoBtn.title = `Avance automático (${Math.round(state.autoPage.intervalMs/1000)}s) - clic para detener, Alt+clic para ajustar intervalo`;
        }
      } else {
        elements.autoBtn.title = inContinuousScroll
          ? 'Desplazamiento automático (clic para iniciar, Alt+clic para ajustar velocidad)'
          : 'Avance automático (clic para iniciar, Alt+clic para ajustar intervalo)';
      }
    }
    function stopAutoPaging() {
      if (state.autoPage.timer) {
        if (typeof state.autoPage.timer === 'object' && state.autoPage.timer.rafId) {
          cancelAnimationFrame(state.autoPage.timer.rafId);
        } else {
          clearInterval(state.autoPage.timer);
        }
      }
      state.autoPage.timer = null;
      state.autoPage.running = false;
      // 🎯 Liberar bloqueo de diseño
      autoScrollLockLayout = false;
      updateAutoButtonVisual();

      // 🎯 Al detener, disparar un evento de scroll para actualizar página/barra de progreso
      const container = document.getElementById('eh-continuous-horizontal') || document.getElementById('eh-continuous-vertical');
      if (container) {
        container.dispatchEvent(new Event('scroll'));
      }
    }
    // 🎯 Bandera para bloquear actualización de diseño durante desplazamiento automático (evita saltos por cambios de aspect-ratio)
    let autoScrollLockLayout = false;
    
    function startAutoPaging() {
      stopAutoPaging();
      state.autoPage.running = true;
      // Modo continuo horizontal/vertical: cambiar a desplazamiento automático continuo
      const horizontalContainer = (state.settings && state.settings.readMode === 'continuous-horizontal')
        ? document.getElementById('eh-continuous-horizontal')
        : null;
      const verticalContainer = (state.settings && state.settings.readMode === 'continuous-vertical')
        ? document.getElementById('eh-continuous-vertical')
        : null;
      if (horizontalContainer || verticalContainer) {
        state.autoPage.scrollSpeed = state.autoPage.scrollSpeed || 3; // px/fotograma, admite decimales

        // 🎯 Activar bloqueo de diseño: no actualizar aspect-ratio durante el scroll
        autoScrollLockLayout = true;

        // 🎯 Desplazamiento suave: usar acumulador para precisión subpíxel, evitar saltos
        let scrollAccumulator = 0;
        let lastTimestamp = 0;
        
        // 🎯 Buffer de precarga: precargar imágenes delante más agresivamente durante el desplazamiento automático
        const prefetchAheadForAutoScroll = () => {
          const container = horizontalContainer || verticalContainer;
          if (!container) return;
          
          // Encontrar el número de página en el centro del viewport actual
          const isHorizontal = !!horizontalContainer;
          const scrollPos = isHorizontal ? container.scrollLeft : container.scrollTop;
          const viewportSize = isHorizontal ? container.clientWidth : container.clientHeight;
          const centerPos = scrollPos + viewportSize / 2;
          
          // Precargar página actual + 8 páginas adelante
          const indices = [];
          for (let i = 0; i < state.pageCount; i++) {
            const wrapper = container.querySelector(`[data-page-index="${i}"]`)?.closest('.eh-ch-wrapper, .eh-cv-wrapper');
            if (!wrapper) continue;
            const wrapperStart = isHorizontal ? wrapper.offsetLeft : wrapper.offsetTop;
            const wrapperEnd = wrapperStart + (isHorizontal ? wrapper.offsetWidth : wrapper.offsetHeight);
            // Precargar todas las imágenes dentro de 2000px delante del viewport
            if (wrapperStart > scrollPos - 500 && wrapperStart < scrollPos + viewportSize + 2000) {
              if (!state.imageCache.has(i) || state.imageCache.get(i).status !== 'loaded') {
                indices.push(i);
              }
            }
          }
          if (indices.length > 0) {
            enqueuePrefetch(indices.slice(0, 8), true); // Máximo 8, alta prioridad
          }
        };
        
        // Precargar inmediatamente al iniciar
        prefetchAheadForAutoScroll();
        let prefetchCounter = 0;
        
        const step = (timestamp) => {
          if (!state.autoPage.running) return;
          
          // 🎯 Usar deltaTime para desplazamiento suave independiente de la tasa de fotogramas
          if (lastTimestamp === 0) lastTimestamp = timestamp;
          const deltaTime = Math.min(timestamp - lastTimestamp, 50); // Limitar el salto máximo (evitar saltos grandes al cambiar de pestaña)
          lastTimestamp = timestamp;

          // Velocidad objetivo: scrollSpeed px/fotograma @ 60fps = scrollSpeed * 60 px/segundo
          // Movimiento real por fotograma: speed * deltaTime / 16.67
          const pixelsPerMs = (state.autoPage.scrollSpeed * 60) / 1000;
          scrollAccumulator += pixelsPerMs * deltaTime;
          
          // Solo desplazar cuando se acumule al menos 1 píxel (evitar saltos subpíxel)
          const scrollAmount = Math.floor(scrollAccumulator);
          if (scrollAmount >= 1) {
            scrollAccumulator -= scrollAmount;
            
            if (horizontalContainer) {
              horizontalContainer.scrollLeft += scrollAmount;
              const atEnd = horizontalContainer.scrollLeft + horizontalContainer.clientWidth >= horizontalContainer.scrollWidth - 2;
              if (atEnd) {
                stopAutoPaging();
                return;
              }
            } else if (verticalContainer) {
              verticalContainer.scrollTop += scrollAmount;
              const atEnd = verticalContainer.scrollTop + verticalContainer.clientHeight >= verticalContainer.scrollHeight - 2;
              if (atEnd) {
                stopAutoPaging();
                return;
              }
            }
            
            // 🎯 Activar verificación de precarga cada ~100px de desplazamiento
            prefetchCounter += scrollAmount;
            if (prefetchCounter > 100) {
              prefetchCounter = 0;
              prefetchAheadForAutoScroll();
            }
          }
          
          state.autoPage.timer.rafId = requestAnimationFrame(step);
        };
        state.autoPage.timer = { rafId: requestAnimationFrame(step) };
      } else {
        // Avance automático de página única: incremento lógico (1→N), la lectura inversa solo cambia la semántica de interacción
        state.autoPage.timer = setInterval(() => {
          const next = state.currentPage + 1;
          if (next > state.pageCount) {
            stopAutoPaging();
          } else if (next >= 1) {
            scheduleShowPage(next);
          }
        }, state.autoPage.intervalMs);
      }
      updateAutoButtonVisual();
    }
    if (elements.autoBtn) {
      elements.autoBtn.onclick = (e) => {
        if (e.altKey) {
          const inContinuousScroll = state.settings && (state.settings.readMode === 'continuous-horizontal' || state.settings.readMode === 'continuous-vertical');
          if (inContinuousScroll) {
            const val = prompt('Configurar velocidad de desplazamiento automático (px/fotograma, admite decimales, recomendado 2~10)', String(state.autoPage.scrollSpeed || 3));
            if (val) {
              const spd = Math.max(0.1, Math.min(100, parseFloat(val)));
              if (!isNaN(spd)) {
                state.autoPage.scrollSpeed = spd;
                // Sincronizar con el panel de configuración
                if (elements.scrollSpeedInput) elements.scrollSpeedInput.value = spd;
                if (state.autoPage.running) startAutoPaging(); else updateAutoButtonVisual();
              }
            }
          } else {
            const val = prompt('Configurar intervalo de cambio de página (segundos, admite decimales)', String((state.autoPage.intervalMs/1000).toFixed(2)));
            if (val) {
              const sec = Math.max(0.1, Math.min(120, parseFloat(val)));
              if (!isNaN(sec)) {
                state.autoPage.intervalMs = Math.round(sec * 1000);
                // Sincronizar con el panel de configuración
                if (elements.autoIntervalInput) elements.autoIntervalInput.value = sec;
                if (state.autoPage.running) startAutoPaging(); else updateAutoButtonVisual();
              }
            }
          }
        } else {
          if (state.autoPage.running) stopAutoPaging(); else startAutoPaging();
        }
      };
      updateAutoButtonVisual();
    }

    // Botón y panel de configuración
    if (elements.settingsBtn) {
      elements.settingsBtn.onclick = () => {
        debugLog('[EH Modern Reader] Clic en botón de configuración');
        if (elements.settingsPanel) {
          elements.settingsPanel.classList.toggle('eh-hidden');
          debugLog('[EH Modern Reader] Estado de visibilidad del panel de configuración:', !elements.settingsPanel.classList.contains('eh-hidden'));
        }
      };
    }

    // Botón de cierre del panel de configuración
    if (elements.settingsCloseBtn) {
      elements.settingsCloseBtn.onclick = () => {
        if (elements.settingsPanel) {
          elements.settingsPanel.classList.add('eh-hidden');
        }
      };
    }
    
    // Botón de restaurar configuración predeterminada
    if (elements.resetSettingsBtn) {
      elements.resetSettingsBtn.onclick = () => {
        if (confirm('¿Restaurar toda la configuración a los valores predeterminados?')) {
          // Restaurar valores predeterminados
          state.settings.prefetchAhead = DEFAULT_SETTINGS.prefetchAhead;
          state.autoPage.intervalMs = DEFAULT_SETTINGS.autoIntervalMs;
          state.autoPage.scrollSpeed = DEFAULT_SETTINGS.scrollSpeed;
          state.settings.verticalSidePadding = DEFAULT_SETTINGS.verticalSidePadding;
          state.settings.horizontalGap = DEFAULT_SETTINGS.horizontalGap;
          state.settings.verticalGap = DEFAULT_SETTINGS.verticalGap;
          state.settings.readMode = DEFAULT_SETTINGS.readMode;
          state.settings.reverse = DEFAULT_SETTINGS.reverse;
          
          // Actualizar UI
          if (elements.preloadCountInput) {
            elements.preloadCountInput.value = DEFAULT_SETTINGS.prefetchAhead;
            if (elements.preloadCountValue) elements.preloadCountValue.textContent = DEFAULT_SETTINGS.prefetchAhead;
          }
          if (elements.autoIntervalInput) {
            elements.autoIntervalInput.value = DEFAULT_SETTINGS.autoIntervalMs / 1000;
            if (elements.autoIntervalValue) elements.autoIntervalValue.textContent = (DEFAULT_SETTINGS.autoIntervalMs / 1000).toFixed(1);
          }
          if (elements.scrollSpeedInput) {
            elements.scrollSpeedInput.value = DEFAULT_SETTINGS.scrollSpeed;
            if (elements.scrollSpeedValue) elements.scrollSpeedValue.textContent = DEFAULT_SETTINGS.scrollSpeed.toFixed(1);
          }
          if (elements.verticalPaddingInput) {
            elements.verticalPaddingInput.value = DEFAULT_SETTINGS.verticalSidePadding;
            if (elements.verticalPaddingValue) elements.verticalPaddingValue.textContent = DEFAULT_SETTINGS.verticalSidePadding;
          }
          if (elements.horizontalGapInput) {
            elements.horizontalGapInput.value = DEFAULT_SETTINGS.horizontalGap;
            if (elements.horizontalGapValue) elements.horizontalGapValue.textContent = DEFAULT_SETTINGS.horizontalGap;
          }
          if (elements.verticalGapInput) {
            elements.verticalGapInput.value = DEFAULT_SETTINGS.verticalGap;
            if (elements.verticalGapValue) elements.verticalGapValue.textContent = DEFAULT_SETTINGS.verticalGap;
          }
          if (elements.readModeRadios) {
            elements.readModeRadios.forEach(radio => {
              radio.checked = (radio.value === DEFAULT_SETTINGS.readMode);
            });
          }
          
          // Aplicar cambio de modo
          if (state.settings.readMode !== DEFAULT_SETTINGS.readMode) {
            const oldMode = state.settings.readMode;
            state.settings.readMode = DEFAULT_SETTINGS.readMode;
            if (oldMode === 'continuous-horizontal' || oldMode === 'continuous-vertical') {
              const singleViewer = document.getElementById('eh-viewer');
              if (singleViewer) singleViewer.style.display = '';
              if (continuous.observer) { continuous.observer.disconnect(); continuous.observer = null; }
              if (continuous.container && continuous.container.parentElement) {
                continuous.container.parentElement.removeChild(continuous.container);
              }
              continuous.container = null;
            }
            scheduleShowPage(state.currentPage, { instant: true });
          }
          
          // Aplicar estado inverso
          applyReverseState();

          // Guardar en localStorage
          saveSettings();

          console.log('[EH Modern Reader] Configuración predeterminada restaurada');
        }
      };
    }

    // Cerrar al hacer clic fuera del panel
    if (elements.settingsPanel) {
      elements.settingsPanel.addEventListener('click', (e) => {
        // Si se hizo clic en la capa de fondo del panel (overlay) y no en el contenido del panel
        if (e.target === elements.settingsPanel) {
          elements.settingsPanel.classList.add('eh-hidden');
        }
      });
    }

    // Interruptor de inversión
    function applyReverseState() {
      try {
        const reversed = !!state.settings.reverse;
        // Dirección del contenedor de miniaturas (usar flex-direction para punto de inicio derecha-izquierda)
        if (elements.thumbnails) {
          elements.thumbnails.style.display = 'flex';
          elements.thumbnails.style.flexDirection = reversed ? 'row-reverse' : 'row';
          // Limpiar cualquier transform residual
          const thumbs = elements.thumbnails.querySelectorAll('.eh-thumbnail');
          thumbs.forEach(t => { t.style.transform = ''; });
        }
        // Invertir también el contenedor continuo horizontal
        const horizontalContainer = document.getElementById('eh-continuous-horizontal');
        if (horizontalContainer) {
          horizontalContainer.style.transform = reversed ? 'scaleX(-1)' : '';
          // También invertir cada wrapper de imagen
          const wrappers = horizontalContainer.querySelectorAll('.eh-ch-wrapper');
          wrappers.forEach(wrapper => {
            wrapper.style.transform = reversed ? 'scaleX(-1)' : '';
          });
        }
        // Invertir también el contenedor continuo vertical
        const verticalContainer = document.getElementById('eh-continuous-vertical');
        if (verticalContainer) {
          verticalContainer.style.transform = reversed ? 'scaleY(-1)' : '';
          const wrappers = verticalContainer.querySelectorAll('.eh-cv-wrapper');
          wrappers.forEach(wrapper => {
            wrapper.style.transform = reversed ? 'scaleY(-1)' : '';
          });
        }
        // Inversión visual de la barra de progreso: usar transform scaleX(-1)
        const track = elements.sliderTrack;
        if (track) {
          if (reversed) {
            track.style.transform = 'scaleX(-1)';
          } else {
            track.style.transform = '';
          }
        }
        // Cambiar posición de números de página en extremos de la barra de progreso
        const progressCurrent = document.getElementById('eh-progress-current');
        const progressTotal = document.getElementById('eh-progress-total');
        const sliderContainer = document.querySelector('.eh-slider-container');
        if (progressCurrent && progressTotal && sliderContainer) {
          if (reversed) {
            // Invertido: total de páginas a la izquierda, página actual a la derecha
            sliderContainer.style.flexDirection = 'row-reverse';
          } else {
            // Normal: página actual a la izquierda, total de páginas a la derecha
            sliderContainer.style.flexDirection = 'row';
          }
        }
        // Si la reproducción automática está en curso, reiniciarla para aplicar la nueva dirección
        if (state.autoPage && state.autoPage.running) {
          startAutoPaging();
        }
        // Actualizar estado del botón
        updateReverseBtn();
      } catch {}
    }
    
    // Evento de clic del botón de inversión
    if (elements.reverseBtn) {
      elements.reverseBtn.onclick = () => {
        state.settings.reverse = !state.settings.reverse;
        applyReverseState();
      };
    }

    // El onchange de la barra de progreso se gestiona en la sección “eventos de arrastre/cambio de barra de progreso” más adelante, para evitar duplicados

    if (elements.pageInput) {
      elements.pageInput.onchange = () => {
        const pageNum = parseInt(elements.pageInput.value);
        if (pageNum >= 1 && pageNum <= state.pageCount) {
          scheduleShowPage(pageNum, { instant: true });
        }
      };
    }

  // Escucha de botones de radio de modo de lectura
    if (elements.readModeRadios && elements.readModeRadios.length > 0) {
      elements.readModeRadios.forEach(radio => {
        radio.onchange = () => {
          if (!radio.checked) return;
          const newMode = radio.value;
          const oldMode = state.settings.readMode;
          if (newMode === oldMode) return;
          
          // 🎯 Guardar número de página actual (referencia: initialIndex = currentImageIndex de JHenTai)
          const savedPage = state.currentPage;
          console.log('[EH Modern Reader] Cambio de modo de lectura:', oldMode, '→', newMode, ', página actual:', savedPage);
          
          state.settings.readMode = newMode;
          
          // Salir del modo anterior - limpiar estado de desplazamiento virtual
          if (oldMode === 'continuous-horizontal' || oldMode === 'continuous-vertical') {
            // Limpiar estado de desplazamiento virtual (sin restablecer state.currentPage)
            if (virtualScroll.enabled) {
              virtualScroll.enabled = false;
              virtualScroll.scrollContainer = null;
              virtualScroll.contentContainer = null;
              virtualScroll.itemsContainer = null;
              virtualScroll.renderedRange = { start: -1, end: -1 };
            }
            if (virtualScrollH.enabled) {
              virtualScrollH.enabled = false;
              virtualScrollH.scrollContainer = null;
              virtualScrollH.contentContainer = null;
              virtualScrollH.itemsContainer = null;
              virtualScrollH.renderedRange = { start: -1, end: -1 };
            }
            
            const singleViewer = document.getElementById('eh-viewer');
            if (singleViewer) singleViewer.style.display = '';
            if (continuous.observer) { continuous.observer.disconnect(); continuous.observer = null; }
            if (continuous.container && continuous.container.parentElement) {
              continuous.container.parentElement.removeChild(continuous.container);
            }
            continuous.container = null;
          }
          
          // 🎯 Restaurar número de página (asegurar que sea correcto antes de entrar al nuevo modo)
          state.currentPage = savedPage;

          // Entrar al nuevo modo
          if (newMode === 'continuous-horizontal') {
            // Ocultar carril de perlas
            if (pageSlider.slider) pageSlider.setVisible(false);
            enterContinuousHorizontalMode();
          } else if (newMode === 'continuous-vertical') {
            // Ocultar carril de perlas
            if (pageSlider.slider) pageSlider.setVisible(false);
            enterContinuousVerticalMode();
          } else {
            const singleViewer = document.getElementById('eh-viewer');
            if (singleViewer) singleViewer.style.display = '';
            // Mostrar carril de perlas y actualizar dirección
            if (pageSlider.slider) {
              pageSlider.setVisible(true);
              pageSlider.updateTrackDirection();
              pageSlider.resetPosition(true);
            }
            // Al cambiar a modo de página única, forzar visualización de la página actual (proveniente del modo continuo state.currentPage)
            console.log('[EH Modern Reader] Cambiando a modo de página única, página actual:', state.currentPage);
            // Llamar directamente a internalShowPage omitiendo el retraso para cargar la página correcta de inmediato
            internalShowPage(state.currentPage, { force: true });
            // Actualizar imágenes de páginas adyacentes
            pageSlider.updateAdjacentImages();
          }
          saveSettings(); // Guardar configuración
        };
      });
    }

    if (elements.preloadCountInput) {
      // Mostrar valor del deslizador en tiempo real
      elements.preloadCountInput.addEventListener('input', () => {
        const v = parseInt(elements.preloadCountInput.value);
        if (!isNaN(v) && elements.preloadCountValue) {
          elements.preloadCountValue.textContent = v;
        }
      });
      // Aplicar configuración
      elements.preloadCountInput.addEventListener('change', () => {
        const v = parseInt(elements.preloadCountInput.value);
        if (!isNaN(v) && v >= 0 && v <= 10) {
          state.settings.prefetchAhead = v;
          preloadAdjacentPages(state.currentPage);
          saveSettings();
        }
      });
    }

    // Deslizador de margen lateral continuo vertical
    if (elements.verticalPaddingInput) {
      // Mostrar valor del deslizador en tiempo real
      elements.verticalPaddingInput.addEventListener('input', () => {
        const v = parseInt(elements.verticalPaddingInput.value);
        if (!isNaN(v) && elements.verticalPaddingValue) {
          elements.verticalPaddingValue.textContent = v;
        }
      });
      // Aplicar configuración (actualización en tiempo real)
      elements.verticalPaddingInput.addEventListener('input', () => {
        const v = parseInt(elements.verticalPaddingInput.value);
        if (!isNaN(v) && v >= 0 && v <= 1000) {
          state.settings.verticalSidePadding = v;
          const verticalContainer = document.getElementById('eh-continuous-vertical');
          if (verticalContainer) {
            const currentPageBefore = state.currentPage;
            
            // 🎯 Detectar si está en modo desplazamiento virtual
            if (virtualScroll.enabled && virtualScroll.scrollContainer) {
              // Modo desplazamiento virtual: actualizar vs.sidePadding y recalcular layout
              virtualScroll.sidePadding = v;
              // Recalcular estabilizando con la página actual como ancla
              virtualScroll.pendingJumpTarget = currentPageBefore - 1;
              // Leer el ancho más reciente del contenedor (cambios de barra de desplazamiento/viewport)
              virtualScroll.containerWidth = virtualScroll.scrollContainer.clientWidth;
              calculateVirtualLayout();
              virtualScroll.contentContainer.style.height = virtualScroll.totalHeight + 'px';

              // Actualizar padding/posición/altura de todas las tarjetas ya renderizadas
              const items = virtualScroll.itemsContainer.querySelectorAll('.eh-virtual-item');
              items.forEach(item => {
                item.style.padding = `0 ${v}px`;
                const idx = parseInt(item.getAttribute('data-virtual-index'));
                if (virtualScroll.itemOffsets[idx] !== undefined) {
                  item.style.top = virtualScroll.itemOffsets[idx] + 'px';
                  item.style.height = virtualScroll.itemHeights[idx] + 'px';
                }
              });
              // Actualizar rango de renderizado inmediatamente, sin esperar evento de scroll
              updateVirtualRendering();
              // Saltar de vuelta a la página actual (pendingJumpTarget ya establecido)
              jumpToVirtualPage(currentPageBefore);
            } else {
              // Modo no virtual: actualizar CSS padding directamente
              const topBottom = 12;
              verticalContainer.style.padding = `${topBottom}px ${v}px`;
              
              // 🎯 Recalcular la altura de todas las imágenes cargadas (porque el ancho disponible cambió)
              const availableWidth = verticalContainer.clientWidth - v * 2;
              verticalContainer.querySelectorAll('.eh-cv-wrapper').forEach(wrap => {
                const ratio = parseFloat(wrap.style.getPropertyValue('--eh-aspect'));
                if (ratio && ratio > 0) {
                  const newHeight = Math.round(availableWidth / ratio);
                  wrap.style.height = newHeight + 'px';
                  const card = wrap.parentElement;
                  if (card) card.style.height = newHeight + 'px';
                }
              });
              
              requestAnimationFrame(() => {
                const targetIdx = currentPageBefore - 1;
                const targetImg = verticalContainer.querySelector(`img[data-page-index="${targetIdx}"]`);
                if (targetImg) {
                  requestAnimationFrame(() => {
                    try {
                      const wrapper = targetImg.closest('.eh-cv-wrapper') || targetImg.parentElement;
                      if (wrapper) {
                        wrapper.scrollIntoView({
                          behavior: 'auto',
                          block: 'center',
                          inline: 'center'
                        });
                      }
                    } catch {}
                  });
                }
              });
            }
          }
          saveSettings();
        }
      });
    }

    // Deslizador de intervalo de cambio de página
    if (elements.autoIntervalInput) {
      // Mostrar valor del deslizador en tiempo real
      elements.autoIntervalInput.addEventListener('input', () => {
        const v = parseFloat(elements.autoIntervalInput.value);
        if (!isNaN(v) && elements.autoIntervalValue) {
          elements.autoIntervalValue.textContent = v.toFixed(1);
        }
      });
      // Aplicar configuración
      elements.autoIntervalInput.addEventListener('change', () => {
        const v = parseFloat(elements.autoIntervalInput.value);
        if (!isNaN(v) && v >= 1 && v <= 60) {
          state.autoPage.intervalMs = Math.round(v * 1000);
          if (state.autoPage.running) {
            startAutoPaging();
          } else {
            updateAutoButtonVisual();
          }
          saveSettings();
        }
      });
    }

    // Deslizador de velocidad de desplazamiento
    if (elements.scrollSpeedInput) {
      // Mostrar valor del deslizador en tiempo real
      elements.scrollSpeedInput.addEventListener('input', () => {
        const v = parseFloat(elements.scrollSpeedInput.value);
        if (!isNaN(v) && elements.scrollSpeedValue) {
          elements.scrollSpeedValue.textContent = v.toFixed(1);
        }
      });
      // Aplicar configuración
      elements.scrollSpeedInput.addEventListener('change', () => {
        const v = parseFloat(elements.scrollSpeedInput.value);
        if (!isNaN(v) && v >= 0.1 && v <= 5) {
          state.autoPage.scrollSpeed = v;
          if (state.autoPage.running && state.settings.readMode.includes('continuous')) {
            startAutoPaging();
          } else {
            updateAutoButtonVisual();
          }
          saveSettings();
        }
      });
    }

    // Deslizador de separación entre imágenes en modo continuo horizontal
    if (elements.horizontalGapInput) {
      elements.horizontalGapInput.addEventListener('input', () => {
        const v = parseInt(elements.horizontalGapInput.value);
        if (!isNaN(v) && elements.horizontalGapValue) {
          elements.horizontalGapValue.textContent = v;
        }
      });
      elements.horizontalGapInput.addEventListener('input', () => {
        const v = parseInt(elements.horizontalGapInput.value);
        if (!isNaN(v) && v >= 0 && v <= 100) {
          state.settings.horizontalGap = v;
          // Manejar desplazamiento virtual horizontal y no virtual por separado
          if (virtualScrollH.enabled && virtualScrollH.scrollContainer) {
            // Actualizar gap del layout virtual y recalcular offsets/ancho total
            virtualScrollH.gap = v;
            calculateVirtualLayoutH();
            if (virtualScrollH.contentContainer) {
              virtualScrollH.contentContainer.style.width = virtualScrollH.totalWidth + 'px';
            }
            // Actualizar posición de elementos ya renderizados
            if (virtualScrollH.itemsContainer) {
              const items = virtualScrollH.itemsContainer.querySelectorAll('.eh-virtual-item-h');
              items.forEach(item => {
                const idx = parseInt(item.getAttribute('data-virtual-index'));
                if (!isNaN(idx) && virtualScrollH.itemOffsets[idx] !== undefined) {
                  item.style.left = virtualScrollH.itemOffsets[idx] + 'px';
                  item.style.width = virtualScrollH.itemWidths[idx] + 'px';
                }
              });
            }
            // Volver a la página actual, mantener vista estable
            jumpToVirtualPageH(state.currentPage);
          } else {
            // No virtual: establecer gap del contenedor directamente
            const horizontalContainer = document.getElementById('eh-continuous-horizontal');
            if (horizontalContainer) {
              horizontalContainer.style.gap = `${v}px`;
            }
          }
          saveSettings();
        }
      });
    }

    // Deslizador de separación entre imágenes en modo continuo vertical
    if (elements.verticalGapInput) {
      elements.verticalGapInput.addEventListener('input', () => {
        const v = parseInt(elements.verticalGapInput.value);
        if (!isNaN(v) && elements.verticalGapValue) {
          elements.verticalGapValue.textContent = v;
        }
      });
      elements.verticalGapInput.addEventListener('input', () => {
        const v = parseInt(elements.verticalGapInput.value);
        if (!isNaN(v) && v >= 0 && v <= 100) {
          state.settings.verticalGap = v;
          const verticalContainer = document.getElementById('eh-continuous-vertical');
          if (verticalContainer) {
            // Con separación cero, quitar borde del esqueleto para ajuste visual completo
            verticalContainer.classList.toggle('eh-no-gap-vertical', v === 0);
            const currentPageBefore = state.currentPage;

            // 🎯 Detectar si está en modo desplazamiento virtual
            if (virtualScroll.enabled && virtualScroll.scrollContainer) {
              // Modo desplazamiento virtual: actualizar vs.gap y recalcular layout
              virtualScroll.gap = v;
              calculateVirtualLayout();
              virtualScroll.contentContainer.style.height = virtualScroll.totalHeight + 'px';

              // Actualizar posición de todas las tarjetas ya renderizadas
              const items = virtualScroll.itemsContainer.querySelectorAll('.eh-virtual-item');
              items.forEach(item => {
                const idx = parseInt(item.getAttribute('data-virtual-index'));
                if (virtualScroll.itemOffsets[idx] !== undefined) {
                  item.style.top = virtualScroll.itemOffsets[idx] + 'px';
                }
              });

              // Saltar de vuelta a la página actual
              jumpToVirtualPage(currentPageBefore);
            } else {
              // Modo no virtual: actualizar CSS gap directamente
              verticalContainer.style.gap = `${v}px`;
            }
          }
          saveSettings();
        }
      });
    }

    // Evento de arrastre/cambio en la barra de progreso
    if (elements.progressBar) {
      let preheatTimer = null;

      // Sincronizar estado de arrastre en tiempo real
      elements.progressBar.oninput = () => {
        const page = parseInt(elements.progressBar.value);
        const idx = page - 1;

        // 1. Actualizar en tiempo real el número de página izquierdo (derecho en modo invertido)
        const progressCurrent = document.getElementById('eh-progress-current');
        if (progressCurrent) {
          progressCurrent.textContent = page;
        }

        // 2. Desplazar miniaturas a la posición correspondiente en tiempo real (deshabilitado durante arrastre para evitar parpadeo)
        if (!state.draggingProgress) {
          const thumbnails = document.querySelectorAll('.eh-thumbnail');
          if (thumbnails && thumbnails.length > 0 && elements.thumbnails) {
            const targetThumb = thumbnails[Math.min(idx, thumbnails.length - 1)];
            if (targetThumb) {
              // Deshabilitar bloqueo de carga diferida para evitar interceptación al desplazar manualmente
              if (thumbnailLoadQueue) {
                thumbnailLoadQueue.isProgrammaticScroll = false;
              }
              targetThumb.scrollIntoView({
                behavior: 'auto',
                block: 'nearest',
                inline: 'center'
              });
            }
          }
        }

        // 3. Preheat diferido de imagen de la página objetivo (para evitar solicitudes frecuentes)
        // Optimización: reducir el retraso de 150ms a 50ms para respuesta inicial más rápida
        if (preheatTimer) clearTimeout(preheatTimer);
        preheatTimer = setTimeout(() => {
          enqueuePrefetch([idx], true); // Preheat de alta prioridad para la página objetivo
          // Preheat simultáneo de páginas adyacentes
          const neighbors = [idx - 1, idx + 1].filter(i => i >= 0 && i < state.pageCount);
          enqueuePrefetch(neighbors, false);
        }, 50);
      };

      // Marcadores de inicio/fin de arrastre
      const markDraggingTrue = () => { state.draggingProgress = true; };
      const markDraggingFalse = () => { state.draggingProgress = false; };
      // Priorizar eventos de puntero, con fallback a ratón/táctil
      elements.progressBar.addEventListener('pointerdown', markDraggingTrue);
      window.addEventListener('pointerup', markDraggingFalse);
      elements.progressBar.addEventListener('mousedown', markDraggingTrue);
      window.addEventListener('mouseup', markDraggingFalse);
      elements.progressBar.addEventListener('touchstart', markDraggingTrue, { passive: true });
      window.addEventListener('touchend', markDraggingFalse, { passive: true });

      elements.progressBar.onchange = (e) => {
        // Saltar a la página objetivo al soltar el ratón
        const imageNum = parseInt(e.target.value);
        scheduleShowPage(imageNum, { instant: true });
        // Finalizar estado de arrastre (algunos navegadores solo disparan change, no pointerup/mouseup)
        state.draggingProgress = false;
      };
    }


    // Desplazamiento horizontal de miniaturas: soporte para rueda del ratón + arrastre (sin inercia)
    if (elements.thumbnails) {
      // Desplazamiento con rueda del ratón
      elements.thumbnails.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          // Aumentar sensibilidad de desplazamiento: factor 2.5
          elements.thumbnails.scrollLeft += e.deltaY * 2.5;
          e.preventDefault();
        }
      }, { passive: false });

      // Desplazamiento por arrastre con ratón (sin inercia, se detiene al soltar)
      const thumbnailDrag = {
        isDragging: false,
        wasDragged: false, // Marcar si ocurrió arrastre real (para distinguir de clic)
        startX: 0,
        startScrollLeft: 0,
        dragThreshold: 5, // Movimiento mayor a 5px se considera arrastre

        onMouseDown(e) {
          if (e.button !== 0) return; // Solo botón izquierdo
          this.isDragging = true;
          this.wasDragged = false;
          this.startX = e.clientX;
          this.startScrollLeft = elements.thumbnails.scrollLeft;
          elements.thumbnails.style.scrollBehavior = 'auto';
          elements.thumbnails.style.cursor = 'grabbing';
        },

        onMouseMove(e) {
          if (!this.isDragging) return;
          const dx = e.clientX - this.startX;

          // Solo contar como arrastre si supera el umbral
          if (Math.abs(dx) > this.dragThreshold) {
            this.wasDragged = true;
          }

          // Retroalimentación de arrastre en tiempo real
          elements.thumbnails.scrollLeft = this.startScrollLeft - dx;
        },

        onMouseUp(e) {
          if (!this.isDragging) return;
          this.isDragging = false;
          elements.thumbnails.style.scrollBehavior = 'smooth';
          elements.thumbnails.style.cursor = '';
        }
      };

      elements.thumbnails.addEventListener('mousedown', (e) => thumbnailDrag.onMouseDown(e));
      document.addEventListener('mousemove', (e) => thumbnailDrag.onMouseMove(e));
      document.addEventListener('mouseup', (e) => thumbnailDrag.onMouseUp(e));

      // Interceptar evento clic: bloquearlo si fue arrastre
      elements.thumbnails.addEventListener('click', (e) => {
        if (thumbnailDrag.wasDragged) {
          e.stopPropagation();
          e.preventDefault();
          thumbnailDrag.wasDragged = false; // Reiniciar
        }
      }, true); // Interceptar en fase de captura
    }

    // Función de zoom de imagen (referencia PicaComic)
    // Zoom de imagen (usando atajos de teclado, para evitar conflicto con rueda)
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastOffsetX = 0;
    let lastOffsetY = 0;

    // Restablecer zoom de imagen
    function resetImageZoom() {
      state.settings.imageScale = 1;
      state.settings.imageOffsetX = 0;
      state.settings.imageOffsetY = 0;
      if (elements.currentImage) {
        elements.currentImage.style.transform = 'scale(1) translate(0, 0)';
        elements.currentImage.style.cursor = 'pointer';
      }
    }

    // Aplicar zoom de imagen
    function applyImageZoom() {
      if (elements.currentImage) {
        const scale = state.settings.imageScale;
        const offsetX = state.settings.imageOffsetX;
        const offsetY = state.settings.imageOffsetY;
        elements.currentImage.style.transform = `scale(${scale}) translate(${offsetX}px, ${offsetY}px)`;
        elements.currentImage.style.cursor = scale > 1 ? 'grab' : 'pointer';
      }
    }

    // Desplazamiento horizontal con rueda en zona de miniaturas (ya añadido arriba, evitar duplicado)

    // Doble clic en imagen para restablecer zoom
    if (elements.viewer) {
      elements.viewer.addEventListener('dblclick', (e) => {
        if (!e.target.closest('#eh-bottom-menu') && !e.target.closest('button')) {
          resetImageZoom();
          e.preventDefault();
        }
      });
      // Rueda del ratón para cambiar página (en modos página única/página única vertical)
      elements.viewer.addEventListener('wheel', (e) => {
        if (state.settings.readMode !== 'single' && state.settings.readMode !== 'single-vertical') return; // Solo cambiar página en modos de página única
        const delta = e.deltaY;
        // Lectura inversa: rueda hacia abajo (delta > 0) debe ir hacia adelante (-1), normal hacia atrás (+1)
        const direction = state.settings.reverse ? -1 : 1;
        if (delta > 0) {
          scheduleShowPage(state.currentPage + direction);
        } else if (delta < 0) {
          scheduleShowPage(state.currentPage - direction);
        }
        e.preventDefault();
      }, { passive: false });
    }

    // Arrastre de imagen (solo activo durante zoom)
    if (elements.currentImage) {
      elements.currentImage.addEventListener('mousedown', (e) => {
        if (state.settings.imageScale > 1) {
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          lastOffsetX = state.settings.imageOffsetX;
          lastOffsetY = state.settings.imageOffsetY;
          elements.currentImage.style.cursor = 'grabbing';
          e.preventDefault();
        }
      });

      document.addEventListener('mousemove', (e) => {
        if (isDragging) {
          const deltaX = e.clientX - dragStartX;
          const deltaY = e.clientY - dragStartY;
          state.settings.imageOffsetX = lastOffsetX + deltaX / state.settings.imageScale;
          state.settings.imageOffsetY = lastOffsetY + deltaY / state.settings.imageScale;
          applyImageZoom();
        }
      });

      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          if (elements.currentImage && state.settings.imageScale > 1) {
            elements.currentImage.style.cursor = 'grab';
          }
        }
      });
    }

  // (Modo doble página eliminado, solo se mantiene página única y continuo horizontal)

    // 🎯 Umbral de galería muy grande: más de este número de páginas puede causar falta de memoria en modo continuo
    const CONTINUOUS_MODE_MAX_PAGES = 500;

    // Modo continuo: MVP horizontal (carga diferida + observador)
    let continuous = { container: null, observer: null };
    async function enterContinuousHorizontalMode() {
      // Ocultar riel de cambio de página en cadena (no necesario en modo continuo)
      if (pageSlider.slider) pageSlider.setVisible(false);

      // Determinar si usar desplazamiento virtual
      const useVirtualScroll = state.pageCount > VIRTUAL_SCROLL_THRESHOLD;

      if (useVirtualScroll) {
        debugLog('[EH Modern Reader] Activando modo desplazamiento virtual horizontal, páginas:', state.pageCount);
        await enterVirtualHorizontalMode();
        return;
      }

  // Solo manejar contenedor de modo horizontal (no virtual, para galerías pequeñas)
      // Si ya existe, mostrar directamente
      if (!continuous.container) {
        // Precargar relaciones de aspecto de todas las imágenes (esperar a que complete, para evitar saltos de layout)
        try {
          await preloadImageRatios();
        } catch (err) {
          console.warn('[EH Modern Reader] Precarga en modo horizontal fallida:', err);
        }

  continuous.container = document.createElement('div');
  continuous.container.id = 'eh-continuous-horizontal';
  const CH_GAP = Math.max(0, Math.min(100, Number(state.settings.horizontalGap ?? 0))); // Usar separación configurada por el usuario
  continuous.container.style.cssText = `display:flex; flex-direction:row; align-items:center; gap:${CH_GAP}px; overflow-x:auto; overflow-y:hidden; height:100%; width:100%; padding:0; overflow-anchor:none;`;

        // En modo inverso, voltear todo horizontalmente
        if (state.settings.reverse) {
          continuous.container.style.transform = 'scaleX(-1)';
        }

        // Generar tarjetas placeholder (la precarga llenó ratioCache; usar 0.7 por defecto si no hay caché)
        for (let i = 0; i < state.pageCount; i++) {
          const card = document.createElement('div');
          card.className = 'eh-ch-card';
          // 🎯 Usar contain: layout para que cada tarjeta sea un contexto de layout independiente, evitando reflow global al cargar imágenes
          card.style.cssText = 'flex:0 0 auto; height:100%; position:relative; display:flex; contain:layout;';

          const wrapper = document.createElement('div');
          wrapper.className = 'eh-ch-wrapper eh-ch-skeleton';
          // El wrapper solo gestiona la proporción del placeholder y la adaptación de img
          wrapper.style.cssText = 'height:100%; aspect-ratio: var(--eh-aspect, 0.7); position:relative; display:flex; will-change:contents;';
          // En modo inverso, voltear cada imagen de vuelta
          if (state.settings.reverse) {
            wrapper.style.transform = 'scaleX(-1)';
          }
          // Usar proporción real precargada; por defecto 0.7 sin caché
          const cachedR = ratioCache.get(i);
          wrapper.style.setProperty('--eh-aspect', String(cachedR || 0.7));

          const img = document.createElement('img');
          // Usar 100% de ancho/alto para que object-fit:contain llene el wrapper correctamente
          img.style.cssText = 'width:100%; height:100%; display:block; object-fit:contain;';
          img.setAttribute('data-page-index', String(i));

          wrapper.appendChild(img);
          card.appendChild(wrapper);
          continuous.container.appendChild(card);
        }

        // Insertar en el área principal y ocultar el visor de página única
        const main = document.getElementById('eh-main');
        if (main) {
          main.appendChild(continuous.container);
          const singleViewer = document.getElementById('eh-viewer');
          if (singleViewer) singleViewer.style.display = 'none';
        }

        // Aplicar estado inverso una vez (dirección, valor de barra de progreso)
        try { if (typeof applyReverseState === 'function') applyReverseState(); } catch {}

        // Utilidad: establecer proporción de placeholder y quitar esqueleto según imagen cargada
        // 🎯 Optimización 1: Si ya hay proporción preestablecida y la diferencia es pequeña, no actualizar (evita saltos en desplazamiento automático)
        // 🎯 Optimización 2: Bloquear layout completamente durante desplazamiento automático, solo actualizar src (sin reflow)
        function applyAspectFor(imgEl, loadedImg) {
          try {
            if (!imgEl) return;
            const wrap = imgEl.parentElement;
            const w = loadedImg?.naturalWidth || loadedImg?.width;
            const h = loadedImg?.naturalHeight || loadedImg?.height;
            if (wrap && w && h && h > 0) {
              // 🎯 Durante desplazamiento automático: solo quitar estilo de esqueleto, no actualizar aspect-ratio
              if (autoScrollLockLayout) {
                wrap.classList.remove('eh-ch-skeleton');
                return;
              }
              const newRatio = Math.max(0.02, Math.min(5, w / h));
              const currentRatio = parseFloat(wrap.style.getPropertyValue('--eh-aspect')) || 0.7;
              // Actualizar solo si la diferencia de proporción supera el 5% (reduce reflow)
              const diff = Math.abs(newRatio - currentRatio) / currentRatio;
              if (diff > 0.05 || currentRatio === 0.7) {
                wrap.style.setProperty('--eh-aspect', String(newRatio));
              }
              wrap.classList.remove('eh-ch-skeleton');
            }
          } catch {}
        }

        // Carga diferida con observador - usar loadImage de forma unificada para evitar solicitudes duplicadas
        continuous.observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const img = entry.target;
              const idx = parseInt(img.getAttribute('data-page-index'));
              // Solo disparar si aún no se ha cargado
              if (!img.src && !img.getAttribute('data-loading')) {
                img.setAttribute('data-loading', 'true');

                // Verificar estado de caché
                const cached = state.imageCache.get(idx);
                if (cached && cached.status === 'loaded' && cached.img && cached.img.src) {
                  // Carga completada - mostrar directamente
                  img.src = cached.img.src;
                  applyAspectFor(img, cached.img);
                  img.removeAttribute('data-loading');
                } else if (cached && cached.status === 'loading' && cached.promise) {
                  // En carga, esperar Promise
                  cached.promise.then(loadedImg => {
                    if (loadedImg && loadedImg.src) {
                      img.src = loadedImg.src;
                    }
                    applyAspectFor(img, loadedImg);
                  }).catch(err => {
                    console.warn('[EH Modern Reader] Error al cargar imagen en modo horizontal:', idx, err);
                  }).finally(() => {
                    img.removeAttribute('data-loading');
                  });
                } else {
                  // No cargada, iniciar carga
                  loadImage(idx).then(loadedImg => {
                    if (loadedImg && loadedImg.src) {
                      img.src = loadedImg.src;
                    }
                    applyAspectFor(img, loadedImg);
                  }).catch(err => {
                    console.warn('[EH Modern Reader] Error al cargar imagen en modo horizontal:', idx, err);
                  }).finally(() => {
                    img.removeAttribute('data-loading');
                  });
                }
              }
            }
          });
  }, { root: continuous.container, rootMargin: '1200px', threshold: 0.01 });

        // Observar todas las imágenes
        continuous.container.querySelectorAll('img[data-page-index]').forEach(img => {
          continuous.observer.observe(img);
        });

        // Mapear rueda vertical a desplazamiento horizontal
        continuous.container.addEventListener('wheel', (e) => {
          if (e.deltaY !== 0) {
            const dirVisual = state.settings.reverse ? -1 : 1; // Dirección visual de desplazamiento
            continuous.container.scrollLeft += e.deltaY * dirVisual;
            // Predecir dirección de cambio de página para prefetch anticipado
            const forward = e.deltaY > 0; // true: desplazar a la derecha
            const logicalDir = forward ? 1 : -1; // Incremento/decremento lógico del número de página
            const base = state.currentPage - 1;
            const targets = [];
            for (let i = 1; i <= 4; i++) {
              const idx = base + logicalDir * i;
              if (idx >= 0 && idx < state.pageCount) targets.push(idx);
            }
            if (targets.length) enqueuePrefetch(targets, true);
            e.preventDefault();
          }
        }, { passive: false });

        // 🖱️ Soporte de desplazamiento por arrastre con ratón (misma sensación que JHenTai)
        let isMouseDragging = false;
        let dragStartX = 0;
        let dragScrollLeft = 0;
        let dragMoved = false; // Marcar si hubo movimiento real

        continuous.container.addEventListener('mousedown', (e) => {
          // Excluir botones y menús
          if (e.button !== 0) return; // Solo botón izquierdo
          if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) return;
          
          isMouseDragging = true;
          dragMoved = false;
          dragStartX = e.pageX;
          dragScrollLeft = continuous.container.scrollLeft;
          continuous.container.style.cursor = 'grabbing';
          continuous.container.style.userSelect = 'none';
          e.preventDefault();
        });

        const onMouseMove = (e) => {
          if (!isMouseDragging) return;
          const deltaX = e.pageX - dragStartX;
          if (Math.abs(deltaX) > 5) dragMoved = true; // Más de 5px se considera arrastre
          // En modo inverso, invertir la dirección del arrastre
          const dirVisual = state.settings.reverse ? 1 : -1;
          continuous.container.scrollLeft = dragScrollLeft + deltaX * dirVisual;
        };

        const onMouseUp = () => {
          if (!isMouseDragging) return;
          isMouseDragging = false;
          continuous.container.style.cursor = '';
          continuous.container.style.userSelect = '';
          // Si hubo arrastre, bloquear brevemente el evento clic
          if (dragMoved) {
            setTimeout(() => { dragMoved = false; }, 50);
          }
        };

        // Escuchar en document para que el arrastre continúe aunque el ratón salga del contenedor
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Modo continuo horizontal: clic en tres zonas izquierda/centro/derecha (centro: alternar menú inferior y miniaturas)
        continuous.container.addEventListener('click', (e) => {
          // Si hubo arrastre reciente, ignorar este clic
          if (dragMoved) {
            e.stopPropagation();
            return;
          }
          // Excluir menú inferior y botones
          if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) {
            return;
          }
          const rect = continuous.container.getBoundingClientRect();
          const rawX = e.clientX - rect.left;
          const width = rect.width;
          // Nota: en lectura inversa el contenedor usa scaleX(-1) como espejo visual, por lo que las coordenadas DOM son opuestas a lo visual.
          // Para que el juicio izquierda/centro/derecha siga la zona visual, aquí se espeja la coordenada en modo inverso.
          const clickX = state.settings.reverse ? (width - rawX) : rawX;
          const leftThreshold = width / 3;
          const rightThreshold = width * 2 / 3;
          // Centro: alternar barra superior + menú inferior (consistente con modo página única)
          if (clickX >= leftThreshold && clickX <= rightThreshold) {
            const header = document.getElementById('eh-header');
            const main = document.getElementById('eh-main');
            const bottom = elements.bottomMenu;
            if (header) {
              const isHidden = header.classList.toggle('eh-hidden');
              if (main) main.classList.toggle('eh-fullheight', isHidden);
              if (bottom) {
                // Usar el mismo control de clase que el modo página única, compatible con animación CSS
                bottom.classList.toggle('eh-menu-hidden', isHidden);
              }
              debugLog('[EH Modern Reader] Clic central en modo continuo -> alternar barra/menú, hidden=', isHidden);
            }
            e.stopPropagation();
            return;
          }
          // Izquierda/derecha: moverse por páginas
          let direction = 0;
          if (clickX < leftThreshold) {
            // Visual izquierda: normal = hacia adelante (-1), inverso = hacia atrás (+1)
            direction = state.settings.reverse ? 1 : -1;
          } else if (clickX > rightThreshold) {
            // Visual derecha: normal = hacia atrás (+1), inverso = hacia adelante (-1)
            direction = state.settings.reverse ? -1 : 1;
          } else {
            return;
          }
          const target = Math.max(1, Math.min(state.pageCount, state.currentPage + direction));
          scheduleShowPage(target, { immediate: true });
          debugLog('[EH Modern Reader] Zona clic modo continuo:', clickX < leftThreshold ? 'LEFT' : 'RIGHT', 'reverse=', !!state.settings.reverse, '→ target=', target);
          e.stopPropagation();
        });

        // Actualizar página actual y barra de progreso/resaltado según el elemento central al desplazarse
        let scrollUpdating = false;
        let lastScrollUpdate = 0;
        const onScroll = () => {
          // Omitir callback de scroll durante saltos programáticos, para no confundir la página actual
          if (scrollJumping || scrollUpdating) return;
          // 🎯 Durante desplazamiento automático: limitar a 1 vez cada 300ms, no omitir completamente
          const now = performance.now();
          if (autoScrollLockLayout && now - lastScrollUpdate < 300) return;
          lastScrollUpdate = now;
          scrollUpdating = true;
          requestAnimationFrame(() => {
            try {
              const viewportMid = continuous.container.clientWidth / 2;
              let bestIdx = 0; let bestDist = Infinity;
              const imgs = continuous.container.querySelectorAll('img[data-page-index]');
              imgs.forEach((img) => {
                const rect = img.getBoundingClientRect();
                const parentRect = continuous.container.getBoundingClientRect();
                const mid = rect.left - parentRect.left + rect.width / 2;
                const dist = Math.abs(mid - viewportMid);
                const idx = parseInt(img.getAttribute('data-page-index'));
                if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
              });
              // Índice físico bestIdx (base 0) -> número de página lógico (base 1)
              // En lectura inversa el contenedor tiene scaleX(-1) pero data-page-index no cambia, simplemente +1
              const pageNum = bestIdx + 1;

              // Asegurar que la página en el centro del viewport tenga prioridad de carga (“cargar lo que se ve”)
              const centerImg = continuous.container.querySelector(`img[data-page-index=”${bestIdx}”]`);
              if (centerImg && !centerImg.src && !centerImg.getAttribute('data-loading')) {
                // Cancelar otros prefetch y concentrar ancho de banda en la página central
                cancelPrefetchExcept(bestIdx);
                centerImg.setAttribute('data-loading', 'true');
                loadImage(bestIdx).then(loadedImg => {
                  if (loadedImg && loadedImg.src) centerImg.src = loadedImg.src;
                }).catch(err => {
                  console.warn('[EH Modern Reader] Error al cargar página central:', bestIdx, err);
                }).finally(() => {
                  centerImg.removeAttribute('data-loading');
                });
                // Planificar inmediatamente preheat de alta prioridad para 3-4 páginas adyacentes
                const neighbors = [bestIdx - 2, bestIdx - 1, bestIdx + 1, bestIdx + 2].filter(i => i >= 0 && i < state.pageCount);
                enqueuePrefetch(neighbors, true);
              }

              if (pageNum !== state.currentPage) {
                state.currentPage = pageNum;
                if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
                if (elements.progressBar) {
                  elements.progressBar.value = pageNum;
                }
                updateThumbnailHighlight(pageNum);
                preloadAdjacentPages(pageNum);
                saveProgress(pageNum);
              }
            } finally {
              scrollUpdating = false;
            }
          });
        };
        continuous.container.addEventListener('scroll', onScroll);

        // Al entrar al modo horizontal, si ya hay currentPage, asegurarse de desplazar al centro de esa página (evitar posición incorrecta al cambiar de modo)
        const targetIdx = state.currentPage - 1;
        const targetImg = continuous.container.querySelector(`img[data-page-index="${targetIdx}"]`);
        if (targetImg) {
          // Esperar dos frames para garantizar layout completamente estable
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const c = continuous.container;
              if (!c) return; // Prevenir si el contenedor ya fue destruido
              const wrapper = targetImg.closest('.eh-ch-wrapper') || targetImg.parentElement;
              if (wrapper) {
                scrollJumping = true;
                wrapper.scrollIntoView({
                  behavior: 'auto',
                  block: 'center',
                  inline: 'center'
                });
                setTimeout(() => { scrollJumping = false; }, 50);
                debugLog('[EH Modern Reader] Desplazamiento en modo horizontal a página:', state.currentPage);
              }
            });
          });
        }
      }
    }

    // ==================== Modo desplazamiento virtual vertical ====================
    // Idea principal: solo renderizar elementos del área visible ± buffer, usando contenedor placeholder para mantener la altura total de scroll
    // Referencia: implementación ScrollablePositionedList de JHenTai

    const virtualScroll = {
      enabled: false,           // Si el desplazamiento virtual está activo
      itemHeights: [],          // Altura estimada de cada elemento
      itemOffsets: [],          // Desplazamiento acumulado de cada elemento
      totalHeight: 0,           // Altura total del contenido
      renderedRange: { start: -1, end: -1 }, // Rango de elementos actualmente renderizados
      bufferCount: 5,           // Número de elementos de buffer delante y detrás (reducido para mejor rendimiento)
      viewportHeight: 0,        // Altura del viewport
      gap: 0,                   // Separación entre elementos
      sidePadding: 0,           // Relleno lateral
      containerWidth: 0,        // Ancho del contenedor (para calcular altura)
      scrollContainer: null,    // Contenedor de scroll
      contentContainer: null,   // Contenedor de contenido (para altura placeholder)
      itemsContainer: null,     // Contenedor de elementos reales
      rafId: null,              // ID de requestAnimationFrame
      lastScrollTop: 0,         // Última posición de scroll
      isJumping: false,         // Si está saltando actualmente
      defaultItemHeight: 0,     // Altura predeterminada del elemento (basada en viewport)
      knownHeights: new Map(),  // Alturas reales conocidas
      pendingJumpTarget: -1,    // 🎯 Índice de página objetivo pendiente de salto (-1 = ninguno)
      jumpStabilizeTimer: null, // Temporizador de estabilización de salto
    };

    // Umbral de desplazamiento virtual: activar desplazamiento virtual si se supera este número de páginas
    const VIRTUAL_SCROLL_THRESHOLD = 200;

    // =====================================================
    // Objeto de estado del desplazamiento virtual horizontal
    // =====================================================
    const virtualScrollH = {
      enabled: false,           // Si el desplazamiento virtual horizontal está activo
      itemWidths: [],           // Ancho estimado de cada elemento
      itemOffsets: [],          // Desplazamiento acumulado de cada elemento
      totalWidth: 0,            // Ancho total del contenido
      renderedRange: { start: -1, end: -1 }, // Rango de elementos actualmente renderizados
      bufferCount: 5,           // Número de elementos de buffer
      viewportWidth: 0,         // Ancho del viewport
      viewportHeight: 0,        // Altura del viewport (para calcular ancho del elemento)
      gap: 0,                   // Separación entre elementos
      scrollContainer: null,    // Contenedor de scroll
      contentContainer: null,   // Contenedor de contenido (para ancho placeholder)
      itemsContainer: null,     // Contenedor de elementos reales
      isJumping: false,         // Si está saltando actualmente
      defaultItemWidth: 0,      // Ancho predeterminado del elemento
      knownWidths: new Map(),   // Anchos reales conocidos
      pendingJumpTarget: -1,    // 🎯 Índice de página objetivo pendiente de salto (-1 = ninguno)
      jumpStabilizeTimer: null, // Temporizador de estabilización de salto
    };

    // Calcular layout del desplazamiento virtual horizontal
    // 🎯 Referencia clearImageContainerSized de JHenTai: usar ancho predeterminado al cambiar de modo
    // Pero primero extrae tamaños conocidos de imageCache para mantener consistencia de anchos en imágenes ya cargadas
    function calculateVirtualLayoutH() {
      const vh = virtualScrollH;
      vh.itemWidths = [];
      vh.itemOffsets = [];

      // Ancho predeterminado: basado en altura del viewport y relación de aspecto 0.7 por defecto
      vh.defaultItemWidth = Math.round(vh.viewportHeight * 0.7);

      // 🎯 Primero extraer tamaños reales de todas las imágenes cargadas desde imageCache a knownWidths
      for (let i = 0; i < state.pageCount; i++) {
        const cached = state.imageCache.get(i);
        if (cached && cached.status === 'loaded' && cached.img) {
          const w = cached.img.naturalWidth || cached.img.width;
          const h = cached.img.naturalHeight || cached.img.height;
          if (w && h && h > 0) {
            const ratio = w / h;
            const realWidth = Math.round(vh.viewportHeight * ratio);
            vh.knownWidths.set(i, realWidth);
          }
        }
      }
      
      let currentOffset = 0;
      for (let i = 0; i < state.pageCount; i++) {
        // 优先使用已知宽度（从 imageCache 提取或图片加载后设置的），否则用默认宽度
        let width;
        if (vh.knownWidths.has(i)) {
          width = vh.knownWidths.get(i);
        } else {
          width = vh.defaultItemWidth;
        }
        
        vh.itemWidths.push(width);
        vh.itemOffsets.push(currentOffset);
        currentOffset += width + vh.gap;
      }
      
      vh.totalWidth = currentOffset - vh.gap;
      debugLog('[EH VirtualH] Layout horizontal calculado, ancho total:', vh.totalWidth, 'ancho predeterminado:', vh.defaultItemWidth);
    }

    // Calcular rango horizontal visible según posición de scroll
    function getVisibleRangeH(scrollLeft) {
      const vh = virtualScrollH;
      const viewportEnd = scrollLeft + vh.viewportWidth;
      
      let start = 0;
      let end = state.pageCount - 1;
      while (start < end) {
        const mid = Math.floor((start + end) / 2);
        if (vh.itemOffsets[mid] + vh.itemWidths[mid] < scrollLeft) {
          start = mid + 1;
        } else {
          end = mid;
        }
      }
      const firstVisible = Math.max(0, start - vh.bufferCount);
      
      end = state.pageCount - 1;
      while (start < end) {
        const mid = Math.floor((start + end + 1) / 2);
        if (vh.itemOffsets[mid] > viewportEnd) {
          end = mid - 1;
        } else {
          start = mid;
        }
      }
      const lastVisible = Math.min(state.pageCount - 1, start + vh.bufferCount);
      
      return { start: firstVisible, end: lastVisible };
    }
    
    // Crear elemento virtual horizontal
    function createVirtualItemH(index) {
      const vh = virtualScrollH;

      const card = document.createElement('div');
      card.className = 'eh-ch-card eh-virtual-item-h';
      card.setAttribute('data-virtual-index', String(index));
      card.style.cssText = `
        position: absolute;
        top: 0;
        left: ${vh.itemOffsets[index]}px;
        width: ${vh.itemWidths[index]}px;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        contain: layout;
        pointer-events: auto;
      `;

      // En modo inverso, voltear cada imagen
      if (state.settings.reverse) {
        card.style.transform = 'scaleX(-1)';
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'eh-ch-wrapper eh-ch-skeleton';
      // Usar aspect-ratio para mantener proporción, igual que en modo no virtual
      const cachedR = ratioCache.get(index);
      wrapper.style.cssText = `
        height: 100%;
        aspect-ratio: ${cachedR || 0.7};
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      `;

      const img = document.createElement('img');
      // Usar 100% ancho/alto para que object-fit:contain llene el wrapper (igual que modo no virtual)
      img.style.cssText = 'width: 100%; height: 100%; display: block; object-fit: contain;';
      img.setAttribute('data-page-index', String(index));

      wrapper.appendChild(img);
      card.appendChild(wrapper);

      // Cargar imagen
      loadVirtualImageH(img, index, card);

      return card;
    }

    // Cargar imagen del desplazamiento virtual horizontal
    function loadVirtualImageH(img, index, card) {
      const cached = state.imageCache.get(index);
      if (cached && cached.status === 'loaded' && cached.img && cached.img.src) {
        img.src = cached.img.src;
        updateCardWidthFromUrl(cached.img.src, index, card);
        applyVirtualAspectH(img, cached.img, card, index);
        return;
      }
      
      if (cached && cached.status === 'loading' && cached.promise) {
        cached.promise.then(loadedImg => {
          if (loadedImg && loadedImg.src) {
            img.src = loadedImg.src;
            updateCardWidthFromUrl(loadedImg.src, index, card);
          }
          applyVirtualAspectH(img, loadedImg, card, index);
        }).catch(() => {});
        return;
      }
      
      loadImage(index).then(loadedImg => {
        if (loadedImg && loadedImg.src) {
          img.src = loadedImg.src;
          updateCardWidthFromUrl(loadedImg.src, index, card);
        }
        applyVirtualAspectH(img, loadedImg, card, index);
      }).catch(() => {});
    }
    
    // Extraer dimensiones de la URL y actualizar ancho de la tarjeta
    function updateCardWidthFromUrl(url, index, card) {
      const sizeInfo = extractSizeFromUrl(url);
      if (!sizeInfo) return;
      
      const vh = virtualScrollH;
      const newWidth = Math.round(vh.viewportHeight * sizeInfo.ratio);
      const oldWidth = vh.itemWidths[index];
      
      if (Math.abs(newWidth - oldWidth) < 10) return;
      
      const scrollLeft = vh.scrollContainer ? vh.scrollContainer.scrollLeft : 0;
      const elementRight = vh.itemOffsets[index] + oldWidth;
      
      vh.itemWidths[index] = newWidth;
      vh.knownWidths.set(index, newWidth);
      
      // Si el elemento está a la izquierda del viewport, compensar la posición de scroll
      if (elementRight <= scrollLeft + 50) {
        const diff = newWidth - oldWidth;
        if (vh.scrollContainer && Math.abs(diff) > 5) {
          vh.isJumping = true;
          vh.scrollContainer.scrollLeft = scrollLeft + diff;
          setTimeout(() => { vh.isJumping = false; }, 50);
          debugLog('[EH VirtualH] Compensación de ancho, index:', index, 'diff:', diff);
        }
      }
      
      if (card) {
        card.style.width = newWidth + 'px';
      }
      
      scheduleLayoutRecalcH();
    }
    
    // Aplicar dimensiones reales al elemento virtual horizontal
    // 🎯 Si hay pendingJumpTarget, no hacer compensación de scroll inmediata; dejar que recalcVirtualOffsetsH lo maneje
    function applyVirtualAspectH(imgEl, loadedImg, card, index) {
      if (!imgEl || !loadedImg) return;

      const wrapper = imgEl.parentElement;
      if (wrapper) {
        wrapper.classList.remove('eh-ch-skeleton');
      }

      const w = loadedImg.naturalWidth || loadedImg.width;
      const h = loadedImg.naturalHeight || loadedImg.height;
      if (!w || !h || h <= 0) return;

      const ratio = w / h;

      // Actualizar aspect-ratio del wrapper
      if (wrapper) {
        wrapper.style.aspectRatio = String(ratio);
      }

      const vh = virtualScrollH;
      const newWidth = Math.round(vh.viewportHeight * ratio);
      const oldWidth = vh.itemWidths[index];

      if (Math.abs(newWidth - oldWidth) < 10) return;

      vh.itemWidths[index] = newWidth;
      vh.knownWidths.set(index, newWidth);

      // 🎯 Clave: si hay objetivo de salto, no compensar inmediatamente; dejar a recalcVirtualOffsetsH que lo maneje
      if (vh.pendingJumpTarget < 0) {
        const scrollLeft = vh.scrollContainer ? vh.scrollContainer.scrollLeft : 0;
        const elementRight = vh.itemOffsets[index] + oldWidth;

        if (elementRight <= scrollLeft + 50) {
          const diff = newWidth - oldWidth;
          if (vh.scrollContainer && Math.abs(diff) > 5) {
            vh.isJumping = true;
            vh.scrollContainer.scrollLeft = scrollLeft + diff;
            setTimeout(() => { vh.isJumping = false; }, 50);
          }
        }
      } else {
        debugLog('[EH VirtualH] Saltando, omitir compensación inmediata, index:', index);
      }
      
      if (card) {
        card.style.width = newWidth + 'px';
      }
      
      ratioCache.set(index, ratio);
      scheduleLayoutRecalcH();
    }
    
    // Recálculo del layout horizontal (con debounce)
    let layoutRecalcTimerH = null;
    function scheduleLayoutRecalcH() {
      if (layoutRecalcTimerH) return;
      layoutRecalcTimerH = setTimeout(() => {
        layoutRecalcTimerH = null;
        recalcVirtualOffsetsH();
      }, 150);
    }
    
    // Recalcular offsets del desplazamiento virtual horizontal
    // 🎯 Si hay pendingJumpTarget, usar la página objetivo como ancla para mantener posición estable
    function recalcVirtualOffsetsH() {
      const vh = virtualScrollH;
      if (!vh.enabled || !vh.scrollContainer) return;

      const scrollLeft = vh.scrollContainer.scrollLeft;

      // 🎯 Determinar índice de ancla: usar objetivo de salto primero, si no el primer elemento visible
      let anchorIndex;
      if (vh.pendingJumpTarget >= 0 && vh.pendingJumpTarget < state.pageCount) {
        anchorIndex = vh.pendingJumpTarget;
      } else {
        anchorIndex = findFirstVisibleIndexH(scrollLeft);
      }
      const oldAnchorOffset = vh.itemOffsets[anchorIndex] || 0;
      const oldScrollLeft = scrollLeft;

      let currentOffset = 0;
      for (let i = 0; i < state.pageCount; i++) {
        vh.itemOffsets[i] = currentOffset;
        currentOffset += vh.itemWidths[i] + vh.gap;
      }
      vh.totalWidth = currentOffset - vh.gap;

      if (vh.contentContainer) {
        vh.contentContainer.style.width = vh.totalWidth + 'px';
      }

      // 🎯 Clave: ajustar posición de scroll para mantener el elemento ancla (página objetivo o primero visible) estable
      if (vh.scrollContainer && anchorIndex >= 0) {
        const newAnchorOffset = vh.itemOffsets[anchorIndex] || 0;
        const scrollDelta = newAnchorOffset - oldAnchorOffset;
        if (Math.abs(scrollDelta) > 5) {
          // Si hay objetivo de salto, alinear directamente el elemento objetivo cerca del borde izquierdo del viewport
          if (vh.pendingJumpTarget >= 0) {
            const targetScroll = Math.max(0, newAnchorOffset - 20);
            vh.scrollContainer.scrollLeft = targetScroll;
            debugLog('[EH VirtualH] Corrección de posición de salto:', vh.pendingJumpTarget + 1, 'nueva posición de scroll:', targetScroll);
          } else {
            // Sin salto: mantener posición relativa del primer elemento visible
            vh.isJumping = true;
            vh.scrollContainer.scrollLeft = oldScrollLeft + scrollDelta;
            setTimeout(() => { vh.isJumping = false; }, 50);
          }
        }
      }

      if (vh.itemsContainer) {
        const items = vh.itemsContainer.querySelectorAll('.eh-virtual-item-h');
        items.forEach(item => {
          const idx = parseInt(item.getAttribute('data-virtual-index'));
          if (idx >= 0 && idx < state.pageCount) {
            item.style.left = vh.itemOffsets[idx] + 'px';
            item.style.width = vh.itemWidths[idx] + 'px';
          }
        });
      }

      debugLog('[EH VirtualH] Recálculo de offsets completado, nuevo ancho total:', vh.totalWidth);
    }

    // Encontrar el índice del primer elemento visible en el viewport horizontal (modo JHenTai)
    function findFirstVisibleIndexH(scrollLeft) {
      const vh = virtualScrollH;
      const viewportLeft = scrollLeft;
      const viewportRight = scrollLeft + vh.viewportWidth;
      const viewportMid = scrollLeft + vh.viewportWidth / 2;
      
      for (let i = 0; i < state.pageCount; i++) {
        const itemLeft = vh.itemOffsets[i];
        const itemRight = itemLeft + vh.itemWidths[i];
        
        // 元素在视口内可见
        if (itemRight > viewportLeft && itemLeft < viewportRight) {
          // 选择第一个左边缘在视口前半部分，或覆盖视口左边缘的元素
          if (itemLeft <= viewportMid || itemLeft <= viewportLeft) {
            return i;
          }
        }
      }
      return 0;
    }
    
    // Actualizar renderizado virtual horizontal
    function updateVirtualRenderingH() {
      const vh = virtualScrollH;
      if (!vh.scrollContainer || !vh.itemsContainer) return;

      const scrollLeft = vh.scrollContainer.scrollLeft;
      const range = getVisibleRangeH(scrollLeft);

      if (range.start === vh.renderedRange.start && range.end === vh.renderedRange.end) {
        return;
      }

      debugLog('[EH VirtualH] Actualizar rango de renderizado:', range.start, '-', range.end, '(antes:', vh.renderedRange.start, '-', vh.renderedRange.end, ')');

      // Eliminar elementos fuera del rango
      const existingItems = vh.itemsContainer.querySelectorAll('.eh-virtual-item-h');
      existingItems.forEach(item => {
        const idx = parseInt(item.getAttribute('data-virtual-index'));
        if (idx < range.start || idx > range.end) {
          item.remove();
        }
      });

      // Agregar nuevos elementos
      for (let i = range.start; i <= range.end; i++) {
        const existing = vh.itemsContainer.querySelector(`[data-virtual-index="${i}"]`);
        if (!existing) {
          const newItem = createVirtualItemH(i);
          vh.itemsContainer.appendChild(newItem);
        }
      }

      vh.renderedRange = range;

      // Actualizar número de página actual (no actualizar durante salto para evitar saltos visuales)
      if (!vh.isJumping) {
        const firstVisibleIndex = findFirstVisibleIndexH(scrollLeft);
        const newPage = firstVisibleIndex + 1;
        if (newPage !== state.currentPage) {
          state.currentPage = newPage;
          if (elements.pageInfo) elements.pageInfo.textContent = `${newPage} / ${state.pageCount}`;
          if (elements.progressBar) elements.progressBar.value = newPage;
          updateThumbnailHighlight(newPage);
          saveProgress(newPage);
        }
      }

      // Precargar imágenes adyacentes
      const prefetchTargets = [];
      for (let i = range.start - 3; i <= range.end + 3; i++) {
        if (i >= 0 && i < state.pageCount) prefetchTargets.push(i);
      }
      enqueuePrefetch(prefetchTargets, false);
    }

    // Saltar a la página especificada en el desplazamiento virtual horizontal
    // 🎯 Referencia scrollTo(index:) de JHenTai - posicionamiento por índice, con corrección automática al cambiar layout
    function jumpToVirtualPageH(pageNum) {
      const vh = virtualScrollH;
      if (!vh.scrollContainer) return;

      const idx = pageNum - 1;
      if (idx < 0 || idx >= state.pageCount) return;

      vh.isJumping = true;

      // 🎯 Clave: registrar índice objetivo de salto para corrección de posición al cambiar layout
      vh.pendingJumpTarget = idx;

      // Limpiar temporizador de estabilización anterior
      if (vh.jumpStabilizeTimer) {
        clearTimeout(vh.jumpStabilizeTimer);
        vh.jumpStabilizeTimer = null;
      }

      // Calcular posición de scroll objetivo (alinear borde izquierdo del elemento con el viewport, con pequeño margen)
      const itemOffset = vh.itemOffsets[idx];
      const targetScroll = Math.max(0, itemOffset - 20);

      vh.scrollContainer.scrollLeft = targetScroll;

      // Actualizar número de página inmediatamente, sin esperar evento de scroll
      state.currentPage = pageNum;
      if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
      if (elements.progressBar) elements.progressBar.value = pageNum;
      updateThumbnailHighlight(pageNum);

      updateVirtualRenderingH();

      // 🎯 Esperar más tiempo tras el salto para que las imágenes carguen, corrigiendo posición continuamente
      vh.jumpStabilizeTimer = setTimeout(() => {
        vh.pendingJumpTarget = -1;
        vh.isJumping = false;
        vh.jumpStabilizeTimer = null;
        debugLog('[EH VirtualH] Salto estabilizado');
      }, 2000);

      debugLog('[EH VirtualH] Saltar a página:', pageNum, 'posición de scroll:', targetScroll, 'índice objetivo:', idx);
    }

    // =====================================================
    // Funciones de desplazamiento virtual vertical (originales)
    // =====================================================

    // Calcular alturas y offsets de elementos (usando altura fija predeterminada, actualizando tras carga)
    // 🎯 Referencia clearImageContainerSized de JHenTai: usar altura predeterminada al cambiar de modo
    // Pero primero extrae tamaños conocidos de imageCache para mantener consistencia de alturas en imágenes ya cargadas
    function calculateVirtualLayout() {
      const vs = virtualScroll;
      vs.itemHeights = [];
      vs.itemOffsets = [];

      // Altura predeterminada: 1.4 veces la altura del viewport (adecuada para la mayoría de páginas de manga)
      vs.defaultItemHeight = Math.round(vs.viewportHeight * 1.4);
      const availableWidth = vs.containerWidth - vs.sidePadding * 2;

      // 🎯 Primero extraer tamaños reales de todas las imágenes cargadas desde imageCache a knownHeights
      // Así el layout inicial usará tamaños reales, evitando inconsistencias entre imágenes con y sin caché
      for (let i = 0; i < state.pageCount; i++) {
        const cached = state.imageCache.get(i);
        if (cached && cached.status === 'loaded' && cached.img) {
          const w = cached.img.naturalWidth || cached.img.width;
          const h = cached.img.naturalHeight || cached.img.height;
          if (w && h && h > 0) {
            const ratio = w / h;
            const realHeight = Math.round(availableWidth / ratio);
            vs.knownHeights.set(i, realHeight);
          }
        }
      }

      let currentOffset = 0;
      for (let i = 0; i < state.pageCount; i++) {
        // Priorizar alturas conocidas (extraídas de imageCache o establecidas tras carga), si no usar altura predeterminada
        let height;
        if (vs.knownHeights.has(i)) {
          height = vs.knownHeights.get(i);
        } else {
          height = vs.defaultItemHeight;
        }

        vs.itemHeights.push(height);
        vs.itemOffsets.push(currentOffset);
        currentOffset += height + vs.gap;
      }
      
      // Altura total
      vs.totalHeight = currentOffset - vs.gap; // El último no necesita separación

      debugLog('[EH Virtual] Layout calculado, altura total:', vs.totalHeight, 'altura predeterminada:', vs.defaultItemHeight);
    }

    // Calcular rango visible según posición de scroll
    function getVisibleRange(scrollTop) {
      const vs = virtualScroll;
      const viewportEnd = scrollTop + vs.viewportHeight;

      // Búsqueda binaria del elemento inicial
      let start = 0;
      let end = state.pageCount - 1;
      while (start < end) {
        const mid = Math.floor((start + end) / 2);
        if (vs.itemOffsets[mid] + vs.itemHeights[mid] < scrollTop) {
          start = mid + 1;
        } else {
          end = mid;
        }
      }
      const firstVisible = Math.max(0, start - vs.bufferCount);

      // Buscar elemento final
      end = state.pageCount - 1;
      while (start < end) {
        const mid = Math.floor((start + end + 1) / 2);
        if (vs.itemOffsets[mid] > viewportEnd) {
          end = mid - 1;
        } else {
          start = mid;
        }
      }
      const lastVisible = Math.min(state.pageCount - 1, start + vs.bufferCount);

      return { start: firstVisible, end: lastVisible };
    }

    // Crear un elemento individual
    function createVirtualItem(index) {
      const vs = virtualScroll;
      const availableWidth = vs.containerWidth - vs.sidePadding * 2;

      const card = document.createElement('div');
      card.className = 'eh-cv-card eh-virtual-item';
      card.setAttribute('data-virtual-index', String(index));
      card.style.cssText = `
        position: absolute;
        left: 0;
        right: 0;
        top: ${vs.itemOffsets[index]}px;
        height: ${vs.itemHeights[index]}px;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 0 ${vs.sidePadding}px;
        box-sizing: border-box;
        overflow: hidden;
      `;

      const wrapper = document.createElement('div');
      wrapper.className = 'eh-cv-wrapper eh-cv-skeleton';
      wrapper.style.cssText = `
        width: 100%;
        display: flex;
        justify-content: center;
        align-items: flex-start;
      `;

      // Modo inverso
      if (state.settings.reverse) {
        wrapper.style.transform = 'scaleY(-1)';
      }

      const img = document.createElement('img');
      img.style.cssText = `
        width: 100%;
        height: auto;
        display: block;
      `;
      img.setAttribute('data-page-index', String(index));

      wrapper.appendChild(img);
      card.appendChild(wrapper);

      // Cargar imagen inmediatamente
      loadVirtualImage(img, index, card);

      return card;
    }

    // Extraer información de dimensiones desde la URL de la imagen
    // Ejemplo de formato de URL: .../hash-size-720-5070-jpg/...
    function extractSizeFromUrl(url) {
      if (!url) return null;
      // Coincidir con formato: -width-height-format (ej: -720-5070-jpg o -720-5070-wbp)
      const match = url.match(/-(\d+)-(\d+)-(jpg|png|gif|webp|wbp)/i);
      if (match) {
        const width = parseInt(match[1]);
        const height = parseInt(match[2]);
        if (width > 0 && height > 0 && width < 10000 && height < 50000) {
          return { width, height, ratio: width / height };
        }
      }
      return null;
    }

    // Cargar imagen en el desplazamiento virtual
    function loadVirtualImage(img, index, card) {
      if (img.src || img.getAttribute('data-loading')) {
        debugLog('[EH Virtual Load] Omitir carga index:', index, 'razón:', img.src ? 'already-has-src' : 'data-loading');
        return;
      }

      img.setAttribute('data-loading', 'true');
      debugLog('[EH Virtual Load] Iniciar carga index:', index);

      const cached = state.imageCache.get(index);
      if (cached && cached.status === 'loaded' && cached.img && cached.img.src) {
        // 🎯 Primero extraer dimensiones de la URL para ajustar altura inmediatamente
        debugLog('[EH Virtual Load] Usar caché index:', index, 'url:', cached.img.src.slice(-30));
        updateCardHeightFromUrl(cached.img.src, index, card);
        img.src = cached.img.src;
        applyVirtualAspect(img, cached.img, index);
        img.removeAttribute('data-loading');
      } else if (cached && cached.status === 'loading' && cached.promise) {
        debugLog('[EH Virtual Load] Esperar Promise en carga index:', index);
        cached.promise.then(loadedImg => {
          if (loadedImg && loadedImg.src) {
            debugLog('[EH Virtual Load] Promise completada index:', index, 'url:', loadedImg.src.slice(-30));
            updateCardHeightFromUrl(loadedImg.src, index, card);
            img.src = loadedImg.src;
          } else {
            console.warn('[EH Virtual Load] Promise completada sin imagen index:', index);
          }
          applyVirtualAspect(img, loadedImg, index);
        }).catch((err) => {
          console.warn('[EH Virtual Load] Promise fallida index:', index, err);
        }).finally(() => img.removeAttribute('data-loading'));
      } else {
        debugLog('[EH Virtual Load] Nueva carga index:', index);
        loadImage(index).then(loadedImg => {
          if (loadedImg && loadedImg.src) {
            debugLog('[EH Virtual Load] Nueva carga completada index:', index, 'url:', loadedImg.src.slice(-30));
            updateCardHeightFromUrl(loadedImg.src, index, card);
            img.src = loadedImg.src;
          } else {
            console.warn('[EH Virtual Load] 新加载完成但无图片 index:', index);
          }
          applyVirtualAspect(img, loadedImg, index);
        }).catch((err) => {
          console.warn('[EH Virtual Load] Nueva carga fallida index:', index, err);
        }).finally(() => img.removeAttribute('data-loading'));
      }
    }
    
    // Extraer dimensiones de la URL y actualizar altura de la tarjeta (antes de descargar la imagen)
    function updateCardHeightFromUrl(url, index, card) {
      const vs = virtualScroll;
      if (!vs.enabled || !card) return;

      const size = extractSizeFromUrl(url);
      if (!size) return;

      const availableWidth = vs.containerWidth - vs.sidePadding * 2;
      const realHeight = Math.round(availableWidth / size.ratio);
      const oldHeight = vs.itemHeights[index];
      const heightDiff = realHeight - oldHeight;

      // Actualizar solo si el cambio de altura es significativo
      if (Math.abs(heightDiff) > 50) {
        vs.knownHeights.set(index, realHeight);
        ratioCache.set(index, size.ratio);
        vs.itemHeights[index] = realHeight;
        card.style.height = realHeight + 'px';

        // Si el elemento está arriba del viewport, compensar el scroll inmediatamente
        const scrollTop = vs.scrollContainer?.scrollTop || 0;
        const elementBottom = vs.itemOffsets[index] + oldHeight;

        if (elementBottom <= scrollTop + 50) {
          vs.isJumping = true;
          vs.scrollContainer.scrollTop = scrollTop + heightDiff;
          setTimeout(() => { vs.isJumping = false; }, 30);
          debugLog('[EH Virtual] Compensación de dimensiones URL, index:', index, 'diff:', heightDiff);
        }

        // Recálculo diferido de offsets
        scheduleLayoutRecalc();
      }
    }

    // Aplicar relación de aspecto real (versión desplazamiento virtual) - solo actualizar elemento actual, sin reordenar siguientes
    // 🎯 Si hay pendingJumpTarget, no hacer compensación de scroll inmediata; dejar que recalcVirtualOffsets lo maneje
    function applyVirtualAspect(imgEl, loadedImg, index) {
      try {
        if (!imgEl) return;
        const wrap = imgEl.parentElement;
        const card = wrap?.parentElement;
        const vs = virtualScroll;
        const w = loadedImg?.naturalWidth || loadedImg?.width;
        const h = loadedImg?.naturalHeight || loadedImg?.height;

        if (wrap && card && w && h && h > 0 && vs.enabled && vs.scrollContainer) {
          wrap.classList.remove('eh-cv-skeleton');

          // Calcular altura real
          const newRatio = Math.max(0.02, Math.min(5, w / h));
          const availableWidth = vs.containerWidth - vs.sidePadding * 2;
          const realHeight = Math.round(availableWidth / newRatio);

          // Guardar altura real
          const oldHeight = vs.itemHeights[index];
          const heightDiff = realHeight - oldHeight;

          // Solo procesar si el cambio de altura supera 10px
          if (Math.abs(heightDiff) > 10) {
            vs.knownHeights.set(index, realHeight);
            ratioCache.set(index, newRatio);
            vs.itemHeights[index] = realHeight;
            card.style.height = realHeight + 'px';

            // 🎯 Clave: si hay objetivo de salto, no compensar inmediatamente; dejar a recalcVirtualOffsets que lo maneje
            // Esto evita errores acumulados por múltiples compensaciones
            if (vs.pendingJumpTarget < 0) {
              // Sin salto: si este elemento está arriba del viewport, compensar posición de scroll inmediatamente
              const scrollTop = vs.scrollContainer.scrollTop;
              const elementBottom = vs.itemOffsets[index] + oldHeight;

              // La parte inferior del elemento está encima del viewport = este elemento está sobre nosotros, el cambio de altura nos desplaza
              if (elementBottom <= scrollTop + 50) {
                // Compensar posición de scroll inmediatamente
                vs.isJumping = true;
                vs.scrollContainer.scrollTop = scrollTop + heightDiff;
                setTimeout(() => { vs.isJumping = false; }, 30);
                debugLog('[EH Virtual] Compensar scroll, index:', index, 'diff:', heightDiff);
              }
            } else {
              debugLog('[EH Virtual] Saltando, omitir compensación inmediata, index:', index, 'diff:', heightDiff);
            }

            // Recálculo diferido de todos los offsets (combinar múltiples actualizaciones)
            scheduleLayoutRecalc();
          }
        }
      } catch (e) {
        console.warn('[EH Virtual] applyVirtualAspect error:', e);
      }
    }

    // Recálculo diferido del layout (con debounce)
    let layoutRecalcTimer = null;
    function scheduleLayoutRecalc() {
      if (layoutRecalcTimer) return; // Ya hay un recálculo planificado
      layoutRecalcTimer = setTimeout(() => {
        layoutRecalcTimer = null;
        recalcVirtualOffsets();
      }, 150); // Recalcular tras 150ms
    }

    // Recalcular todos los offsets
    // 🎯 Si hay pendingJumpTarget, usar la página objetivo como ancla para mantener posición estable
    function recalcVirtualOffsets() {
      const vs = virtualScroll;
      if (!vs.enabled) return;

      const oldScrollTop = vs.scrollContainer?.scrollTop || 0;

      // 🎯 Determinar índice de ancla: usar objetivo de salto primero, si no el elemento central del viewport
      let anchorIndex;
      if (vs.pendingJumpTarget >= 0 && vs.pendingJumpTarget < state.pageCount) {
        anchorIndex = vs.pendingJumpTarget;
      } else {
        anchorIndex = findCenterIndex(oldScrollTop);
      }
      const oldAnchorOffset = vs.itemOffsets[anchorIndex] || 0;

      // Recalcular offsets
      let currentOffset = 0;
      for (let i = 0; i < state.pageCount; i++) {
        vs.itemOffsets[i] = currentOffset;
        currentOffset += vs.itemHeights[i] + vs.gap;
      }
      vs.totalHeight = currentOffset - vs.gap;

      // Actualizar altura del contenedor placeholder
      if (vs.contentContainer) {
        vs.contentContainer.style.height = vs.totalHeight + 'px';
      }

      // 🎯 Clave: ajustar posición de scroll para mantener el elemento ancla (página objetivo o centro del viewport) estable
      if (vs.scrollContainer && anchorIndex >= 0) {
        const newAnchorOffset = vs.itemOffsets[anchorIndex] || 0;
        const scrollDelta = newAnchorOffset - oldAnchorOffset;
        if (Math.abs(scrollDelta) > 5) {
          // Si hay objetivo de salto, alinear directamente el elemento objetivo cerca del borde superior del viewport
          if (vs.pendingJumpTarget >= 0) {
            const targetScroll = Math.max(0, newAnchorOffset - 20);
            vs.scrollContainer.scrollTop = targetScroll;
            debugLog('[EH Virtual] Corrección de posición de salto:', vs.pendingJumpTarget + 1, 'nueva posición de scroll:', targetScroll);
          } else {
            // 非跳转状态：保持中心元素相对位置
            vs.isJumping = true;
            vs.scrollContainer.scrollTop = oldScrollTop + scrollDelta;
            setTimeout(() => { vs.isJumping = false; }, 50);
          }
        }
      }
      
      // 更新已渲染元素的位置
      if (vs.itemsContainer) {
        const items = vs.itemsContainer.querySelectorAll('.eh-virtual-item');
        items.forEach(item => {
          const idx = parseInt(item.getAttribute('data-virtual-index'));
          if (idx >= 0 && idx < state.pageCount) {
            item.style.top = vs.itemOffsets[idx] + 'px';
            item.style.height = vs.itemHeights[idx] + 'px';
          }
        });
      }
      
      debugLog('[EH Virtual] Recálculo de offsets completado, nueva altura total:', vs.totalHeight);
    }

    // Encontrar el índice del elemento en el centro del viewport
    function findCenterIndex(scrollTop) {
      const vs = virtualScroll;
      const centerY = scrollTop + vs.viewportHeight / 2;
      
      for (let i = 0; i < state.pageCount; i++) {
        const top = vs.itemOffsets[i];
        const bottom = top + vs.itemHeights[i];
        if (centerY >= top && centerY < bottom) {
          return i;
        }
      }
      return 0;
    }
    
    // Actualizar layout desde un índice dado (obsoleto, reemplazado por recalcVirtualOffsets)
    function updateVirtualLayoutFrom(fromIndex) {
      const vs = virtualScroll;
      const availableWidth = vs.containerWidth - vs.sidePadding * 2;

      for (let i = fromIndex; i < state.pageCount; i++) {
        const ratio = ratioCache.get(i) || 0.7;
        const height = Math.round(availableWidth / ratio);
        vs.itemHeights[i] = height;

        const offset = i === 0 ? 0 : vs.itemOffsets[i - 1] + vs.itemHeights[i - 1] + vs.gap;
        vs.itemOffsets[i] = offset;
      }

      vs.totalHeight = vs.itemOffsets[state.pageCount - 1] + vs.itemHeights[state.pageCount - 1];

      // Actualizar altura del contenedor placeholder
      if (vs.contentContainer) {
        vs.contentContainer.style.height = vs.totalHeight + 'px';
      }

      // Actualizar posición de los elementos ya renderizados
      if (vs.itemsContainer) {
        const items = vs.itemsContainer.querySelectorAll('.eh-virtual-item');
        items.forEach(item => {
          const idx = parseInt(item.getAttribute('data-virtual-index'));
          if (idx >= fromIndex) {
            item.style.top = vs.itemOffsets[idx] + 'px';
            item.style.height = vs.itemHeights[idx] + 'px';
          }
        });
      }
    }

    // Actualizar los elementos renderizados
    function updateVirtualRendering() {
      const vs = virtualScroll;
      if (!vs.scrollContainer || !vs.itemsContainer) return;

      const scrollTop = vs.scrollContainer.scrollTop;
      const range = getVisibleRange(scrollTop);

      // Si el rango no cambió, no hace falta actualizar
      if (range.start === vs.renderedRange.start && range.end === vs.renderedRange.end) {
        return;
      }

      debugLog('[EH Virtual] Actualizar rango de renderizado:', range.start, '-', range.end, '(antes:', vs.renderedRange.start, '-', vs.renderedRange.end, ')');

      // Eliminar elementos fuera del rango
      const existingItems = vs.itemsContainer.querySelectorAll('.eh-virtual-item');
      existingItems.forEach(item => {
        const idx = parseInt(item.getAttribute('data-virtual-index'));
        if (idx < range.start || idx > range.end) {
          item.remove();
        }
      });

      // Agregar nuevos elementos
      for (let i = range.start; i <= range.end; i++) {
        const existing = vs.itemsContainer.querySelector(`[data-virtual-index="${i}"]`);
        if (!existing) {
          const item = createVirtualItem(i);
          vs.itemsContainer.appendChild(item);
        }
      }

      vs.renderedRange = range;

      // Actualizar número de página actual (solo cuando no hay salto activo)
      if (!vs.isJumping) {
        updateVirtualCurrentPage(scrollTop);
      }
    }

    // Actualizar el número de página actual según la posición de scroll (referencia filterAndSortItems + firstOrNull de JHenTai)
    // Usar el primer elemento "principalmente visible" como página actual (parte superior del elemento en la mitad superior del viewport)
    function updateVirtualCurrentPage(scrollTop) {
      const vs = virtualScroll;

      // Encontrar el primer elemento en el viewport (borde superior en el viewport o elemento que ocupa la mitad superior del viewport)
      const viewportTop = scrollTop;
      const viewportMid = scrollTop + vs.viewportHeight / 2;

      let firstVisibleIndex = -1;
      for (let i = 0; i < state.pageCount; i++) {
        const itemTop = vs.itemOffsets[i];
        const itemBottom = itemTop + vs.itemHeights[i];

        // Elemento en el viewport (parcial o totalmente visible)
        if (itemBottom > viewportTop && itemTop < viewportTop + vs.viewportHeight) {
          // Si la parte superior del elemento está en la mitad superior del viewport, o el elemento cubre la parte superior del viewport
          if (itemTop <= viewportMid || itemTop <= viewportTop) {
            firstVisibleIndex = i;
            break;
          }
        }
      }

      if (firstVisibleIndex < 0) {
        // Fallback: usar búsqueda binaria
        firstVisibleIndex = 0;
        let end = state.pageCount - 1;
        while (firstVisibleIndex < end) {
          const mid = Math.floor((firstVisibleIndex + end) / 2);
          if (vs.itemOffsets[mid] + vs.itemHeights[mid] < viewportTop) {
            firstVisibleIndex = mid + 1;
          } else {
            end = mid;
          }
        }
      }
      
      const pageNum = firstVisibleIndex + 1;
      if (pageNum !== state.currentPage) {
        state.currentPage = pageNum;
        if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
        if (elements.progressBar) elements.progressBar.value = pageNum;
        updateThumbnailHighlight(pageNum);
        saveProgress(pageNum);
      }
    }
    
  // Saltar a una página específica (versión con desplazamiento virtual)
  // 🎯 Basado en scrollTo(index:) de JHenTai - posicionamiento por índice con corrección automática ante cambios de layout
  function jumpToVirtualPage(pageNum) {
    const vs = virtualScroll;
    if (!vs.scrollContainer) return;
    
    const index = pageNum - 1;
    if (index < 0 || index >= state.pageCount) return;
    
    vs.isJumping = true;
    
    // 🎯 Clave: registrar el índice objetivo para corregir la posición si cambia el layout
    vs.pendingJumpTarget = index;
    
    // Limpiar el temporizador de estabilización anterior
    if (vs.jumpStabilizeTimer) {
      clearTimeout(vs.jumpStabilizeTimer);
      vs.jumpStabilizeTimer = null;
    }
    
    // Calcular la posición de scroll objetivo (alinear el elemento cerca del tope del viewport con margen)
    const itemTop = vs.itemOffsets[index];
    const targetScroll = Math.max(0, itemTop - 20);
    
    vs.scrollContainer.scrollTop = targetScroll;
    
    // Actualizar renderizado inmediatamente sin cambiar la página
    updateVirtualRendering();
    
    // Establecer manualmente el número de página
    state.currentPage = pageNum;
    if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
    if (elements.progressBar) elements.progressBar.value = pageNum;
    updateThumbnailHighlight(pageNum);
    saveProgress(pageNum);
    
    // 🎯 Después del salto, esperar más tiempo para que las imágenes carguen y corregir posición continuamente
    // Después de 2 segundos se limpia pendingJumpTarget y se considera estable
    vs.jumpStabilizeTimer = setTimeout(() => {
      vs.pendingJumpTarget = -1;
      vs.isJumping = false;
      vs.jumpStabilizeTimer = null;
      debugLog('[EH Virtual] Salto estabilizado');
    }, 2000);
    
    debugLog('[EH Virtual] Saltar a página:', pageNum, 'posición de scroll:', targetScroll, 'índice objetivo:', index);
  }
    async function enterContinuousVerticalMode() {
      // Ocultar el deslizador de cuentas (no necesario en modo continuo)
      if (pageSlider.slider) pageSlider.setVisible(false);
      
      // Determinar si usar desplazamiento virtual
      const useVirtualScroll = state.pageCount > VIRTUAL_SCROLL_THRESHOLD;
      
      if (useVirtualScroll) {
        debugLog('[EH Modern Reader] Habilitar modo de desplazamiento virtual, número de páginas:', state.pageCount);
        await enterVirtualVerticalMode();
        return;
      }
      
      // Modo de desplazamiento no virtual original (reservado para galerías pequeñas)
      // Modo continuo vertical: desplazamiento vertical
      if (!continuous.container) {
        // Precargar las relaciones de aspecto de todas las imágenes (esperar bloqueando para completar, evitar sacudidas de diseño durante la carga)
        try {
          await preloadImageRatios();
        } catch (err) {
          console.warn('[EH Modern Reader] Falló la precarga en modo vertical:', err);
        }

        continuous.container = document.createElement('div');
        continuous.container.id = 'eh-continuous-vertical';
        const CV_GAP = Math.max(0, Math.min(100, Number(state.settings.verticalGap ?? 0))); // Usar espaciado configurado por el usuario
        const CV_PAD = 12; // Relleno superior e inferior
        const userSidePad = Math.max(0, Math.min(1000, Number(state.settings.verticalSidePadding ?? 0)));
        continuous.container.style.cssText = `display:flex; flex-direction:column; align-items:center; gap:${CV_GAP}px; overflow-y:auto; overflow-x:hidden; height:100%; width:100%; padding:${CV_PAD}px ${userSidePad}px; overflow-anchor:none;`;
        // Agregar clase cuando espaciado es cero, remover bordes del esqueleto
        if (CV_GAP === 0) {
          continuous.container.classList.add('eh-no-gap-vertical');
        }
        
        // Voltear verticalmente en modo inverso
        if (state.settings.reverse) {
          continuous.container.style.transform = 'scaleY(-1)';
        }

        // Generar tarjetas de marcador de posición (precarga llena ratioCache, usar 0.7 por defecto si no hay caché)
        for (let i = 0; i < state.pageCount; i++) {
          const card = document.createElement('div');
          card.className = 'eh-cv-card';
          // 🎯 Usar contain: layout para hacer cada tarjeta un contexto de diseño independiente, evitar reordenamiento global durante la carga de imágenes
          card.style.cssText = 'flex:0 0 auto; width:100%; position:relative; display:flex; justify-content:center; contain:layout;';

          const wrapper = document.createElement('div');
          wrapper.className = 'eh-cv-wrapper eh-cv-skeleton';
          wrapper.style.cssText = 'width:100%; aspect-ratio: var(--eh-aspect, 0.7); position:relative; max-width:100%; display:flex; will-change:contents;';
          
          // En modo inverso, cada imagen también debe voltearse de vuelta
          if (state.settings.reverse) {
            wrapper.style.transform = 'scaleY(-1)';
          }
          
          // Usar relación real precargada, 0.7 por defecto si no hay caché
          const cachedR = ratioCache.get(i);
          wrapper.style.setProperty('--eh-aspect', String(cachedR || 0.7));

          const img = document.createElement('img');
          img.style.cssText = 'width:100%; height:100%; display:block; object-fit:contain;';
          img.setAttribute('data-page-index', String(i));

          wrapper.appendChild(img);
          card.appendChild(wrapper);
          continuous.container.appendChild(card);
        }

        // Colocar en el área principal y ocultar el visor de página única
        const main = document.getElementById('eh-main');
        if (main) {
          main.appendChild(continuous.container);
          const singleViewer = document.getElementById('eh-viewer');
          if (singleViewer) singleViewer.style.display = 'none';
        }

        // Aplicar estado inverso
        try { if (typeof applyReverseState === 'function') applyReverseState(); } catch {}

        // Aplicar relación de aspecto y remover esqueleto
        // 🎯 Optimización 1: Si ya hay una relación preestablecida y la diferencia no es grande, no actualizar (evitar sacudidas durante el desplazamiento automático)
        // 🎯 Optimización 2: Durante el desplazamiento automático, bloquear completamente el diseño, solo actualizar src de imagen (no activar reflow)
        function applyAspectFor(imgEl, loadedImg) {
          try {
            if (!imgEl) return;
            const wrap = imgEl.parentElement;
            const card = wrap?.parentElement;
            const w = loadedImg?.naturalWidth || loadedImg?.width;
            const h = loadedImg?.naturalHeight || loadedImg?.height;
            if (wrap && w && h && h > 0) {
              // 🎯 Durante desplazamiento automático: solo remover estilo de esqueleto, no actualizar aspect-ratio
              if (autoScrollLockLayout) {
                wrap.classList.remove('eh-cv-skeleton');
                return;
              }
              const newRatio = Math.max(0.02, Math.min(5, w / h));
              const currentRatio = parseFloat(wrap.style.getPropertyValue('--eh-aspect')) || 0.7;
              // Solo actualizar cuando la diferencia de relación exceda el 5% (reducir reordenamiento de diseño)
              const diff = Math.abs(newRatio - currentRatio) / currentRatio;
              if (diff > 0.05 || currentRatio === 0.7) {
                wrap.style.setProperty('--eh-aspect', String(newRatio));
              }
              // Establecer altura explícitamente, asegurar que se mantenga la relación de aspecto en navegadores que no la soportan
              const container = continuous.container;
              if (container) {
                // 🎯 Usar valores de configuración en tiempo real en lugar de valores capturados por cierre, asegurar que los ajustes de relleno lateral tomen efecto inmediatamente
                const currentSidePad = state.settings.verticalSidePadding ?? 0;
                const availableWidth = container.clientWidth - currentSidePad * 2;
                const realHeight = Math.round(availableWidth / newRatio);
                wrap.style.height = realHeight + 'px';
                if (card) {
                  card.style.height = realHeight + 'px';
                }
              }
              wrap.classList.remove('eh-cv-skeleton');
            }
          } catch {}
        }

        // Observador de carga diferida
        continuous.observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const img = entry.target;
              const idx = parseInt(img.getAttribute('data-page-index'));
              if (!img.src && !img.getAttribute('data-loading')) {
                img.setAttribute('data-loading', 'true');
                
                const cached = state.imageCache.get(idx);
                if (cached && cached.status === 'loaded' && cached.img && cached.img.src) {
                  // Ya completado - mostrar directamente
                  img.src = cached.img.src;
                  applyAspectFor(img, cached.img);
                  img.removeAttribute('data-loading');
                } else if (cached && cached.status === 'loading' && cached.promise) {
                  cached.promise.then(loadedImg => {
                    if (loadedImg && loadedImg.src) {
                      img.src = loadedImg.src;
                    }
                    applyAspectFor(img, loadedImg);
                  }).catch(err => {
                    console.warn('[EH Modern Reader] Falló la carga de imagen en modo vertical:', idx, err);
                  }).finally(() => {
                    img.removeAttribute('data-loading');
                  });
                } else {
                  loadImage(idx).then(loadedImg => {
                    if (loadedImg && loadedImg.src) {
                      img.src = loadedImg.src;
                    }
                    applyAspectFor(img, loadedImg);
                  }).catch(err => {
                    console.warn('[EH Modern Reader] Falló la carga de imagen en modo vertical:', idx, err);
                  }).finally(() => {
                    img.removeAttribute('data-loading');
                  });
                }
              }
            }
          });
        }, { root: continuous.container, rootMargin: '1200px', threshold: 0.01 });

        // Observar todas las imágenes
        continuous.container.querySelectorAll('img[data-page-index]').forEach(img => {
          continuous.observer.observe(img);
        });

        // No es necesario mapear la rueda, el desplazamiento vertical es el comportamiento predeterminado
        // Pero aún predecir la dirección de cambio de página para precargar
        continuous.container.addEventListener('wheel', (e) => {
          const forward = e.deltaY > 0; // true: desplazar hacia abajo
          const logicalDir = forward ? 1 : -1;
          const base = state.currentPage - 1;
          const targets = [];
          for (let i = 1; i <= 4; i++) {
            const idx = base + logicalDir * i;
            if (idx >= 0 && idx < state.pageCount) targets.push(idx);
          }
          if (targets.length) enqueuePrefetch(targets, true);
        }, { passive: true });

        // 🖱️ Soporte de desplazamiento por arrastre del mouse (misma sensación que JHenTai)
        let isMouseDraggingV = false;
        let dragStartY = 0;
        let dragScrollTop = 0;
        let dragMovedV = false; // Marcar si realmente se movió

        continuous.container.addEventListener('mousedown', (e) => {
          // Excluir botones y menús
          if (e.button !== 0) return; // Solo responder al clic izquierdo
          if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) return;
          
          isMouseDraggingV = true;
          dragMovedV = false;
          dragStartY = e.pageY;
          dragScrollTop = continuous.container.scrollTop;
          continuous.container.style.cursor = 'grabbing';
          continuous.container.style.userSelect = 'none';
          e.preventDefault();
        });

        const onMouseMoveV = (e) => {
          if (!isMouseDraggingV) return;
          const deltaY = e.pageY - dragStartY;
          if (Math.abs(deltaY) > 5) dragMovedV = true; // Considerar arrastre si supera 5px
          // El modo inverso necesita invertir la dirección de arrastre
          const dirVisual = state.settings.reverse ? 1 : -1;
          continuous.container.scrollTop = dragScrollTop + deltaY * dirVisual;
        };

        const onMouseUpV = () => {
          if (!isMouseDraggingV) return;
          isMouseDraggingV = false;
          continuous.container.style.cursor = '';
          continuous.container.style.userSelect = '';
          // Si hubo arrastre, bloquear brevemente el evento de clic
          if (dragMovedV) {
            setTimeout(() => { dragMovedV = false; }, 50);
          }
        };

        // Escuchar en document para que el arrastre pueda continuar cuando el mouse salga del contenedor
        document.addEventListener('mousemove', onMouseMoveV);
        document.addEventListener('mouseup', onMouseUpV);

        // Modo continuo vertical: clic en tercios superior/medio/inferior
        continuous.container.addEventListener('click', (e) => {
          // Si acaba de arrastrar, ignorar este clic
          if (dragMovedV) {
            e.stopPropagation();
            return;
          }
          if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) {
            return;
          }
          const rect = continuous.container.getBoundingClientRect();
          const rawY = e.clientY - rect.top;
          const height = rect.height;
          const clickY = state.settings.reverse ? (height - rawY) : rawY;
          const topThreshold = height / 3;
          const bottomThreshold = height * 2 / 3;
          
          // Medio alterna barra superior + menú inferior
          if (clickY >= topThreshold && clickY <= bottomThreshold) {
            const header = document.getElementById('eh-header');
            const main = document.getElementById('eh-main');
            const bottom = elements.bottomMenu;
            if (header) {
              const isHidden = header.classList.toggle('eh-hidden');
              if (main) main.classList.toggle('eh-fullheight', isHidden);
              if (bottom) {
                bottom.classList.toggle('eh-menu-hidden', isHidden);
              }
              debugLog('[EH Modern Reader] Clic medio en modo vertical -> alternar barra superior/menú inferior, hidden=', isHidden);
            }
            e.stopPropagation();
            return;
          }
          
          // Arriba/abajo mover por página
          let direction = 0;
          if (clickY < topThreshold) {
            direction = state.settings.reverse ? 1 : -1;
          } else if (clickY > bottomThreshold) {
            direction = state.settings.reverse ? -1 : 1;
          } else {
            return;
          }
          const target = Math.max(1, Math.min(state.pageCount, state.currentPage + direction));
          scheduleShowPage(target, { immediate: true });
          debugLog('[EH Modern Reader] Área de clic en modo vertical:', clickY < topThreshold ? 'SUPERIOR' : 'INFERIOR', 'reverse=', !!state.settings.reverse, '→ target=', target);
          e.stopPropagation();
        });

        // Al desplazar, actualizar página actual basada en elemento centrado
        let scrollUpdating = false;
        let lastScrollUpdate = 0;
        const onScroll = () => {
          if (scrollJumping || scrollUpdating) return;
          // 🎯 Durante desplazamiento automático: limitar a 1 vez cada 300ms, no omitir completamente
          const now = performance.now();
          if (autoScrollLockLayout && now - lastScrollUpdate < 300) return;
          lastScrollUpdate = now;
          scrollUpdating = true;
          requestAnimationFrame(() => {
            try {
              const viewportMid = continuous.container.clientHeight / 2;
              let bestIdx = 0; let bestDist = Infinity;
              const imgs = continuous.container.querySelectorAll('img[data-page-index]');
              imgs.forEach((img) => {
                const rect = img.getBoundingClientRect();
                const parentRect = continuous.container.getBoundingClientRect();
                const mid = rect.top - parentRect.top + rect.height / 2;
                const dist = Math.abs(mid - viewportMid);
                const idx = parseInt(img.getAttribute('data-page-index'));
                if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
              });
              
              const pageNum = bestIdx + 1;

              // Asegurar que la página central del viewport se cargue primero
              const centerImg = continuous.container.querySelector(`img[data-page-index="${bestIdx}"]`);
              if (centerImg && !centerImg.src && !centerImg.getAttribute('data-loading')) {
                cancelPrefetchExcept(bestIdx);
                centerImg.setAttribute('data-loading', 'true');
                loadImage(bestIdx).then(loadedImg => {
                  if (loadedImg && loadedImg.src) centerImg.src = loadedImg.src;
                }).catch(err => {
                  console.warn('[EH Modern Reader] Falló la carga de página central:', bestIdx, err);
                }).finally(() => {
                  centerImg.removeAttribute('data-loading');
                });
                const neighbors = [bestIdx - 2, bestIdx - 1, bestIdx + 1, bestIdx + 2].filter(i => i >= 0 && i < state.pageCount);
                enqueuePrefetch(neighbors, true);
              }

              if (pageNum !== state.currentPage) {
                state.currentPage = pageNum;
                if (elements.pageInfo) elements.pageInfo.textContent = `${pageNum} / ${state.pageCount}`;
                if (elements.progressBar) {
                  elements.progressBar.value = pageNum;
                }
                updateThumbnailHighlight(pageNum);
                preloadAdjacentPages(pageNum);
                saveProgress(pageNum);
              }
            } finally {
              scrollUpdating = false;
            }
          });
        };
        continuous.container.addEventListener('scroll', onScroll);

        // Después de entrar al modo vertical, desplazar al centro de la página actual
        const targetIdx = state.currentPage - 1;
        const targetImg = continuous.container.querySelector(`img[data-page-index="${targetIdx}"]`);
        if (targetImg) {
          // Esperar dos frames para asegurar que el diseño esté completamente estable
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const c = continuous.container;
              if (!c) return; // Prevenir que el contenedor haya sido destruido
              const wrapper = targetImg.closest('.eh-cv-wrapper') || targetImg.parentElement;
              if (wrapper) {
                scrollJumping = true;
                wrapper.scrollIntoView({
                  behavior: 'auto',
                  block: 'center',
                  inline: 'center'
                });
                setTimeout(() => { scrollJumping = false; }, 50);
                debugLog('[EH Modern Reader] Desplazar al centro de página en modo vertical:', state.currentPage);
              }
            });
          });
        }
      }
    }
    
    // ==================== Entrada al modo de desplazamiento virtual horizontal ====================
    async function enterVirtualHorizontalMode() {
      const vh = virtualScrollH;
      
      // 🎯 Guardar el número de página actual (referencia initialIndex de JHenTai)
      const savedPage = state.currentPage;
      debugLog('[EH VirtualH] Guardar número de página actual:', savedPage);
      
      // Establecer bandera de salto para prevenir que el número de página sea sobrescrito durante la inicialización
      vh.isJumping = true;
      
      // Limpiar estado anterior
      vh.knownWidths.clear();
      vh.renderedRange = { start: -1, end: -1 };
      
      // Obtener configuraciones
      vh.gap = Math.max(0, Math.min(100, Number(state.settings.horizontalGap ?? 0)));
      
      // Crear contenedor de desplazamiento
      vh.scrollContainer = document.createElement('div');
      vh.scrollContainer.id = 'eh-continuous-horizontal';
      vh.scrollContainer.style.cssText = `
        overflow-x: auto;
        overflow-y: hidden;
        height: 100%;
        width: 100%;
        position: relative;
      `;
      
      // Modo inverso
      if (state.settings.reverse) {
        vh.scrollContainer.style.transform = 'scaleX(-1)';
      }
      
      // Crear contenedor de contenido placeholder (expandir ancho de desplazamiento)
      vh.contentContainer = document.createElement('div');
      vh.contentContainer.style.cssText = `
        position: relative;
        height: 100%;
        display: inline-block;
      `;
      
      // Crear contenedor de elementos reales
      vh.itemsContainer = document.createElement('div');
      vh.itemsContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
      `;
      
      vh.contentContainer.appendChild(vh.itemsContainer);
      vh.scrollContainer.appendChild(vh.contentContainer);
      
      // Colocar en área principal
      const main = document.getElementById('eh-main');
      if (main) {
        main.appendChild(vh.scrollContainer);
        const singleViewer = document.getElementById('eh-viewer');
        if (singleViewer) singleViewer.style.display = 'none';
      }
      
      // Calcular layout
      vh.viewportWidth = vh.scrollContainer.clientWidth;
      vh.viewportHeight = vh.scrollContainer.clientHeight;
      calculateVirtualLayoutH();
      vh.contentContainer.style.width = vh.totalWidth + 'px';
      
      // Hacer que los elementos hijos sean clickeables
      vh.itemsContainer.style.pointerEvents = 'auto';
      
      // Manejo de eventos de desplazamiento
      let ticking = false;
      vh.scrollContainer.addEventListener('scroll', () => {
        if (!ticking && !vh.isJumping) {
          ticking = true;
          requestAnimationFrame(() => {
            updateVirtualRenderingH();
            ticking = false;
          });
        }
      }, { passive: true });
      
      // Mapear rueda a desplazamiento horizontal + precarga
      vh.scrollContainer.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          const dirVisual = state.settings.reverse ? -1 : 1;
          vh.scrollContainer.scrollLeft += e.deltaY * dirVisual;
          e.preventDefault();
          
          const forward = e.deltaY > 0;
          const logicalDir = forward ? 1 : -1;
          const base = state.currentPage - 1;
          const targets = [];
          for (let i = 1; i <= 6; i++) {
            const idx = base + logicalDir * i;
            if (idx >= 0 && idx < state.pageCount) targets.push(idx);
          }
          if (targets.length) enqueuePrefetch(targets, true);
        }
      }, { passive: false });

      // 🖱️ Soporte de arrastre del mouse en desplazamiento virtual horizontal (misma sensación que JHenTai)
      let isMouseDraggingVH = false;
      let dragStartXVH = 0;
      let dragScrollLeftVH = 0;
      let dragMovedVH = false;

      vh.scrollContainer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) return;
        
        isMouseDraggingVH = true;
        dragMovedVH = false;
        dragStartXVH = e.pageX;
        dragScrollLeftVH = vh.scrollContainer.scrollLeft;
        vh.scrollContainer.style.cursor = 'grabbing';
        vh.scrollContainer.style.userSelect = 'none';
        e.preventDefault();
      });

      const onMouseMoveVH = (e) => {
        if (!isMouseDraggingVH) return;
        const deltaX = e.pageX - dragStartXVH;
        if (Math.abs(deltaX) > 5) dragMovedVH = true;
        const dirVisual = state.settings.reverse ? 1 : -1;
        vh.scrollContainer.scrollLeft = dragScrollLeftVH + deltaX * dirVisual;
      };

      const onMouseUpVH = () => {
        if (!isMouseDraggingVH) return;
        isMouseDraggingVH = false;
        vh.scrollContainer.style.cursor = '';
        vh.scrollContainer.style.userSelect = '';
        if (dragMovedVH) {
          setTimeout(() => { dragMovedVH = false; }, 50);
        }
      };

      document.addEventListener('mousemove', onMouseMoveVH);
      document.addEventListener('mouseup', onMouseUpVH);
      
      // Manejo de clics
      vh.scrollContainer.addEventListener('click', (e) => {
        // Si acaba de arrastrar, ignorar este clic
        if (dragMovedVH) {
          e.stopPropagation();
          return;
        }
        if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) {
          return;
        }
        const rect = vh.scrollContainer.getBoundingClientRect();
        const rawX = e.clientX - rect.left;
        const width = rect.width;
        const clickX = state.settings.reverse ? (width - rawX) : rawX;
        const leftThreshold = width / 3;
        const rightThreshold = width * 2 / 3;
        
        if (clickX >= leftThreshold && clickX <= rightThreshold) {
          const header = document.getElementById('eh-header');
          const mainEl = document.getElementById('eh-main');
          const bottom = elements.bottomMenu;
          if (header) {
            const isHidden = header.classList.toggle('eh-hidden');
            if (mainEl) mainEl.classList.toggle('eh-fullheight', isHidden);
            if (bottom) bottom.classList.toggle('eh-menu-hidden', isHidden);
          }
          e.stopPropagation();
          return;
        }
        
        let direction = 0;
        if (clickX < leftThreshold) {
          direction = state.settings.reverse ? 1 : -1;
        } else if (clickX > rightThreshold) {
          direction = state.settings.reverse ? -1 : 1;
        } else {
          return;
        }
        const target = Math.max(1, Math.min(state.pageCount, state.currentPage + direction));
        jumpToVirtualPageH(target);
        e.stopPropagation();
      });
      
      // Renderizado inicial
      updateVirtualRenderingH();
      
      // Saltar al número de página guardado (no al state.currentPage que puede haber sido modificado)
      state.currentPage = savedPage; // Restaurar número de página
      jumpToVirtualPageH(savedPage);
      
      // Marcar como modo de desplazamiento virtual
      vh.enabled = true;
      continuous.container = vh.scrollContainer; // Compatibilidad con lógica de salida
      
      // Aplicar estado inverso
      try { if (typeof applyReverseState === 'function') applyReverseState(); } catch {}
      
      debugLog('[EH VirtualH] Modo de desplazamiento virtual horizontal iniciado');
    }
    
    // ==================== Entrada al modo de desplazamiento virtual vertical ====================
    async function enterVirtualVerticalMode() {
      const vs = virtualScroll;
      
      // No precargar más las relaciones de aspecto - usar altura predeterminada, ajustar dinámicamente después de cargar imágenes
      // Esto permite mostrar la interfaz inmediatamente, sin retrasos
      
      // 🎯 Guardar el número de página actual (referencia initialIndex de JHenTai)
      const savedPage = state.currentPage;
      debugLog('[EH Virtual] Guardar número de página actual:', savedPage);
      
      // Establecer bandera de salto para prevenir que el número de página sea sobrescrito durante la inicialización
      vs.isJumping = true;
      
      // Limpiar estado anterior
      vs.knownHeights.clear();
      vs.renderedRange = { start: -1, end: -1 };
      
      // Obtener configuraciones
      vs.gap = Math.max(0, Math.min(100, Number(state.settings.verticalGap ?? 0)));
      vs.sidePadding = Math.max(0, Math.min(1000, Number(state.settings.verticalSidePadding ?? 0)));
      
      // Crear contenedor de desplazamiento
      vs.scrollContainer = document.createElement('div');
      vs.scrollContainer.id = 'eh-continuous-vertical';
      vs.scrollContainer.style.cssText = `
        overflow-y: auto;
        overflow-x: hidden;
        height: 100%;
        width: 100%;
        position: relative;
      `;
      // Agregar clase cuando espaciado es cero, remover bordes del esqueleto
      if ((state.settings.verticalGap ?? 0) === 0) {
        vs.scrollContainer.classList.add('eh-no-gap-vertical');
      }
      
      // Modo inverso
      if (state.settings.reverse) {
        vs.scrollContainer.style.transform = 'scaleY(-1)';
      }
      
      // Crear contenedor de contenido placeholder (expandir altura de desplazamiento)
      vs.contentContainer = document.createElement('div');
      vs.contentContainer.style.cssText = `
        position: relative;
        width: 100%;
      `;
      
      // Crear contenedor de elementos reales
      vs.itemsContainer = document.createElement('div');
      vs.itemsContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
      `;
      // Permitir que los elementos hijos reciban eventos
      vs.itemsContainer.querySelectorAll = vs.itemsContainer.querySelectorAll.bind(vs.itemsContainer);
      
      vs.contentContainer.appendChild(vs.itemsContainer);
      vs.scrollContainer.appendChild(vs.contentContainer);
      
      // Colocar en área principal
      const main = document.getElementById('eh-main');
      if (main) {
        main.appendChild(vs.scrollContainer);
        const singleViewer = document.getElementById('eh-viewer');
        if (singleViewer) singleViewer.style.display = 'none';
      }
      
      // Calcular layout
      vs.viewportHeight = vs.scrollContainer.clientHeight;
      vs.containerWidth = vs.scrollContainer.clientWidth;
      calculateVirtualLayout();
      vs.contentContainer.style.height = vs.totalHeight + 'px';
      
      // Hacer que los elementos hijos sean clickeables
      vs.itemsContainer.style.pointerEvents = 'auto';
      
      // Manejo de eventos de desplazamiento
      let ticking = false;
      vs.scrollContainer.addEventListener('scroll', () => {
        if (!ticking && !vs.isJumping) {
          ticking = true;
          requestAnimationFrame(() => {
            updateVirtualRendering();
            ticking = false;
          });
        }
      }, { passive: true });
      
      // Precarga con rueda
      vs.scrollContainer.addEventListener('wheel', (e) => {
        const forward = e.deltaY > 0;
        const logicalDir = forward ? 1 : -1;
        const base = state.currentPage - 1;
        const targets = [];
        for (let i = 1; i <= 6; i++) {
          const idx = base + logicalDir * i;
          if (idx >= 0 && idx < state.pageCount) targets.push(idx);
        }
        if (targets.length) enqueuePrefetch(targets, true);
      }, { passive: true });

      // 🖱️ Soporte de arrastre del mouse en modo de desplazamiento virtual (misma sensación que JHenTai)
      let isMouseDraggingVS = false;
      let dragStartYVS = 0;
      let dragScrollTopVS = 0;
      let dragMovedVS = false;

      vs.scrollContainer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) return;
        
        isMouseDraggingVS = true;
        dragMovedVS = false;
        dragStartYVS = e.pageY;
        dragScrollTopVS = vs.scrollContainer.scrollTop;
        vs.scrollContainer.style.cursor = 'grabbing';
        vs.scrollContainer.style.userSelect = 'none';
        e.preventDefault();
      });

      const onMouseMoveVS = (e) => {
        if (!isMouseDraggingVS) return;
        const deltaY = e.pageY - dragStartYVS;
        if (Math.abs(deltaY) > 5) dragMovedVS = true;
        const dirVisual = state.settings.reverse ? 1 : -1;
        vs.scrollContainer.scrollTop = dragScrollTopVS + deltaY * dirVisual;
      };

      const onMouseUpVS = () => {
        if (!isMouseDraggingVS) return;
        isMouseDraggingVS = false;
        vs.scrollContainer.style.cursor = '';
        vs.scrollContainer.style.userSelect = '';
        if (dragMovedVS) {
          setTimeout(() => { dragMovedVS = false; }, 50);
        }
      };

      document.addEventListener('mousemove', onMouseMoveVS);
      document.addEventListener('mouseup', onMouseUpVS);
      
      // Manejo de clics
      vs.scrollContainer.addEventListener('click', (e) => {
        // Si acaba de arrastrar, ignorar este clic
        if (dragMovedVS) {
          e.stopPropagation();
          return;
        }
        if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('#eh-bottom-menu')) {
          return;
        }
        const rect = vs.scrollContainer.getBoundingClientRect();
        const rawY = e.clientY - rect.top;
        const height = rect.height;
        const clickY = state.settings.reverse ? (height - rawY) : rawY;
        const topThreshold = height / 3;
        const bottomThreshold = height * 2 / 3;
        
        if (clickY >= topThreshold && clickY <= bottomThreshold) {
          const header = document.getElementById('eh-header');
          const mainEl = document.getElementById('eh-main');
          const bottom = elements.bottomMenu;
          if (header) {
            const isHidden = header.classList.toggle('eh-hidden');
            if (mainEl) mainEl.classList.toggle('eh-fullheight', isHidden);
            if (bottom) bottom.classList.toggle('eh-menu-hidden', isHidden);
          }
          e.stopPropagation();
          return;
        }
        
        let direction = 0;
        if (clickY < topThreshold) {
          direction = state.settings.reverse ? 1 : -1;
        } else if (clickY > bottomThreshold) {
          direction = state.settings.reverse ? -1 : 1;
        } else {
          return;
        }
        const target = Math.max(1, Math.min(state.pageCount, state.currentPage + direction));
        jumpToVirtualPage(target);
        e.stopPropagation();
      });
      
      // Renderizado inicial
      updateVirtualRendering();
      
      // Saltar al número de página guardado (no al state.currentPage que puede haber sido modificado)
      state.currentPage = savedPage; // Restaurar número de página
      jumpToVirtualPage(savedPage);
      
      // Marcar como modo de desplazamiento virtual
      vs.enabled = true;
      continuous.container = vs.scrollContainer; // Compatibilidad con lógica de salida
      
      // Aplicar estado inverso
      try { if (typeof applyReverseState === 'function') applyReverseState(); } catch {}
      
      debugLog('[EH Virtual] Modo de desplazamiento virtual iniciado');
    }

    function exitContinuousMode() {
      // Salir del modo continuo (incluyendo modo normal y modo de desplazamiento virtual)
      
      // Limpiar temporizadores de recálculo de layout
      if (layoutRecalcTimer) {
        clearTimeout(layoutRecalcTimer);
        layoutRecalcTimer = null;
      }
      if (layoutRecalcTimerH) {
        clearTimeout(layoutRecalcTimerH);
        layoutRecalcTimerH = null;
      }
      
      // Limpiar estado de desplazamiento virtual vertical
      if (virtualScroll.enabled) {
        virtualScroll.enabled = false;
        virtualScroll.scrollContainer = null;
        virtualScroll.contentContainer = null;
        virtualScroll.itemsContainer = null;
        virtualScroll.renderedRange = { start: -1, end: -1 };
        virtualScroll.itemHeights = [];
        virtualScroll.itemOffsets = [];
        virtualScroll.knownHeights.clear();
        debugLog('[EH Virtual] Modo de desplazamiento virtual ha salido');
      }
      
      // Limpiar estado de desplazamiento virtual horizontal
      if (virtualScrollH.enabled) {
        virtualScrollH.enabled = false;
        virtualScrollH.scrollContainer = null;
        virtualScrollH.contentContainer = null;
        virtualScrollH.itemsContainer = null;
        virtualScrollH.renderedRange = { start: -1, end: -1 };
        virtualScrollH.itemWidths = [];
        virtualScrollH.itemOffsets = [];
        virtualScrollH.knownWidths.clear();
        debugLog('[EH VirtualH] Modo de desplazamiento virtual horizontal ha salido');
      }
      
      // Mostrar visor de página única, remover contenedor continuo
      const singleViewer = document.getElementById('eh-viewer');
      if (singleViewer) singleViewer.style.display = '';
      if (continuous.observer) { continuous.observer.disconnect(); continuous.observer = null; }
      if (continuous.container && continuous.container.parentElement) {
        continuous.container.parentElement.removeChild(continuous.container);
      }
      continuous.container = null;
      // Al salir del modo continuo, cancelar precarga y carga excepto la página actual, para evitar ocupar ancho de banda
      try {
        cancelPrefetchExcept(state.currentPage - 1);
        state.imageRequests.forEach((entry, idx) => {
          if (idx !== state.currentPage - 1 && entry && entry.controller) {
            try { entry.controller.abort('exit-continuous'); } catch {}
          }
        });
      } catch {}
      // Después de volver al modo de página única, mostrar activamente la imagen de la página actual (refresco forzado, evitar mostrar imagen antigua)
      // Llamar directamente a internalShowPage para evitar retrasos y verificaciones de modo
      console.log('[EH Modern Reader] Saliendo del modo continuo, cargando página actual:', state.currentPage);
      internalShowPage(state.currentPage, { force: true });
    }

    // Fallback: En la fase de captura, priorizar el manejo de ESC para salir de pantalla completa, evitar que sea interceptado por listeners de página
    document.addEventListener('keydown', (e) => {
      try {
        if (e.key === 'Escape' && document.fullscreenElement) {
          e.stopPropagation();
          e.preventDefault();
          document.exitFullscreen();
          return;
        }
      } catch {}
    }, true);

    // Navegación por teclado y zoom
    document.addEventListener('keydown', (e) => {
      // Ignorar repeticiones de pulsación larga y estado de foco en controles de entrada
      if (e.repeat) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag && ['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
      // Atajos de teclado para zoom de imagen (+ / - / 0)
      if (e.key === '+' || e.key === '=') {
        // Ampliar
        const newScale = Math.min(5, state.settings.imageScale + 0.1);
        state.settings.imageScale = newScale;
        applyImageZoom();
        e.preventDefault();
        return;
      }
      
      if (e.key === '-' || e.key === '_') {
        // Reducir
        const newScale = Math.max(0.5, state.settings.imageScale - 0.1);
        state.settings.imageScale = newScale;
        applyImageZoom();
        e.preventDefault();
        return;
      }
      
      if (e.key === '0') {
        // Restablecer zoom
        resetImageZoom();
        e.preventDefault();
        return;
      }

      // Navegación de página
      switch(e.key) {
        case 'f':
        case 'F': {
          // Alternar mostrar/ocultar barra de miniaturas
          const container = document.getElementById('eh-thumbnails-container');
          if (container) {
            container.classList.toggle('eh-hidden');
          }
          e.preventDefault();
          break; }
        case 'h':
        case 'H':
          // Cambiar a continuo horizontal
          state.settings.readMode = 'continuous-horizontal';
          // Sincronizar estado de botones de radio
          if (elements.readModeRadios && elements.readModeRadios.length > 0) {
            elements.readModeRadios.forEach(radio => {
              if (radio.value === 'continuous-horizontal') radio.checked = true;
            });
          }
          enterContinuousHorizontalMode();
          e.preventDefault();
          break;
        case 's':
        case 'S':
          // Cambiar a página única
          state.settings.readMode = 'single';
          // Sincronizar estado de botones de radio
          if (elements.readModeRadios && elements.readModeRadios.length > 0) {
            elements.readModeRadios.forEach(radio => {
              if (radio.value === 'single') radio.checked = true;
            });
          }
          exitContinuousMode();
          e.preventDefault();
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A': {
          // Lectura inversa: flecha izquierda debería pasar a la siguiente página lógica (+1), normalmente pasar a la anterior (-1)
          const direction = state.settings.reverse ? 1 : -1;
          let target = state.currentPage + direction;
          // Navegación de página única en dirección izquierda/derecha
          
          if (target < 1 || target > state.pageCount) target = state.currentPage;
          if (target !== state.currentPage) scheduleShowPage(target);
          e.preventDefault();
          break; }
        case 'ArrowRight':
        case 'd':
        case 'D':
        case ' ': {
          // Lectura inversa: flecha derecha debería pasar a la página anterior lógica (-1), normalmente pasar a la siguiente (+1)
          const direction = state.settings.reverse ? -1 : 1;
          let target = state.currentPage + direction;
          // Navegación de página única en dirección izquierda/derecha
          
          if (target < 1 || target > state.pageCount) target = state.currentPage;
          if (target !== state.currentPage) scheduleShowPage(target);
          e.preventDefault();
          break; }
        case 'ArrowUp': {
          if (state.settings.readMode !== 'single-vertical') break;
          const direction = state.settings.reverse ? -1 : 1;
          let target = state.currentPage - direction;
          if (target < 1 || target > state.pageCount) target = state.currentPage;
          if (target !== state.currentPage) scheduleShowPage(target);
          e.preventDefault();
          break; }
        case 'ArrowDown': {
          if (state.settings.readMode !== 'single-vertical') break;
          const direction = state.settings.reverse ? -1 : 1;
          let target = state.currentPage + direction;
          if (target < 1 || target > state.pageCount) target = state.currentPage;
          if (target !== state.currentPage) scheduleShowPage(target);
          e.preventDefault();
          break; }
        case 'p':
        case 'P':
          // Alternar navegación automática de páginas
          if (state.autoPage.running) {
            // Reducir conflicto con espacio, solo efectivo cuando no hay foco en caja de entrada
            stopAutoPaging();
          } else {
            startAutoPaging();
          }
          break;
        case 'Home':
          scheduleShowPage(1);
          e.preventDefault();
          break;
        case 'End':
          scheduleShowPage(state.pageCount);
          e.preventDefault();
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
    });

    // Inicialización
    generateThumbnails();
    
    // Memoria de lectura: Priorizar usar página especificada por inicio externo, luego restaurar progreso "permanente" (chrome.storage.local / localStorage)
    const hasExplicitStartPage = (typeof pageData.startAt === 'number' && pageData.startAt >= 1 && pageData.startAt <= state.pageCount);
    let savedPage = hasExplicitStartPage ? pageData.startAt : 1;
    const gid = pageData.gid || 'nogid';
    const LS_KEY = `eh_reader_lastpage_permanent_${gid}`;
    const loadLastPagePermanent = () => new Promise((resolve) => {
      // Priorizar chrome.storage.local
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([LS_KEY], (res) => {
            const val = res && res[LS_KEY];
            resolve(typeof val === 'number' ? val : null);
          });
          return;
        }
      } catch {}
      // Fallback a localStorage
      try {
        const raw = localStorage.getItem(LS_KEY);
        resolve(raw ? parseInt(raw, 10) : null);
      } catch { resolve(null); }
    });
    // 🎯 Extraer como variable a nivel de módulo, para uso compartido de saveProgress y showPage hook
    const _saveLastPagePermanent = (page) => {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          const obj = {}; obj[LS_KEY] = page;
          chrome.storage.local.set(obj);
        } else {
          localStorage.setItem(LS_KEY, String(page));
        }
      } catch {}
    };
    try {
      loadLastPagePermanent().then((v) => {
        // Solo usar el progreso de localStorage cuando no se especifica explícitamente la página de inicio
        if (!hasExplicitStartPage && typeof v === 'number' && v >= 1 && v <= state.pageCount) {
          savedPage = v;
        }
        // Hook showPage, escribir en almacenamiento permanente después de cada visualización exitosa
        let persistTimer = null;
        const persistLastPage = () => {
          if (persistTimer) clearTimeout(persistTimer);
          persistTimer = setTimeout(() => { _saveLastPagePermanent(state.currentPage); }, 400);
        };
        const _origShowPage = showPage;
        showPage = async function(pageNum, tokenCheck){
          const r = await _origShowPage(pageNum, tokenCheck);
          persistLastPage();
          return r;
        };
        console.log('[EH Modern Reader] Restaurar última página leída:', savedPage);
        
        // Primero establecer state.currentPage al número de página guardado, para que las funciones de modo puedan desplazarse a la posición correcta
        state.currentPage = savedPage;
        
        // Aplicar modo de lectura cargado
        const loadedMode = state.settings.readMode;
        if (loadedMode && loadedMode !== 'single') {
          console.log('[EH Modern Reader] Modo de lectura cargado en inicialización:', loadedMode);
          if (loadedMode === 'continuous-horizontal') {
            enterContinuousHorizontalMode();
          } else if (loadedMode === 'continuous-vertical') {
            enterContinuousVerticalMode();
          } else if (loadedMode === 'single-vertical') {
            // single-vertical ya está configurado en state.settings.readMode, la UI lo manejará automáticamente
            console.log('[EH Modern Reader] Aplicar modo de página única vertical');
          }
        }
        
        // Entrar al lector y posicionar
        try { requestAnimationFrame(() => { try { updateThumbnailHighlight(savedPage); } catch {} }); } catch {}
        internalShowPage(savedPage);
        // Inicialización posterior de UI (tema, etc.)
        if (state.settings.darkMode) { document.body.classList.add('eh-dark-mode'); }
        try { (typeof updateThemeIcon === 'function') && updateThemeIcon(); } catch {}
        console.log('[EH Modern Reader] Inicialización del lector completada, continuar leyendo desde la página', savedPage);
      }).catch((e) => {
        console.warn('[EH Modern Reader] Falló la restauración de la memoria de lectura', e);
        
        // Primero establecer state.currentPage al número de página guardado
        state.currentPage = savedPage;
        
        // Aplicar modo de lectura cargado
        const loadedMode = state.settings.readMode;
        if (loadedMode && loadedMode !== 'single') {
          console.log('[EH Modern Reader] Modo de lectura cargado en inicialización:', loadedMode);
          if (loadedMode === 'continuous-horizontal') {
            enterContinuousHorizontalMode();
          } else if (loadedMode === 'continuous-vertical') {
            enterContinuousVerticalMode();
          } else if (loadedMode === 'single-vertical') {
            console.log('[EH Modern Reader] Aplicar modo de página única vertical');
          }
        }
        
        // Usar ruta predeterminada en caso de fallo
        try { requestAnimationFrame(() => { try { updateThumbnailHighlight(savedPage); } catch {} }); } catch {}
        internalShowPage(savedPage);
        if (state.settings.darkMode) { document.body.classList.add('eh-dark-mode'); }
        try { (typeof updateThemeIcon === 'function') && updateThemeIcon(); } catch {}
        console.log('[EH Modern Reader] Inicialización del lector completada, continuar leyendo desde la página', savedPage);
      });
      // Anticipar return para evitar ejecución repetida abajo
      return;
    } catch (e) {
      console.warn('[EH Modern Reader] Falló la inicialización del sistema de memoria de lectura', e);
    }
    // Si no se retornó temprano por excepción arriba, ejecutar ruta predeterminada aquí
    
    // Primero establecer state.currentPage al número de página guardado
    state.currentPage = savedPage;
    
    // Aplicar modo de lectura cargado
    const loadedMode = state.settings.readMode;
    if (loadedMode && loadedMode !== 'single') {
      console.log('[EH Modern Reader] Modo de lectura cargado en inicialización:', loadedMode);
      if (loadedMode === 'continuous-horizontal') {
        enterContinuousHorizontalMode();
      } else if (loadedMode === 'continuous-vertical') {
        enterContinuousVerticalMode();
      } else if (loadedMode === 'single-vertical') {
        console.log('[EH Modern Reader] Aplicar modo de página única vertical');
      }
    }
    
    try { requestAnimationFrame(() => { try { updateThumbnailHighlight(savedPage); } catch {} }); } catch {}
    internalShowPage(savedPage);
    if (state.settings.darkMode) { document.body.classList.add('eh-dark-mode'); }
    try { (typeof updateThemeIcon === 'function') && updateThemeIcon(); } catch {}
    console.log('[EH Modern Reader] Inicialización del lector completada, continuar leyendo desde la página', savedPage);
  }

  /**
   * Inicialización
   */
  function init() {
    // Escuchar evento de inicio del modo Gallery
    document.addEventListener('ehGalleryReaderReady', (e) => {
      console.log('[EH Modern Reader] Gallery reader ready event received');
      const galleryData = e.detail || window.__ehReaderData;
      if (galleryData && galleryData.imagelist) {
        console.log('[EH Modern Reader] Starting from Gallery mode with', galleryData.pagecount, 'pages');
        injectModernReader(galleryData);
      }
    });

    // Si no es página MPV, esperar evento Gallery
    if (!window.location.pathname.includes('/mpv/')) {
      console.log('[EH Modern Reader] Waiting for Gallery bootstrap...');
      return;
    }

    // Inicialización del modo MPV
    try {
      // Optimizador de espera: usar exponential backoff en lugar de polling fijo de 50ms
      // Reducir uso de CPU mientras falla rápidamente
      const waitForImagelist = (timeoutMs = 3000) => new Promise((resolve) => {
        const start = Date.now();
        let interval = 10; // Inicial 10ms
        let nextCheck = 10;
        
        const check = () => {
          const cap = window.__ehCaptured || {};
          if (Array.isArray(cap.imagelist) && cap.imagelist.length > 0) {
            resolve(true);
            return;
          }
          
          const elapsed = Date.now() - start;
          if (elapsed >= timeoutMs) {
            resolve(false);
            return;
          }
          
          // Exponential backoff: 10->20->40->80->...->300ms (max)
          nextCheck = Math.min(300, interval);
          interval = interval < 150 ? interval * 2 : 300;
          setTimeout(check, nextCheck);
        };
        
        check();
      });

      // Fallback: capturar directamente el HTML de la página MPV actual y parsear imagelist
      async function fallbackFetchImagelist() {
        try {
          const resp = await fetch(window.location.href, { cache: 'no-store', credentials: 'same-origin' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const html = await resp.text();
          const data = { imagelist: [], gid: null, mpvkey: null, pagecount: null, gallery_url: null, title: document.title.replace(/ - E-Hentai.*/, '') };
          const listMatch = html.match(/var\s+imagelist\s*=\s*(\[[\s\S]*?\]);/);
          if (listMatch) {
            try { data.imagelist = JSON.parse(listMatch[1]); } catch {}
          }
          const gidMatch = html.match(/var\s+gid\s*=\s*(\d+);/);
          if (gidMatch) data.gid = gidMatch[1];
          const keyMatch = html.match(/var\s+mpvkey\s*=\s*"([^"]+)";/);
          if (keyMatch) data.mpvkey = keyMatch[1];
          const countMatch = html.match(/var\s+pagecount\s*=\s*(\d+);/);
          if (countMatch) data.pagecount = parseInt(countMatch[1]);
          const gurlMatch = html.match(/var\s+gallery_url\s*=\s*"([^"]+)";/);
          if (gurlMatch) data.gallery_url = gurlMatch[1];
          if (Array.isArray(data.imagelist) && data.imagelist.length > 0) {
            return data;
          }
        } catch (e) {
          console.warn('[EH Modern Reader] fallbackFetchImagelist falló:', e);
        }
        return null;
      }

      // Esperar a que el DOM se cargue completamente
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          // Modo Gallery: iniciar directamente
          if (window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled) {
            console.log('[EH Modern Reader] Inicio del modo Gallery');
            const galleryData = window.__ehReaderData;
            if (galleryData && galleryData.imagelist) {
              injectModernReader(galleryData);
              return;
            }
          }

          // Modo MPV: lógica original (optimizada para extracción paralela)
          try {
            const pageData = extractPageData();
            if (pageData.imagelist && pageData.imagelist.length > 0) {
              console.log('[EH Modern Reader] Ruta rápida: extracción directa del DOM exitosa');
              injectModernReader(pageData);
            } else {
              // Disparar en paralelo waitForImagelist y fallbackFetchImagelist, en lugar de serial
              console.log('[EH Modern Reader] Ruta lenta: esperar datos o capturar desde origen');
              Promise.race([
                waitForImagelist().then(() => {
                  console.log('[EH Modern Reader] Captura de MutationObserver exitosa');
                  const retryData = extractPageData();
                  if (retryData.imagelist && retryData.imagelist.length > 0) {
                    return retryData;
                  }
                  throw new Error('Aún no hay imagelist después de esperar');
                }),
                fallbackFetchImagelist().then((data) => {
                  if (data && data.imagelist && data.imagelist.length > 0) {
                    console.log('[EH Modern Reader] Captura desde origen exitosa');
                    return data;
                  }
                  throw new Error('Captura desde origen fallida');
                })
              ]).then((finalData) => {
                console.log('[EH Modern Reader] Inicializar con datos obtenidos en paralelo');
                injectModernReader(finalData);
              }).catch((e) => {
                console.error('[EH Modern Reader] Todas las inicializaciones paralelas fallaron:', e);
                alert('EH Modern Reader: No se pudo cargar la lista de imágenes, por favor refresca la página e intenta de nuevo.');
              });
            }
          } catch (e) {
            console.error('[EH Modern Reader] Inicialización fallida:', e);
            alert(`EH Modern Reader inicialización fallida: ${e.message}\n\nPor favor refresca la página e intenta de nuevo o contacta al desarrollador.`);
          }
        });
      } else {
        // Modo Gallery: iniciar directamente
        if (window.__ehGalleryBootstrap && window.__ehGalleryBootstrap.enabled) {
          console.log('[EH Modern Reader] Inicio del modo Gallery (readyState=complete)');
          const galleryData = window.__ehReaderData;
          if (galleryData && galleryData.imagelist) {
            injectModernReader(galleryData);
            return;
          }
        }

        // Modo MPV: lógica original (optimizada para extracción paralela)
        const pageData = extractPageData();
        if (pageData.imagelist && pageData.imagelist.length > 0) {
          console.log('[EH Modern Reader] Ruta rápida: extracción directa del DOM exitosa');
          injectModernReader(pageData);
        } else {
          // Disparar en paralelo, acelerar velocidad de inicialización
          console.log('[EH Modern Reader] Ruta lenta: esperar datos o capturar desde origen');
          Promise.race([
            waitForImagelist().then(() => {
              console.log('[EH Modern Reader] Captura de MutationObserver exitosa');
              const retryData = extractPageData();
              if (retryData.imagelist && retryData.imagelist.length > 0) {
                return retryData;
              }
              throw new Error('Aún no hay imagelist después de esperar');
            }),
            fallbackFetchImagelist().then((data) => {
              if (data && data.imagelist && data.imagelist.length > 0) {
                console.log('[EH Modern Reader] Captura desde origen exitosa');
                return data;
              }
              throw new Error('Captura desde origen fallida');
            })
          ]).then((finalData) => {
            console.log('[EH Modern Reader] Inicializar con datos obtenidos en paralelo');
            injectModernReader(finalData);
          }).catch((e) => {
            console.error('[EH Modern Reader] Todas las inicializaciones paralelas fallaron:', e);
            alert('EH Modern Reader: No se pudo cargar la lista de imágenes, por favor refresca la página e intenta de nuevo.');
          });
        }
      }
    } catch (e) {
      console.error('[EH Modern Reader] Inicialización fallida:', e);
      alert(`EH Modern Reader inicialización fallida: ${e.message}\n\nPor favor refresca la página e intenta de nuevo o contacta al desarrollador.`);
    }
  }

  init();
})();
