/**
 * Popup Script - Lógica de ventana emergente
 */

(function() {
  'use strict';

  // Detectar pestaña actual
  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      const siteElement = document.getElementById('current-site');
      
      if (currentTab && currentTab.url) {
        if (currentTab.url.includes('e-hentai.org/mpv/')) {
          siteElement.textContent = 'E-Hentai MPV';
          siteElement.style.color = '#4ade80';
        } else if (currentTab.url.includes('exhentai.org/mpv/')) {
          siteElement.textContent = 'ExHentai MPV';
          siteElement.style.color = '#4ade80';
        } else if (currentTab.url.includes('e-hentai.org')) {
          siteElement.textContent = 'E-Hentai';
          siteElement.style.color = '#fbbf24';
        } else if (currentTab.url.includes('exhentai.org')) {
          siteElement.textContent = 'ExHentai';
          siteElement.style.color = '#fbbf24';
        } else if (currentTab.url.includes('nhentai.net/g/') || currentTab.url.includes('nhentai.xxx/g/')) {
          siteElement.textContent = 'nhentai Gallery';
          siteElement.style.color = '#fbbf24';
        } else if (currentTab.url.includes('nhentai.net') || currentTab.url.includes('nhentai.xxx')) {
          siteElement.textContent = 'nhentai';
          siteElement.style.color = '#fbbf24';
        } else {
          siteElement.textContent = 'Sitio no compatible';
          siteElement.style.color = '#ef4444';
        }
      }
    });
  }

  // Recargar página
  function reloadTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.reload(tabs[0].id);
        window.close();
      }
    });
  }

  // Abrir página de opciones
  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  // Inicializar
  document.addEventListener('DOMContentLoaded', () => {
    checkCurrentTab();

    // Vincular eventos de botones
    document.getElementById('reload-tab').addEventListener('click', reloadTab);
    document.getElementById('open-options').addEventListener('click', openOptions);

    // Mostrar versión de la extensión (leída del manifest)
    try {
      const verEl = document.getElementById('ext-version');
      if (verEl) {
        const manifest = chrome.runtime.getManifest?.();
        if (manifest?.version) {
          verEl.textContent = `v${manifest.version}`;
        }
      }
    } catch {}
  });

})();
