/**
 * Gallery Script - Script de entrada de la página Gallery
 * Proporciona acceso al lector para usuarios sin permisos MPV
 */

// Interruptor de depuración: lee eh_debug_mode de chrome.storage.local
let debugModeEnabled = false;
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['eh_debug_mode'], (result) => {
      debugModeEnabled = result.eh_debug_mode === true;
    });
  }
} catch (e) {
  // Ignorar el error, mantener debugModeEnabled = false
}

/**
 * Función de depuración: solo se muestra cuando el modo de depuración está activo
 * @param {...any} args - Parámetros pasados a console.log
 */
function debugLog(...args) {
  if (debugModeEnabled) {
    console.log(...args);
  }
}

(function() {
  'use strict';

  // Evitar inyección duplicada
  if (window.ehGalleryBootstrapInjected) {
    return;
  }
  window.ehGalleryBootstrapInjected = true;

  debugLog('[EH Reader] Gallery bootstrap script loaded');

  // Capturar variables del script de la página
  function extractPageVariables() {
    const data = {
      gid: null,
      token: null,
      apiUrl: 'https://api.e-hentai.org/api.php',
      apiuid: null,
      apikey: null,
      title: document.querySelector('#gn')?.textContent || document.title,
      baseUrl: 'https://e-hentai.org/'
    };

    // Extraer gid y token de la URL primero (método más fiable)
    // Formato de URL: https://e-hentai.org/g/3032923/bf5e303c3d/
    const urlMatch = window.location.pathname.match(/\/g\/(\d+)\/([a-f0-9]+)/);
    if (urlMatch) {
      data.gid = parseInt(urlMatch[1]);
      data.token = urlMatch[2];
      debugLog('[EH Reader] Extracted from URL: gid=' + data.gid + ', token=' + data.token);
    }

    // Recorrer todas las etiquetas script (como respaldo o complemento)
    const scripts = document.querySelectorAll('script');
    for (let script of scripts) {
      const content = script.textContent;
      if (!content) continue;

      // Extraer gid (si no se obtuvo de la URL)
      if (!data.gid) {
        const gidMatch = content.match(/var\s+gid\s*=\s*(\d+);?/);
        if (gidMatch) data.gid = parseInt(gidMatch[1]);
      }

      // Extraer token (si no se obtuvo de la URL)
      if (!data.token) {
        const tokenMatch = content.match(/var\s+token\s*=\s*["']([^"']+)["'];?/);
        if (tokenMatch) data.token = tokenMatch[1];
      }

      // Extraer api_url
      if (!data.apiUrl) {
        const apiMatch = content.match(/var\s+api_url\s*=\s*["']([^"']+)["'];?/);
        if (apiMatch) data.apiUrl = apiMatch[1];
      }

      // Extraer apiuid
      if (!data.apiuid) {
        const uidMatch = content.match(/var\s+apiuid\s*=\s*(\d+);?/);
        if (uidMatch) data.apiuid = parseInt(uidMatch[1]);
      }

      // Extraer apikey
      if (!data.apikey) {
        const keyMatch = content.match(/var\s+apikey\s*=\s*["']([^"']+)["'];?/);
        if (keyMatch) data.apikey = keyMatch[1];
      }

      // Extraer base_url
      const baseMatch = content.match(/var\s+base_url\s*=\s*["']([^"']+)["'];?/);
      if (baseMatch) data.baseUrl = baseMatch[1];
    }

    return data;
  }

  const pageData = extractPageVariables();
  debugLog('[EH Reader] Page data captured:', pageData);

  // Verificar si ya existe un enlace MPV (usuarios con permisos)
  const mpvLink = document.querySelector('a[href*="/mpv/"]');
  
  // Sin gid/token no se puede iniciar
  if (!pageData.gid || !pageData.token) {
    console.warn('[EH Reader] Missing gid or token, cannot initialize');
    return;
  }

  /**
   * Obtener datos de la galería mediante la API
   */
  async function fetchGalleryMetadata() {
    try {
      const response = await fetch(pageData.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'gdata',
          gidlist: [[pageData.gid, pageData.token]],
          namespace: 1
        })
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.gmetadata && data.gmetadata[0]) {
        const metadata = data.gmetadata[0];
        debugLog('[EH Reader] Gallery metadata:', metadata);
        
        // Si se devuelve un error
        if (metadata.error) {
          throw new Error(metadata.error);
        }
        
        return {
          gid: metadata.gid,
          token: metadata.token,
          title: metadata.title,
          title_jpn: metadata.title_jpn,
          category: metadata.category,
          filecount: metadata.filecount,
          tags: metadata.tags
        };
      }
      
      throw new Error('No metadata returned');
    } catch (error) {
      console.error('[EH Reader] Failed to fetch gallery metadata:', error);
      throw error;
    }
  }

  // Cachear solicitudes de paginación de Gallery en curso para evitar duplicados
  const galleryPageFetchCache = new Map(); // galleryPageIndex -> Promise
  
  // Guardar el número de miniaturas por página (detectado antes de reemplazar el DOM)
  let detectedThumbsPerPage = 0;

  /**
   * Extraer imgkeys de paginación de Gallery en el rango especificado
   * El número de miniaturas por página depende de la configuración del usuario (normalmente 20, 40, etc.)
   */
  async function fetchImgkeysFromGallery(startPage, endPage) {
    try {
      // Usar el valor detectado, o detectar del DOM, o usar 20 por defecto
      let thumbsPerPage = detectedThumbsPerPage;
      if (thumbsPerPage <= 0) {
        const initialThumbnails = document.querySelectorAll('#gdt a[href*="/s/"]').length;
        thumbsPerPage = initialThumbnails > 0 ? initialThumbnails : 20;
      }
      
      // Calcular qué página de Gallery hay que obtener
      const galleryPageIndex = Math.floor(startPage / thumbsPerPage);
      
      // Verificar si ya hay una solicitud en curso
      if (galleryPageFetchCache.has(galleryPageIndex)) {
        debugLog(`[EH Reader] Gallery page ${galleryPageIndex} fetch already in progress, reusing...`);
        return galleryPageFetchCache.get(galleryPageIndex);
      }
      
      const galleryUrl = `${window.location.origin}/g/${pageData.gid}/${pageData.token}/?p=${galleryPageIndex}`;
      
      debugLog(`[EH Reader] Fetching imgkeys from gallery page ${galleryPageIndex} (${thumbsPerPage} thumbs/page):`, galleryUrl);
      
      const fetchPromise = (async () => {
        const response = await fetch(galleryUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch gallery page: ${response.status}`);
        }
        
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Extraer imgkey de los enlaces de miniaturas
        const thumbnailLinks = doc.querySelectorAll('#gdt a[href*="/s/"]');
        debugLog(`[EH Reader] Found ${thumbnailLinks.length} thumbnails in gallery page ${galleryPageIndex}`);

        let updatedCount = 0;
        thumbnailLinks.forEach((link, index) => {
          const href = link.getAttribute('href');
          const match = href.match(/\/s\/([a-f0-9]+)\/\d+-(\d+)/);
          if (match) {
            const imgkey = match[1];
            const pageNum = parseInt(match[2]) - 1; // Convertir a índice base 0
            
            if (window.__ehReaderData?.imagelist[pageNum]) {
              window.__ehReaderData.imagelist[pageNum].k = imgkey;
              updatedCount++;
            }
          }
        });
        
        debugLog(`[EH Reader] Updated ${updatedCount} imgkeys for gallery page ${galleryPageIndex}`);
        
        // Eliminar del caché al completar
        galleryPageFetchCache.delete(galleryPageIndex);
      })();
      
      // Agregar Promise al caché
      galleryPageFetchCache.set(galleryPageIndex, fetchPromise);
      
      return fetchPromise;
    } catch (error) {
      console.error(`[EH Reader] Failed to fetch imgkeys:`, error);
      throw error;
    }
  }

  /**
   * Construir URL de página individual (sin usar la API, content.js obtendrá el HTML)
   * En modo Gallery, devuelve directamente la URL de página individual para que fetchRealImageUrl del modo MPV la procese
   */
  async function fetchPageImageUrl(page) {
    try {
      // Obtener el imgkey de la página desde imagelist
      let imgkey = window.__ehReaderData?.imagelist[page]?.k || '';
      
      // Si no existe imgkey, obtenerlo dinámicamente de la página Gallery
      if (!imgkey) {
        debugLog(`[EH Reader] Page ${page} imgkey not cached, fetching from gallery...`);
        
        // Usar el número guardado por página, o 20 por defecto
        const thumbsPerPage = detectedThumbsPerPage > 0 ? detectedThumbsPerPage : 20;
        
        // Obtener solo la página Gallery de la página actual (sin precarga para evitar limitaciones)
        const currentGalleryPage = Math.floor(page / thumbsPerPage);
        await fetchImgkeysFromGallery(currentGalleryPage * thumbsPerPage, (currentGalleryPage + 1) * thumbsPerPage);
        
        // Verificar imgkey después de obtener
        imgkey = window.__ehReaderData?.imagelist[page]?.k || '';
        
        if (!imgkey) {
          throw new Error(`Page ${page} imgkey not found after fetching`);
        }
      }

      // Construir URL de página individual: https://e-hentai.org/s/{imgkey}/{gid}-{page}
      const pageUrl = `${window.location.origin}/s/${imgkey}/${pageData.gid}-${page + 1}`;
      
      debugLog(`[EH Reader] Page ${page} URL:`, pageUrl);
      
      // Devolver URL de página individual, content.js extraerá el HTML automáticamente
      return {
        pageNumber: page + 1,
        pageUrl: pageUrl,  // Devuelve la URL de página, no la URL de imagen
        imgkey: imgkey
      };
    } catch (error) {
      console.error(`[EH Reader] Failed to construct page URL for ${page}:`, error);
      throw error;
    }
  }

  /**
   * Iniciar lector
   */
  async function launchReader(startPage /* 1-based, optional */) {
    debugLog('[EH Reader] Launching reader from Gallery page...');
    
    try {
      // 0. Antes de reemplazar el DOM, detectar y guardar el número de miniaturas por página
      const initialThumbnails = document.querySelectorAll('#gdt a[href*="/s/"]').length;
      detectedThumbsPerPage = initialThumbnails > 0 ? initialThumbnails : 20;
      debugLog(`[EH Reader] Detected ${detectedThumbsPerPage} thumbs per gallery page`);
      
      // 1. Obtener metadatos de la galería
      const metadata = await fetchGalleryMetadata();
      const pageCount = parseInt(metadata.filecount);
      
      debugLog(`[EH Reader] Gallery has ${pageCount} pages`);
      
      // 2. Construir lista de imágenes (formato similar a imagelist de MPV)
      const imagelist = [];
      
      // Inicializar todas las páginas, imgkey vacío por ahora
      for (let i = 0; i < pageCount; i++) {
        imagelist.push({
          n: (i + 1).toString(),
          k: '',  // Key de la imagen, se cargará según sea necesario
          t: ''   // URL de miniatura
        });
      }
      
      // Extraer imgkeys de las primeras imágenes de la página 0 de Gallery (asegura que la primera página cargue correctamente)
      debugLog('[EH Reader] Fetching initial imgkeys from Gallery page 0...');
      
      try {
        const firstPageUrl = `${window.location.origin}/g/${pageData.gid}/${pageData.token}/?p=0`;
        const response = await fetch(firstPageUrl);
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const thumbnailLinks = doc.querySelectorAll('#gdt a[href*="/s/"]');
        debugLog(`[EH Reader] Found ${thumbnailLinks.length} thumbnail links in first page`);
        
        thumbnailLinks.forEach((link) => {
          const href = link.getAttribute('href');
          // Formato de URL: https://e-hentai.org/s/{imgkey}/{gid}-{page}
          const match = href.match(/\/s\/([a-f0-9]+)\/\d+-(\d+)/);
          if (match) {
            const imgkey = match[1];
            const pageNum = parseInt(match[2]) - 1; // Convertir a índice base 0
            if (imagelist[pageNum]) {
              imagelist[pageNum].k = imgkey;
            }
          }
        });
      } catch (error) {
        console.error('[EH Reader] Failed to fetch initial imgkeys:', error);
      }
      
      debugLog('[EH Reader] Imagelist sample:', imagelist.slice(0, 3));
      
      // 2.5 Verificar si hay progreso guardado; si la página de restauración está fuera del rango de la página 0, precargar el imgkey de esa página
      let savedProgressPage = null;
      try {
        const LS_KEY = `eh_progress_${pageData.gid}`;
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed.currentPage) {
            savedProgressPage = parsed.currentPage;
          } else if (typeof parsed === 'number') {
            savedProgressPage = parsed;
          }
        }
      } catch {}
      
      // Si la página de restauración supera el rango de la página 0, precargar la página de Gallery correspondiente
      if (savedProgressPage && savedProgressPage > detectedThumbsPerPage) {
        const targetGalleryPage = Math.floor((savedProgressPage - 1) / detectedThumbsPerPage);
        debugLog(`[EH Reader] Saved progress at page ${savedProgressPage}, pre-fetching gallery page ${targetGalleryPage}...`);
        
        try {
          const galleryUrl = `${window.location.origin}/g/${pageData.gid}/${pageData.token}/?p=${targetGalleryPage}`;
          const response = await fetch(galleryUrl);
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          
          const thumbnailLinks = doc.querySelectorAll('#gdt a[href*="/s/"]');
          debugLog(`[EH Reader] Found ${thumbnailLinks.length} thumbnails in gallery page ${targetGalleryPage}`);
          
          thumbnailLinks.forEach((link) => {
            const href = link.getAttribute('href');
            const match = href.match(/\/s\/([a-f0-9]+)\/\d+-(\d+)/);
            if (match) {
              const imgkey = match[1];
              const pageNum = parseInt(match[2]) - 1;
              if (imagelist[pageNum]) {
                imagelist[pageNum].k = imgkey;
              }
            }
          });
          debugLog(`[EH Reader] Pre-fetched imgkeys for saved progress page ${savedProgressPage}`);
        } catch (error) {
          console.warn('[EH Reader] Failed to pre-fetch imgkeys for saved progress:', error);
        }
      }
      
      // 3. Construir pageData (compatible con el formato de content.js)
      const readerPageData = {
        imagelist: imagelist,
        pagecount: pageCount,
        gid: pageData.gid,
        mpvkey: pageData.token,
        gallery_url: `${pageData.baseUrl}g/${pageData.gid}/${pageData.token}/`,
        title: metadata.title,
        source: 'gallery', // Marcar el origen de los datos
        startAt: (typeof startPage === 'number' && startPage >= 1 && startPage <= pageCount) ? startPage : undefined
      };
      
      // 4. Montar en window (para uso de content.js)
      window.__ehReaderData = readerPageData;
      
      // 5. Crear marcador para que content.js sepa que se lanzó desde Gallery
      debugLog('[EH Reader] Injecting reader UI...');
      
      window.__ehGalleryBootstrap = {
        enabled: true,
        fetchPageImageUrl: fetchPageImageUrl
      };
      
      // 6. Notificar a content.js que inicie (content.js ya está cargado mediante el manifest)
      // Disparar evento personalizado
      const event = new CustomEvent('ehGalleryReaderReady', { 
        detail: readerPageData 
      });
      document.dispatchEvent(event);
      debugLog('[EH Reader] Gallery reader ready event dispatched');
      
    } catch (error) {
      console.error('[EH Reader] Failed to launch reader:', error);
      alert(`Error al iniciar el lector: ${error.message}`);
    }
  }

  /**
   * Agregar botón de inicio en la página Gallery
   */
  function addLaunchButton() {
    // Encontrar el área de acciones del lado derecho (#gd5)
    const actionPanel = document.querySelector('#gd5');
    if (!actionPanel) {
      console.warn('[EH Reader] Cannot find action panel (#gd5)');
      return;
    }

    // Verificar si ya existe un enlace MPV
    if (mpvLink) {
      debugLog('[EH Reader] MPV link already exists, user has permission');
      // Si tiene permisos MPV, se puede omitir el botón o agregar uno como alternativa
      // Aquí lo añadimos igualmente como opción alternativa
    }

  // Crear contenedor del botón (mantener el estilo nativo de la página, sin fondo personalizado)
  const buttonContainer = document.createElement('p');
  buttonContainer.className = 'g2 gsp';
  // No aplicar estilos adicionales para no romper la alineación del diseño

    // Crear ícono
    const icon = document.createElement('img');
    icon.src = 'https://ehgt.org/g/mr.gif';
    
    // Detectar si hay plugins de traducción como EhSyringe (detectando texto como "多页查看器")
    const hasChineseUI = !!document.querySelector('#gd5')?.textContent?.match(/多页查看器|申请|收藏/);
    
    // Crear botón
  const button = document.createElement('a');
    button.href = '#';
    button.textContent = hasChineseUI ? 'Lector Moderno' : 'EH Modern Reader';
  // Usar el estilo de enlace predeterminado del sitio para no desentonar
  button.style.cssText = '';
    button.onclick = (e) => {
      e.preventDefault();
      launchReader();
    };

    buttonContainer.appendChild(icon);
    buttonContainer.appendChild(document.createTextNode(' '));
    buttonContainer.appendChild(button);


    // Insertar debajo del botón MPV (si existe) o al principio
    let insertAfterRef = null;
    if (mpvLink) {
      insertAfterRef = mpvLink.closest('p');
    }
    if (insertAfterRef) {
      insertAfterRef.parentNode.insertBefore(buttonContainer, insertAfterRef.nextSibling);
    } else {
      // Insertar al principio del panel
      actionPanel.insertBefore(buttonContainer, actionPanel.firstChild);
    }

    debugLog('[EH Reader] Launch button added');
  }

  // Agregar botón después de que la página cargue
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addLaunchButton);
  } else {
    addLaunchButton();
  }

  // Interceptar clics en miniaturas y abrir directamente con nuestro lector en la página correspondiente
  function interceptThumbnailClicks() {
    const grid = document.getElementById('gdt');
    if (!grid) return;
    // Permitir comportamiento nativo para combinaciones de teclas/clic central, etc.
    const shouldBypass = (ev) => ev.ctrlKey || ev.shiftKey || ev.metaKey || ev.altKey || ev.button === 1;

    grid.addEventListener('auxclick', (e) => {
      // Clic central, etc., permitir directamente
    }, true);

    grid.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      if (shouldBypass(e)) return; // Conservar el comportamiento del sitio original (nueva pestaña, abrir, etc.)
      const a = e.target && (e.target.closest ? e.target.closest('a[href*="/s/"]') : null);
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
      if (!m) return; // Enlace no esperado, permitir
      e.preventDefault();
      const pageNum = parseInt(m[3], 10); // 1-based
      const now = Date.now();
      const cooldownUntil = window.__ehReaderCooldown || 0;
      if (cooldownUntil > now || window.__ehReaderLaunching) return;
      window.__ehReaderLaunching = true;
      window.__ehReaderCooldown = now + 1200; // 1.2s Enfriamiento para evitar activación duplicada
      launchReader(pageNum).catch(() => { window.__ehReaderLaunching = false; });
    }, true); // Prioridad en fase de captura para reducir interferencia de scripts del sitio
  }

  // Vincular eventos de clic inmediatamente después de que el DOM esté listo
  function ensureInterception() {
    if (document.getElementById('gdt')) {
      // DOM listo, ejecutar directamente
      interceptThumbnailClicks();
    } else if (document.readyState === 'loading') {
      // Esperar DOMContentLoaded
      document.addEventListener('DOMContentLoaded', interceptThumbnailClicks);
    } else {
      // DOM completamente cargado pero gdt aún no aparece, reintentar con retraso
      setTimeout(ensureInterception, 100);
    }
  }
  
  ensureInterception();

  debugLog('[EH Reader] Script de página Gallery inicializado');
})();