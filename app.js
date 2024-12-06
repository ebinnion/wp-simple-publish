const POST_STATUS = {
	QUEUED: 'queued',
	UPLOADING: 'uploading',
	COMPLETED: 'completed',
	FAILED: 'failed'
};

class PostQueue {
	constructor() {
		this.posts = new Map();
		this.dbName = 'postQueueDB';
		this.storeName = 'posts';
		this.setupDB().then(() => {
			this.loadFromStorage();
			this.setupServiceWorker();
		});
	}

	async setupDB() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);
			
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};
			
			request.onupgradeneeded = (event) => {
				const db = event.target.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: 'id' });
				}
			};
		});
	}

	async setupServiceWorker() {
		// Only try to register if we're in a secure context (https or localhost)
		const isSecureContext = window.isSecureContext || 
			window.location.protocol === 'https:' || 
			window.location.hostname === 'localhost' ||
			window.location.hostname === '127.0.0.1';

		if ('serviceWorker' in navigator && isSecureContext) {
			try {
				const registration = await navigator.serviceWorker.register('sw.js');
				registration.addEventListener('message', (event) => {
					if (event.data.type === 'POST_SYNCED') {
						this.handleSyncResult(event.data);
					}
				});
			} catch (error) {
				console.warn('ServiceWorker registration skipped:', error.message);
			}
		} else {
			console.log('ServiceWorker not supported or not in a secure context');
		}
	}

	handleSyncResult(data) {
		const post = this.posts.get(data.id);
		if (post) {
			if (data.success) {
				post.status = POST_STATUS.COMPLETED;
				notices.success('Post published successfully!');
				// Remove after a delay
				setTimeout(() => {
					this.posts.delete(data.id);
					this.saveToStorage();
					this.updateUI();
				}, 3000);
			} else {
				post.status = POST_STATUS.FAILED;
				post.error = data.error;
				notices.error('Failed to publish: ' + data.error);
			}
			this.saveToStorage();
			this.updateUI(data.id);
		}
	}

	generateId() {
		return `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	async add(postData) {
		const id = this.generateId();
		const post = {
			id,
			data: postData,
			status: POST_STATUS.QUEUED,
			createdAt: Date.now(),
			error: null
		};

		this.posts.set(id, post);
		this.saveToStorage();
		this.updateUI();

		// Start processing
		if (navigator.onLine) {
			this.processPost(id);
		} else {
			// Request background sync
			try {
				const registration = await navigator.serviceWorker.ready;
				await registration.sync.register('sync-posts');
			} catch (error) {
				console.error('Background sync registration failed:', error);
			}
		}

		return id;
	}

	async processPost(id) {
		const post = this.posts.get(id);
		if (!post || post.status === POST_STATUS.COMPLETED) return;

		try {
			post.status = POST_STATUS.UPLOADING;
			this.updateUI(id);

			// Upload images first
			const { mediaIds, mediaUrls } = await this.uploadImages(post.data.imageUrls, post.data.config);
			
			// Create the post
			const postResult = await this.createPost({
				...post.data,
				mediaIds,
				mediaUrls
			});

			post.status = POST_STATUS.COMPLETED;
			post.result = postResult;
			notices.success(post.data.status === 'publish' ? 'Post published successfully!' : 'Draft saved successfully!');
			
			// Remove from queue after success
			setTimeout(() => {
				this.posts.delete(id);
				this.saveToStorage();
				this.updateUI();
			}, 3000);

		} catch (error) {
			console.error('Failed to process post:', error);
			post.status = POST_STATUS.FAILED;
			post.error = error.message;
			notices.error(`Failed to ${post.data.status === 'publish' ? 'publish post' : 'save draft'}: ${error.message}`);
			this.updateUI(id);
		}

		this.saveToStorage();
	}

	async uploadImages(imageUrls, config) {
		const mediaIds = [];
		const mediaUrls = [];
		
		for (const imageUrl of imageUrls) {
			try {
				const response = await fetch(imageUrl);
				const blob = await response.blob();
				
				const formData = new FormData();
				formData.append('file', blob, 'image.jpg');

				const mediaResponse = await fetch(`${config.url}/wp-json/wp/v2/media`, {
					method: 'POST',
					headers: {
						'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
					},
					body: formData
				});

				if (!mediaResponse.ok) {
					throw new Error('Failed to upload image');
				}

				const mediaData = await mediaResponse.json();
				mediaIds.push(mediaData.id);
				mediaUrls.push(mediaData.source_url);
			} catch (error) {
				console.error('Image upload failed:', error);
				throw new Error('Failed to upload image');
			}
		}

		return { mediaIds, mediaUrls };
	}

	async createPost(postData) {
		// Format content with Gutenberg blocks
		let blocks = [];
		
		// Add image/gallery block if we have images
		if (postData.mediaIds.length > 0) {
			if (postData.mediaIds.length === 1) {
				blocks.push(`<!-- wp:image {"id":${postData.mediaIds[0]},"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="${postData.mediaUrls[0]}" alt="" class="wp-image-${postData.mediaIds[0]}"/></figure>
<!-- /wp:image -->`);
			} else {
				blocks.push(`<!-- wp:gallery {"columns":2,"linkTo":"none","ids":[${postData.mediaIds.join(',')}]} -->
<figure class="wp-block-gallery has-nested-images columns-2 is-cropped">
	${postData.mediaUrls.map((url, index) => `
	<!-- wp:image {"id":${postData.mediaIds[index]},"sizeSlug":"large","linkDestination":"none"} -->
	<figure class="wp-block-image size-large"><img src="${url}" alt="" class="wp-image-${postData.mediaIds[index]}"/></figure>
	<!-- /wp:image -->`).join('\n')}
</figure>
<!-- /wp:gallery -->`);
			}
		}

		// Add text content as paragraphs
		const paragraphs = postData.text.split('\n\n').filter(p => p.trim());
		paragraphs.forEach(paragraph => {
			blocks.push(`<!-- wp:paragraph -->
<p>${paragraph.trim()}</p>
<!-- /wp:paragraph -->`);
		});

		// Join blocks with newlines
		const content = blocks.join('\n\n');

		// Create post
		const postResponse = await fetch(`${postData.config.url}/wp-json/wp/v2/posts`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + btoa(`${postData.config.username}:${postData.config.password}`)
			},
			body: JSON.stringify({
				title: postData.text.split('\n')[0] || 'New Post',
				content: content,
				status: postData.status || 'draft',
				featured_media: postData.mediaIds[0] || 0,
				format: postData.format
			})
		});

		if (!postResponse.ok) {
			throw new Error('Failed to create post');
		}

		return postResponse.json();
	}

	async loadFromStorage() {
		try {
			const transaction = this.db.transaction(this.storeName, 'readonly');
			const store = transaction.objectStore(this.storeName);
			const request = store.getAll();

			request.onsuccess = () => {
				const posts = request.result;
				this.posts = new Map(posts.map(post => [post.id, post]));
				this.updateUI();
				
				// Process any queued items if we're online
				if (navigator.onLine) {
					setTimeout(() => {
						for (const [id, post] of this.posts.entries()) {
							if (post.status === POST_STATUS.QUEUED) {
								this.processPost(id);
							}
						}
					}, 0);
				}
			};
		} catch (error) {
			console.error('Failed to load queue:', error);
		}
	}

	async saveToStorage() {
		try {
			const transaction = this.db.transaction(this.storeName, 'readwrite');
			const store = transaction.objectStore(this.storeName);
			
			// Clear existing entries
			store.clear();
			
			// Add current posts
			for (const post of this.posts.values()) {
				store.add(post);
			}
		} catch (error) {
			console.error('Failed to save queue:', error);
		}
	}

	updateUI(id = null) {
		// Update queue display
		const queueContainer = document.getElementById('queueContainer') || this.createQueueContainer();
		
		if (this.posts.size === 0) {
			queueContainer.style.display = 'none';
			return;
		}

		queueContainer.style.display = 'block';
		const queueList = queueContainer.querySelector('.queue-list');
		
		if (id) {
			// Update specific post
			const post = this.posts.get(id);
			let itemEl = queueList.querySelector(`[data-id="${id}"]`);
			
			if (!itemEl && post) {
				itemEl = this.createQueueItem(post);
				queueList.appendChild(itemEl);
			} else if (itemEl && post) {
				itemEl.querySelector('.status').textContent = post.status;
				if (post.error) {
					itemEl.querySelector('.error').textContent = post.error;
				}
			}
		} else {
			// Update all
			queueList.innerHTML = '';
			for (const post of this.posts.values()) {
				queueList.appendChild(this.createQueueItem(post));
			}
		}
	}

	createQueueContainer() {
		const container = document.createElement('div');
		container.id = 'queueContainer';
		container.className = 'queue-container';
		container.innerHTML = `
			<h3>Post Queue</h3>
			<div class="queue-list"></div>
		`;
		document.querySelector('.container').appendChild(container);
		return container;
	}

	createQueueItem(post) {
		const item = document.createElement('div');
		item.className = 'queue-item';
		item.dataset.id = post.id;
		
		const title = post.data.text.split('\n')[0] || 'New Post';
		item.innerHTML = `
			<div class="queue-item-header">
				<span class="title">${title}</span>
				<span class="status">${post.status}</span>
			</div>
			<div class="error">${post.error || ''}</div>
		`;
		
		return item;
	}
}

// Initialize queue
const postQueue = new PostQueue();

const notices = {
	container: null,
	
	init: function() {
		this.container = document.createElement('div');
		this.container.className = 'notices';
		document.body.appendChild(this.container);
	},
	
	show: function(message, type = 'info') {
		const notice = document.createElement('div');
		notice.className = `notice notice-${type}`;
		
		const text = document.createElement('span');
		text.textContent = message;
		
		const closeBtn = document.createElement('button');
		closeBtn.className = 'notice-close';
		closeBtn.innerHTML = '×';
		closeBtn.onclick = () => notice.remove();
		
		notice.appendChild(text);
		notice.appendChild(closeBtn);
		this.container.appendChild(notice);
		
		// Optional: Auto-remove after 5 seconds
		setTimeout(() => notice.remove(), 5000);
	},
	
	success: function(message) {
		this.show(message, 'success');
	},
	
	info: function(message) {
		this.show(message, 'info');
	},
	
	error: function(message) {
		this.show(message, 'error');
	}
};

document.addEventListener('DOMContentLoaded', () => {
	const imageInput = document.getElementById('imageInput');
	const imagePreview = document.getElementById('imagePreview');
	const publishButton = document.getElementById('publishButton');
	const draftButton = document.getElementById('draftButton');
	const settingsButton = document.getElementById('settingsButton');

	// Add credential fields
	const wpConfig = {
		url: localStorage.getItem('wp_url') || '',
		username: localStorage.getItem('wp_username') || '',
		password: localStorage.getItem('wp_password') || ''
	};

	// Create settings modal
	const settingsModal = createSettingsModal(wpConfig);
	document.body.appendChild(settingsModal);

	settingsButton.addEventListener('click', () => {
		settingsModal.style.display = 'flex';
	});

	// Handle image preview and format selection
	imageInput.setAttribute('multiple', 'true'); // Enable multiple image selection
	imageInput.addEventListener('change', (e) => {
		const files = e.target.files;
		if (files.length > 0) {
			imagePreview.innerHTML = ''; // Clear previous previews
			
			// Update post format based on number of images
			const formatSelector = document.querySelector('#post-format');
			formatSelector.value = files.length > 1 ? 'gallery' : 'image';

			// Preview all selected images
			Array.from(files).forEach(file => {
				const reader = new FileReader();
				reader.onload = (e) => {
					imagePreview.innerHTML += `<img src="${e.target.result}">`;
				};
				reader.readAsDataURL(file);
			});
		}
	});

	// Add post format selector to the form
	const formatSelector = document.createElement('select');
	formatSelector.id = 'post-format';
	formatSelector.innerHTML = `
		<option value="status">Status</option>
		<option value="image">Image</option>
		<option value="gallery">Gallery</option>
		<option value="link">Link</option>
		<option value="standard">Standard</option>
	`;
	// Insert after textarea
	document.querySelector('textarea').after(formatSelector);

	// Initialize notices
	notices.init();

	async function handlePost(status = 'publish') {
		const text = document.querySelector('textarea').value;
		const images = imagePreview.querySelectorAll('img');
		const format = document.querySelector('#post-format').value;
		
		if (text || images.length > 0) {
			try {
				publishButton.disabled = true;
				draftButton.disabled = true;
				
				const postData = {
					text,
					imageUrls: Array.from(images).map(img => img.src),
					config: wpConfig,
					format,
					status
				};

				// Clear form immediately after capturing the data
				document.querySelector('textarea').value = '';
				imagePreview.innerHTML = '';
				imageInput.value = '';
				formatSelector.value = 'standard';

				if (!navigator.onLine) {
					// Add to queue if offline
					await postQueue.add(postData);
					notices.info(`You're offline. ${status === 'publish' ? 'Post' : 'Draft'} will be ${status === 'publish' ? 'published' : 'saved'} when connection is restored.`);
				} else {
					// Process immediately if online
					const id = await postQueue.add(postData);
				}
				
			} catch (error) {
				// If there was an error, restore the form data
				document.querySelector('textarea').value = text;
				imagePreview.innerHTML = Array.from(images).map(img => img.outerHTML).join('');
				formatSelector.value = format;
				notices.error(`Failed to ${status === 'publish' ? 'publish post' : 'save draft'}: ${error.message}`);
			} finally {
				publishButton.disabled = false;
				draftButton.disabled = false;
			}
		}
	}

	// Modify the button handlers
	publishButton.addEventListener('click', () => handlePost('publish'));
	draftButton.addEventListener('click', () => handlePost('draft'));

	// Add online/offline handlers
	window.addEventListener('online', () => {
		document.body.classList.remove('offline');
	});

	window.addEventListener('offline', () => {
		document.body.classList.add('offline');
	});
});

function createSettingsModal(config) {
	const modal = document.createElement('div');
	modal.className = 'settings-modal';
	modal.innerHTML = `
		<div class="modal-content">
			<h2>WordPress Settings</h2>
			<input type="url" id="wp_url" placeholder="WordPress Site URL (https://your-site.com)" value="${config.url}">
			<input type="text" id="wp_username" placeholder="WordPress Username" value="${config.username}">
			<input type="password" id="wp_password" placeholder="Application Password" value="${config.password}">
			<small>Generate an Application Password in your WordPress profile.</small>
			<div class="modal-buttons">
				<button id="saveSettings">Save</button>
				<button id="cancelSettings">Cancel</button>
			</div>
		</div>
	`;

	modal.querySelector('#saveSettings').addEventListener('click', () => {
		config.url = modal.querySelector('#wp_url').value;
		config.username = modal.querySelector('#wp_username').value;
		config.password = modal.querySelector('#wp_password').value;

		// Save to localStorage
		localStorage.setItem('wp_url', config.url);
		localStorage.setItem('wp_username', config.username);
		localStorage.setItem('wp_password', config.password);

		notices.success('Settings saved successfully');
		modal.style.display = 'none';
	});

	modal.querySelector('#cancelSettings').addEventListener('click', () => {
			modal.style.display = 'none';
	});

	return modal;
}

async function publishToWordPress(text, imageUrls, config, format) {
	console.log('Starting publish:', { hasText: !!text, imageCount: imageUrls.length, format });

	if (!config.url || !config.username || !config.password) {
		throw new Error('Please configure WordPress settings first');
	}

	try {
		let mediaIds = [];
		let mediaUrls = [];
		
		// Upload all images
		if (imageUrls.length > 0) {
			console.log('Uploading images...');
			for (const imageUrl of imageUrls) {
				// Convert base64 to blob
				const response = await fetch(imageUrl);
				const blob = await response.blob();
				
				// Upload image
				const formData = new FormData();
				formData.append('file', blob, 'image.jpg');

				const mediaResponse = await fetch(`${config.url}/wp-json/wp/v2/media`, {
					method: 'POST',
					headers: {
						'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
					},
					body: formData
				});

				if (!mediaResponse.ok) {
					console.error('Media upload failed:', await mediaResponse.text());
					throw new Error('Failed to upload image');
				}

				const mediaData = await mediaResponse.json();
				mediaIds.push(mediaData.id);
				mediaUrls.push(mediaData.source_url);
			}
			console.log('Images uploaded:', mediaIds);
		}

		// Format content with Gutenberg blocks
		let blocks = [];
		
		// Add image/gallery block if we have images
		if (mediaUrls.length > 0) {
			if (mediaUrls.length === 1) {
				blocks.push(`<!-- wp:image {"id":${mediaIds[0]},"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="${mediaUrls[0]}" alt="" class="wp-image-${mediaIds[0]}"/></figure>
<!-- /wp:image -->`);
			} else {
				blocks.push(`<!-- wp:gallery {"columns":2,"linkTo":"none","ids":[${mediaIds.join(',')}]} -->
<figure class="wp-block-gallery has-nested-images columns-2 is-cropped">
	${mediaUrls.map((url, index) => `
	<!-- wp:image {"id":${mediaIds[index]},"sizeSlug":"large","linkDestination":"none"} -->
	<figure class="wp-block-image size-large"><img src="${url}" alt="" class="wp-image-${mediaIds[index]}"/></figure>
	<!-- /wp:image -->`).join('\n')}
</figure>
<!-- /wp:gallery -->`);
			}
		}

		// Add text content as paragraphs
		const paragraphs = text.split('\n\n').filter(p => p.trim());
		paragraphs.forEach(paragraph => {
			blocks.push(`<!-- wp:paragraph -->
<p>${paragraph.trim()}</p>
<!-- /wp:paragraph -->`);
		});

		// Join blocks with newlines
		const content = blocks.join('\n\n');

		console.log('Creating post...');
		
		// Create post
		const postData = {
			title: text.split('\n')[0] || 'New Post',
			content: content,
			status: 'publish',
			featured_media: mediaIds[0] || 0,
			format: format
		};

		console.log('Post data:', postData);

		const postResponse = await fetch(`${config.url}/wp-json/wp/v2/posts`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
			},
			body: JSON.stringify(postData)
		});

		if (!postResponse.ok) {
			const errorText = await postResponse.text();
			console.error('Post creation failed:', {
				status: postResponse.status,
				statusText: postResponse.statusText,
				error: errorText
			});
			throw new Error('Failed to create post');
		}

		const result = await postResponse.json();
		console.log('Post created successfully:', result);
		return result;

	} catch (error) {
		console.error('Publishing error:', error);
		throw error;
	}
}
