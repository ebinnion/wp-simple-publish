// Add at the top of the file, outside DOMContentLoaded
const publishQueue = {
	queue: [],
	
	add: function(data) {
		this.queue.push(data);
		localStorage.setItem('publishQueue', JSON.stringify(this.queue));
	},
	
	remove: function(index) {
		this.queue.splice(index, 1);
		localStorage.setItem('publishQueue', JSON.stringify(this.queue));
	},
	
	load: function() {
		this.queue = JSON.parse(localStorage.getItem('publishQueue') || '[]');
	},
	
	process: async function() {
		if (!navigator.onLine) return;
		
		for (let i = this.queue.length - 1; i >= 0; i--) {
			const item = this.queue[i];
			try {
				await publishToWordPress(item.text, item.imageUrls, item.config, item.format);
				this.remove(i);
				notices.success('Queued post has been published!');
			} catch (error) {
				console.error('Failed to publish queued item:', error);
			}
		}
	}
};

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
	const postButton = document.getElementById('postButton');

	// Add credential fields
	const wpConfig = {
		url: localStorage.getItem('wp_url') || '',
		username: localStorage.getItem('wp_username') || '',
		password: localStorage.getItem('wp_password') || ''
	};

	// Create settings UI
	const settingsBtn = document.createElement('button');
	settingsBtn.textContent = '⚙️';
	settingsBtn.className = 'settings-btn';

	// Create button container
	const buttonContainer = document.createElement('div');
	buttonContainer.className = 'button-container';

	// Move the post button into the container and add settings button
	postButton.parentNode.insertBefore(buttonContainer, postButton);
	buttonContainer.appendChild(postButton);
	buttonContainer.appendChild(settingsBtn);

	// Create settings modal
	const settingsModal = createSettingsModal(wpConfig);
	document.body.appendChild(settingsModal);

	settingsBtn.addEventListener('click', () => {
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

	// Load and process queue when app starts
	publishQueue.load();
	if (navigator.onLine) {
		publishQueue.process();
	}

	// Initialize notices
	notices.init();

	// Modify the post button handler
	postButton.addEventListener('click', async () => {
		const text = document.querySelector('textarea').value;
		const images = imagePreview.querySelectorAll('img');
		const format = document.querySelector('#post-format').value;
		
		if (text || images.length > 0) {
			try {
				postButton.disabled = true;
				postButton.textContent = 'Publishing...';
				
				if (!navigator.onLine) {
					publishQueue.add({
						text,
						imageUrls: Array.from(images).map(img => img.src),
						config: wpConfig,
						format
					});
					notices.info('You are offline. Post will be published when connection is restored.');
				} else {
					await publishToWordPress(text, Array.from(images).map(img => img.src), wpConfig, format);
					notices.success('Post published successfully!');
				}
				
				// Clear form
				document.querySelector('textarea').value = '';
				imagePreview.innerHTML = '';
				imageInput.value = '';
				formatSelector.value = 'standard';
			} catch (error) {
				notices.error('Failed to publish: ' + error.message);
			} finally {
				postButton.disabled = false;
				postButton.textContent = 'Post';
			}
		}
	});

	// Add online/offline handlers
	window.addEventListener('online', () => {
		document.body.classList.remove('offline');
		publishQueue.process();
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
	if (!config.url || !config.username || !config.password) {
		throw new Error('Please configure WordPress settings first');
	}

	try {
		let mediaIds = [];
		let mediaUrls = [];
		
		// Upload all images
		if (imageUrls.length > 0) {
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
					throw new Error('Failed to upload image');
				}

				const mediaData = await mediaResponse.json();
				mediaIds.push(mediaData.id);
				mediaUrls.push(mediaData.source_url);
			}
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

		// Create post
		const postData = {
			title: text.split('\n')[0] || 'New Post',
			content: content,
			status: 'draft',
			featured_media: mediaIds[0] || 0, // Set first image as featured image
			format: format
		};

		const postResponse = await fetch(`${config.url}/wp-json/wp/v2/posts`, {
			method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
				},
				body: JSON.stringify(postData)
		});

		if (!postResponse.ok) {
			throw new Error('Failed to create post');
		}

		return await postResponse.json();
	} catch (error) {
		console.error('Publishing error:', error);
		throw error;
	}
}

// Register service worker for PWA
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('sw.js')
		.then(registration => console.log('ServiceWorker registered'))
		.catch(error => console.log('ServiceWorker error:', error));
}