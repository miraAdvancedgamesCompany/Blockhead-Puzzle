self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open('blockhead-store').then((cache) => {
            return cache.addAll([
                'index.html',
                'manifest.json',
                // أضف هنا ملفات الجافاسكريبت، التصميم، والصور الخاصة بلعبتك لتخزينها
            ]);
        })
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});