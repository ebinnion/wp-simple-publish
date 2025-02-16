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
        this.ready = false;
        this.initPromise = this.init();
    }

    async init() {
        try {
            await this.setupDB();
            await this.loadFromStorage();
            await this.setupServiceWorker();
            this.ready = true;

            // Process any non-completed items if we're online
            if (navigator.onLine) {
                for (const [id, post] of this.posts.entries()) {
                    if (post.status !== POST_STATUS.COMPLETED) {
                        // Don't reset status - we want to resume from where we left off
                        await this.processPost(id);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to initialize queue:', error);
            this.ready = false;
            throw error;
        }
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
        // Wait for initialization to complete
        if (!this.ready) {
            await this.initPromise;
        }

        const id = this.generateId();
        const post = {
            id,
            data: postData,
            status: POST_STATUS.QUEUED,
            createdAt: Date.now(),
            error: null,
            mediaProgress: {
                uploadedIds: [],
                uploadedUrls: []
            }
        };

        this.posts.set(id, post);
        await this.saveToStorage();
        this.updateUI();

        if (navigator.onLine) {
            await this.processPost(id);
        } else {
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
            // Validate site URL
            if (!post.data.config.url) {
                throw new Error('WordPress site URL not configured. Please check your settings.');
            }

            try {
                const url = new URL(post.data.config.url);
                if (!url.protocol.startsWith('http')) {
                    throw new Error('WordPress site URL must start with http:// or https://');
                }
                post.data.config.url = url.origin + url.pathname.replace(/\/$/, '');
            } catch (error) {
                throw new Error('Invalid WordPress site URL. Please check your settings.');
            }

            post.status = POST_STATUS.UPLOADING;
            post.mediaProgress = post.mediaProgress || {
                uploadedIds: [],
                uploadedUrls: [],
                currentFile: 0,
                currentFileProgress: 0
            };
            post.draftId = post.draftId || null;
            this.updateUI(id);
            await this.saveToStorage();

            // Create or resume draft post
            if (!post.draftId) {
                console.log('Creating initial draft post...');
                const draftPost = await this.createPost({
                    ...post.data,
                    status: 'draft',
                    content: 'Uploading media...'
                });

                console.log('Draft post created:', draftPost.id);
                post.draftId = draftPost.id;
                await this.saveToStorage();
            } else {
                console.log('Resuming with existing draft:', post.draftId);
            }

            // Upload remaining images with progress tracking
            const remainingImages = post.data.imageUrls.slice(post.mediaProgress.uploadedIds.length);
            console.log(`Uploading ${remainingImages.length} remaining images...`);

            for (const [index, imageUrl] of remainingImages.entries()) {
                try {
                    post.mediaProgress.currentFile = post.mediaProgress.uploadedIds.length;
                    post.mediaProgress.currentFileProgress = 0;
                    this.updateUI(id);

                    const response = await fetch(imageUrl);
                    const blob = await response.blob();

                    // Get the filename from the stored data attribute
                    const filename = (post.data.imageFilenames && post.data.imageFilenames[index]) || `image-${index + 1}.jpg`;

                    const formData = new FormData();
                    formData.append('file', blob, filename);
                    formData.append('post', post.draftId);

                    const mediaEndpoint = new URL('/wp-json/wp/v2/media', post.data.config.url).toString();
                    console.log(`Uploading media ${index + 1} of ${remainingImages.length} to:`, mediaEndpoint);

                    const mediaData = await this.uploadMedia(mediaEndpoint, post.data.config, formData);
                    post.mediaProgress.uploadedIds.push(mediaData.id);
                    post.mediaProgress.uploadedUrls.push(mediaData.source_url);
                    post.mediaProgress.currentFileProgress = 100;
                    await this.saveToStorage();
                    this.updateUI(id);
                } catch (error) {
                    console.error('Image upload failed:', error);
                    throw new Error(`Failed to upload image: ${error.message}`);
                }
            }

            // Update the draft with content and final status
            console.log('Updating post with content and media...');
            const finalPost = await this.updatePost({
                ...post.data,
                postId: post.draftId,
                mediaIds: post.mediaProgress.uploadedIds,
                mediaUrls: post.mediaProgress.uploadedUrls
            });

            post.status = POST_STATUS.COMPLETED;
            post.result = finalPost;
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
            await this.saveToStorage();
        }
    }

    async createPost(postData) {
        // Validate site URL
        if (!postData.config.url || !postData.config.url.startsWith('http')) {
            throw new Error('Invalid WordPress site URL. Please check your settings.');
        }

        const endpoint = new URL('/wp-json/wp/v2/posts', postData.config.url).toString();
        console.log('Creating post at:', endpoint);

        const postResponse = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + btoa(`${postData.config.username}:${postData.config.password}`)
            },
            body: JSON.stringify({
                title: '',
                content: postData.content || postData.text,
                status: postData.status,
                format: postData.format
            })
        });

        if (!postResponse.ok) {
            const errorText = await postResponse.text();
            console.error('Post creation failed:', postResponse.status, errorText);
            throw new Error(`Failed to create post (HTTP ${postResponse.status})`);
        }

        return postResponse.json();
    }

    async updatePost(postData) {
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

		const endpoint = new URL(`/wp-json/wp/v2/posts/${postData.postId}`, postData.config.url).toString();
		console.log('Updating post at:', endpoint);

		const postResponse = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + btoa(`${postData.config.username}:${postData.config.password}`)
			},
			body: JSON.stringify({
				title: postData.text.split('\n')[0] || 'New Post',
				content: content,
				status: postData.status,
				featured_media: postData.mediaIds[0] || 0,
				format: postData.format
			})
		});

		if (!postResponse.ok) {
			const errorText = await postResponse.text();
			console.error('Post update failed:', postResponse.status, errorText);
			throw new Error(`Failed to update post (HTTP ${postResponse.status})`);
		}

		return postResponse.json();
	}

	async loadFromStorage() {
		return new Promise((resolve, reject) => {
			try {
				const transaction = this.db.transaction(this.storeName, 'readonly');
				const store = transaction.objectStore(this.storeName);
				const request = store.getAll();

				request.onerror = () => {
					console.error('Failed to load from storage:', request.error);
					reject(request.error);
				};

				request.onsuccess = () => {
					const posts = request.result;
					this.posts = new Map(posts.map(post => [post.id, post]));
					this.updateUI();
					resolve();
				};

				transaction.onerror = () => {
					console.error('Transaction failed:', transaction.error);
					reject(transaction.error);
				};
			} catch (error) {
				console.error('Failed to start load transaction:', error);
				reject(error);
			}
		});
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
		const queueContainer = document.querySelector('.queue-container') || this.createQueueContainer();
		const queueList = queueContainer.querySelector('.queue-list');

		if (this.posts.size === 0) {
			queueContainer.style.display = 'none';
			return;
		}

		queueContainer.style.display = 'block';
		queueList.innerHTML = '';

		for (const [postId, post] of this.posts.entries()) {
			const item = document.createElement('div');
			item.className = 'queue-item';

			const header = document.createElement('div');
			header.className = 'queue-item-header';

			const title = document.createElement('div');
			title.className = 'title';
			title.textContent = post.data.text.split('\n')[0] || 'New Post';

			const status = document.createElement('div');
			status.className = 'status';
			status.textContent = post.status;

			header.appendChild(title);
			header.appendChild(status);
			item.appendChild(header);

			// Add progress indicator only during media uploads
			if (post.status === POST_STATUS.UPLOADING &&
				post.data.imageUrls.length > 0 &&
				post.mediaProgress.uploadedIds.length < post.data.imageUrls.length) {

				const progress = document.createElement('div');
				progress.className = 'upload-progress';

				const uploadedCount = post.mediaProgress?.uploadedIds?.length || 0;
				const totalCount = post.data.imageUrls.length;
				const currentFileProgress = post.mediaProgress?.currentFileProgress || 0;

				// Calculate total progress including current file
				const completedProgress = (uploadedCount / totalCount) * 100;
				const currentFileContribution = (currentFileProgress / 100) * (1 / totalCount) * 100;
				const totalProgress = Math.min(Math.round(completedProgress + currentFileContribution), 100);

				progress.innerHTML = `
					<div class="progress-bar">
						<div class="progress-fill" style="width: ${totalProgress}%"></div>
					</div>
					<div class="progress-text">
						Uploading image ${uploadedCount + 1} of ${totalCount} (${totalProgress}%)
					</div>
				`;
				item.appendChild(progress);
			} else if (post.status === POST_STATUS.UPLOADING) {
				// Show a different message when updating the post
				const progress = document.createElement('div');
				progress.className = 'upload-progress';
				progress.innerHTML = `
					<div class="progress-text">
						Updating post...
					</div>
				`;
				item.appendChild(progress);
			}

			if (post.error) {
				const error = document.createElement('div');
				error.className = 'error';
				error.textContent = post.error;
				item.appendChild(error);
			}

			queueList.appendChild(item);
		}
	}

	createQueueContainer() {
		const container = document.createElement('div');
		container.className = 'queue-container';
		container.innerHTML = `
			<h3>Upload Queue</h3>
			<div class="queue-list"></div>
		`;
		document.querySelector('.container').appendChild(container);
		return container;
	}

	async uploadMedia(url, config, formData) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();

			xhr.upload.addEventListener('progress', (event) => {
				if (event.lengthComputable) {
					const progress = (event.loaded / event.total) * 100;
					this.currentFileProgress = progress;
					this.updateUI(); // Update UI with current file progress
				}
			});

			xhr.addEventListener('load', () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					try {
						const response = JSON.parse(xhr.responseText);
						resolve(response);
					} catch (error) {
						reject(new Error('Invalid response format'));
					}
				} else {
					reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
				}
			});

			xhr.addEventListener('error', () => {
				reject(new Error('Network error during upload'));
			});

			xhr.addEventListener('abort', () => {
				reject(new Error('Upload aborted'));
			});

			xhr.open('POST', url);
			xhr.setRequestHeader('Authorization', 'Basic ' + btoa(`${config.username}:${config.password}`));
			xhr.send(formData);
		});
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

			// Preview all selected images and store filenames
			Array.from(files).forEach(file => {
				const reader = new FileReader();
				reader.onload = (e) => {
					const img = document.createElement('img');
					img.src = e.target.result;
					img.dataset.filename = file.name; // Store filename in data attribute
					imagePreview.appendChild(img);
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
					imageFilenames: Array.from(images).map(img => img.dataset.filename), // Store filenames
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
	// Check if modal already exists
	let modal = document.querySelector('.settings-modal');
	if (modal) {
		// Update existing modal content instead of creating new one
		updateSettingsModalContent(modal, config);
		return modal;
	}

	// Create new modal if it doesn't exist
	modal = document.createElement('div');
	modal.className = 'settings-modal';
	updateSettingsModalContent(modal, config);
	document.body.appendChild(modal);
	return modal;
}

function updateSettingsModalContent(modal, config) {
	// Check if we have any settings saved
	const hasSettings = !!(config.url || config.username || config.password);

	// Check if we have any items in the queue
	const hasQueueItems = postQueue.posts.size > 0;

	// Only show danger zone if we have either settings or queue items
	const dangerZoneHtml = (hasSettings || hasQueueItems) ? `
		<div class="modal-danger-zone">
			<h4>Danger Zone</h4>
			<div class="danger-buttons">
				${hasSettings ? '<button id="clearSettings" class="danger">Clear Settings</button>' : ''}
				${hasQueueItems ? '<button id="clearQueue" class="danger">Clear Queue</button>' : ''}
			</div>
		</div>
	` : '';

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
			${dangerZoneHtml}
		</div>
	`;

	// Add save and cancel handlers
	modal.querySelector('#saveSettings')?.addEventListener('click', () => {
		config.url = modal.querySelector('#wp_url').value;
		config.username = modal.querySelector('#wp_username').value;
		config.password = modal.querySelector('#wp_password').value;

		// Save to localStorage
		localStorage.setItem('wp_url', config.url);
		localStorage.setItem('wp_username', config.username);
		localStorage.setItem('wp_password', config.password);

		notices.success('Settings saved successfully');
		modal.style.display = 'none';

		// Update modal content instead of recreating
		updateSettingsModalContent(modal, config);
	});

	modal.querySelector('#cancelSettings')?.addEventListener('click', () => {
		modal.style.display = 'none';
	});

	// Add clear settings handler if button exists
	modal.querySelector('#clearSettings')?.addEventListener('click', () => {
		if (confirm('Are you sure you want to clear all WordPress settings? This will remove your saved site URL, username, and password.')) {
			localStorage.removeItem('wp_url');
			localStorage.removeItem('wp_username');
			localStorage.removeItem('wp_password');

			// Clear the config object
			config.url = '';
			config.username = '';
			config.password = '';

			notices.success('Settings cleared successfully');

			// Update modal content instead of recreating
			updateSettingsModalContent(modal, config);
		}
	});

	// Add clear queue handler if button exists
	modal.querySelector('#clearQueue')?.addEventListener('click', () => {
		if (confirm('Are you sure you want to clear the queue? This will remove all pending posts and uploads.')) {
			postQueue.posts.clear();
			const transaction = postQueue.db.transaction(postQueue.storeName, 'readwrite');
			const store = transaction.objectStore(postQueue.storeName);
			store.clear().onsuccess = () => {
				postQueue.updateUI();
				notices.success('Queue cleared successfully');
				modal.style.display = 'none';

				// Update modal content instead of recreating
				updateSettingsModalContent(modal, config);
			};
		}
	});
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
			title: '',
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