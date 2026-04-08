(function(){
  'use strict';

  // Mostrar número de versión
  try {
    const m = chrome.runtime && typeof chrome.runtime.getManifest === 'function'
      ? chrome.runtime.getManifest()
      : null;
    if (m && m.version) {
      const el = document.getElementById('ver');
      if (el) el.textContent = `v${m.version}`;
    }
  } catch (e) {
    console.warn('[EH Modern Reader][options] Error al leer la versión:', e);
  }

  // Interruptor del modo de depuración
  const debugCheckbox = document.getElementById('opt-debug-mode');
  if (debugCheckbox) {
    // Leer configuración actual
    chrome.storage.local.get(['eh_debug_mode'], (result) => {
      debugCheckbox.checked = result.eh_debug_mode === true;
    });

    // Guardar cambios de configuración
    debugCheckbox.addEventListener('change', () => {
      chrome.storage.local.set({ eh_debug_mode: debugCheckbox.checked }, () => {
        console.log('[EH Modern Reader] Modo de depuración:', debugCheckbox.checked ? 'activado' : 'desactivado');
      });
    });
  }
})();
