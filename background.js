/**
 * Background Script - Script de fondo
 * Gestiona la lógica en segundo plano de la extensión
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[EH Modern Reader] Extensión instalada');

    // Mostrar página de bienvenida
    chrome.tabs.create({
      url: 'welcome.html'
    });
  } else if (details.reason === 'update') {
    console.log('[EH Modern Reader] Extensión actualizada');
  }
});

// Escuchar mensajes del content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(['readerSettings'], (result) => {
      sendResponse(result.readerSettings || {});
    });
    return true;
  }

  if (request.action === 'saveSettings') {
    chrome.storage.sync.set({ readerSettings: request.settings }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // FIX descarga ZIP: el content script no puede hacer fetch de imágenes por CORS.
  // El service worker sí puede porque opera fuera del contexto de página.
  // Devuelve la imagen como base64 para que el content script pueda incluirla en el ZIP.
  if (request.action === 'fetchImageBase64') {
    const url = request.url;
    fetch(url)
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);   // "data:...;base64,..."
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => {
        const mimeType = dataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
        const base64   = dataUrl.split(',')[1];
        sendResponse({ ok: true, base64, mimeType });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // mantener canal de respuesta abierto (async)
  }
});
