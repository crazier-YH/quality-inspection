// Service Worker - 工程质量管理 PWA
const CACHE_NAME = 'qc-v16';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // API请求不走缓存
  if (e.request.url.includes('/api/')) return;
  
  // HTML页面用网络优先，确保始终拿到最新版本
  var isHtml = e.request.mode === 'navigate' || e.request.url.endsWith('.html') || e.request.url.endsWith('/');
  
  e.respondWith(
    caches.match(e.request).then(cached => {
      var fetched = fetch(e.request).then(response => {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(function() { return cached; });
      
      if (isHtml) {
        // HTML: 网络优先，失败才用缓存
        return fetched;
      } else {
        // 其他资源: 缓存优先，无缓存才网络
        return cached || fetched;
      }
    })
  );
});
