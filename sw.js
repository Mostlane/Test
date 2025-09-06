
self.addEventListener('install', e=>{
  e.waitUntil(caches.open('mostlane-fsm-v1').then(c=>c.addAll([
    './','./index.html','./jobs.html','./job.html','./create.html','./settings.html',
    './assets/styles.css','./assets/app.js','./manifest.json'
  ])));
});
self.addEventListener('fetch', e=>{
  e.respondWith(caches.match(e.request).then(resp=> resp || fetch(e.request)));
});
