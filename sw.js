// Service worker mínimo: habilita "Agregar a pantalla de inicio" en Android/Chrome
// y deja lista la base para notificaciones push a futuro. No cachea nada de forma
// agresiva para no interferir con los datos en vivo de la tienda/admin.
const CACHE_NAME = 'mifiestashop-shell-v1';
const SHELL_ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: siempre intenta ir a la red primero (datos en vivo);
// solo cae al cache si no hay conexión.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Notificaciones push (a futuro: requiere un backend con VAPID que envíe el push).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Mi Fiestashop', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Mi Fiestashop';
  const options = {
    body: data.body || '',
    icon: '/img/icons/icon-192.png',
    badge: '/img/icons/icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
