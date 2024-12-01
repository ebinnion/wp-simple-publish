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
	settingsBtn.textContent = '⚙️ Settings';
	settingsBtn.className = 'settings-btn';
	document.querySelector('.post-form').prepend(settingsBtn);

	// Create settings modal
	const settingsModal = createSettingsModal(wpConfig);
	document.body.appendChild(settingsModal);

	settingsBtn.addEventListener('click', () => {
		settingsModal.style.display = 'flex';
	});

	// Handle image preview
	imageInput.addEventListener('change', (e) => {
		const file = e.target.files[0];
		if (file) {
			const reader = new FileReader();
			reader.onload = (e) => {
				imagePreview.innerHTML = `<img src="${e.target.result}">`;
			};
			reader.readAsDataURL(file);
		}
	});

	// Add post format selector to the form
	const formatSelector = document.createElement('select');
	formatSelector.id = 'post-format';
	formatSelector.innerHTML = `
		<option value="standard">Standard</option>
		<option value="image">Image</option>
		<option value="status">Status</option>
		<option value="link">Link</option>
	`;
	// Insert after textarea
	document.querySelector('textarea').after(formatSelector);

	// Handle posting
	postButton.addEventListener('click', async () => {
		const text = document.querySelector('textarea').value;
		const imageUrl = imagePreview.querySelector('img')?.src;
		const format = document.querySelector('#post-format').value;
		
		if (text || imageUrl) {
			try {
				postButton.disabled = true;
				postButton.textContent = 'Publishing...';
				
				await publishToWordPress(text, imageUrl, wpConfig, format);
				
				// Clear form
				document.querySelector('textarea').value = '';
				imagePreview.innerHTML = '';
				imageInput.value = '';
			} catch (error) {
				alert('Failed to publish: ' + error.message);
			} finally {
				postButton.disabled = false;
				postButton.textContent = 'Post';
			}
		}
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
			<small>Generate an Application Password in your WordPress profile</small>
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

		modal.style.display = 'none';
	});

	modal.querySelector('#cancelSettings').addEventListener('click', () => {
		modal.style.display = 'none';
	});

	return modal;
}

async function publishToWordPress(text, imageUrl, config, format) {
	if (!config.url || !config.username || !config.password) {
		throw new Error('Please configure WordPress settings first');
	}

	try {
		let mediaId = null;
		let mediaUrl = null;
		if (imageUrl) {
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
			mediaId = mediaData.id;
			mediaUrl = mediaData.source_url;
		}

		// Format content with Gutenberg blocks
		let blocks = [];
		
		// Add image block if we have an image
		if (mediaUrl) {
			blocks.push(`<!-- wp:image {"id":${mediaId},"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="${mediaUrl}" alt="" class="wp-image-${mediaId}"/></figure>
<!-- /wp:image -->`);
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
			featured_media: mediaId,
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