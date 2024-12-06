const CACHE_NAME = 'post-app-9739978';
const POST_QUEUE_NAME = 'post-queue';

self.addEventListener('install', (event) => {
	event.waitUntil(
		Promise.all([
			caches.open(CACHE_NAME).then((cache) => {
				return cache.addAll([
					'./',
					'./index.html',
					'./styles.css',
					'./app.js',
					'./manifest.json'
				]);
			}),
			// Create post queue store
			caches.open(POST_QUEUE_NAME)
		])
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((cacheNames) => {
			return Promise.all(
				cacheNames
					.filter((cacheName) => cacheName !== CACHE_NAME && cacheName !== POST_QUEUE_NAME)
					.map((cacheName) => caches.delete(cacheName))
			);
		})
	);
});

self.addEventListener('sync', async (event) => {
	if (event.tag === 'sync-posts') {
		event.waitUntil(syncPosts());
	}
});

async function syncPosts() {
	const cache = await caches.open(POST_QUEUE_NAME);
	const requests = await cache.keys();

	return Promise.all(
		requests.map(async (request) => {
			try {
				const response = await fetch(request);
				if (response.ok) {
					await cache.delete(request);
					// Notify the client
					const clients = await self.clients.matchAll();
					clients.forEach(client => {
						client.postMessage({
							type: 'POST_SYNCED',
							success: true,
							id: request.url.split('/').pop()
						});
					});
				}
				return response;
			} catch (error) {
				// Notify the client of failure
				const clients = await self.clients.matchAll();
				clients.forEach(client => {
					client.postMessage({
						type: 'POST_SYNCED',
						success: false,
						id: request.url.split('/').pop(),
						error: error.message
					});
				});
			}
		})
	);
}

self.addEventListener('fetch', (event) => {
	event.respondWith(
		fetch(event.request)
			.then(response => {
				const responseClone = response.clone();
				caches.open(CACHE_NAME).then(cache => {
					cache.put(event.request, responseClone);
				});
				return response;
			})
			.catch(() => {
				return caches.match(event.request);
			})
	);
});