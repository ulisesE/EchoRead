/* ==========================================================================
   EchoRead - Application Logic (Bootstrap 5 & Vertical Scroll Layout)
   ========================================================================== */

// --- 1. Storage Manager (IndexedDB & LocalStorage) ---
const DB_NAME = 'EchoReadDB';
const DB_VERSION = 1;

class StorageManager {
    constructor() {
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (e) => {
                console.error("IndexedDB load error", e);
                reject(e);
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('books')) {
                    db.createObjectStore('books', { keyPath: 'id' });
                }
            };
        });
    }

    getAllBooks() {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject("Database not initialized");
            const transaction = this.db.transaction(['books'], 'readonly');
            const store = transaction.objectStore(['books']);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const books = request.result || [];
                books.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
                resolve(books);
            };
            request.onerror = (e) => reject(e);
        });
    }

    getBook(id) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject("Database not initialized");
            const transaction = this.db.transaction(['books'], 'readonly');
            const store = transaction.objectStore(['books']);
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e);
        });
    }

    saveBook(bookRecord) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject("Database not initialized");
            const transaction = this.db.transaction(['books'], 'readwrite');
            const store = transaction.objectStore(['books']);
            const request = store.put(bookRecord);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    deleteBook(id) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject("Database not initialized");
            const transaction = this.db.transaction(['books'], 'readwrite');
            const store = transaction.objectStore(['books']);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    updateBookProgress(id, progressHref, progressParagraphIndex, progressPercent) {
        return new Promise((resolve, reject) => {
            this.getBook(id).then(book => {
                if (!book) return reject("Book not found");
                book.progressHref = progressHref;
                book.progressParagraphIndex = progressParagraphIndex;
                book.progressPercent = progressPercent;
                book.lastRead = Date.now();
                
                this.saveBook(book).then(resolve).catch(reject);
            }).catch(reject);
        });
    }

    // Settings (stored in localStorage)
    getSettings() {
        const defaults = {
            theme: 'dark',
            fontSize: 100, // percentage
            fontFamily: 'system-ui',
            voiceName: '',
            speed: 1.0
        };
        try {
            const stored = localStorage.getItem('echoread_settings');
            return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
        } catch (e) {
            return defaults;
        }
    }

    saveSettings(settings) {
        try {
            localStorage.setItem('echoread_settings', JSON.stringify(settings));
        } catch (e) {
            console.error("Error saving settings", e);
        }
    }
}


// --- 2. TTS Manager (Text-to-Speech) ---
class TTSManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.synth = window.speechSynthesis;
        this.voices = [];
        this.selectedVoice = null;
        this.speed = 1.0;
        
        this.paragraphs = [];
        this.currentIndex = 0;
        this.utterance = null;
        this.isPlaying = false;
        
        // Setup voices
        if (this.synth) {
            this.loadVoices();
            if (this.synth.onvoiceschanged !== undefined) {
                this.synth.onvoiceschanged = () => this.loadVoices();
            }
        }
    }

    loadVoices() {
        if (!this.synth) return;
        const voices = this.synth.getVoices();
        this.voices = voices;
        
        const select = document.getElementById('tts-voice-select');
        if (!select) return;
        
        select.innerHTML = '';
        
        if (voices.length === 0) {
            const option = document.createElement('option');
            option.textContent = "Sin voces (TTS)";
            select.appendChild(option);
            return;
        }
        
        // Sort voices by language then name
        const sorted = [...voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
        
        sorted.forEach((voice, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.localService) {
                option.textContent += ' [Local]';
            }
            select.appendChild(option);
        });

        // Try to match default or saved voice
        let defaultIndex = -1;
        const settings = this.app.storage.getSettings();
        
        if (settings.voiceName) {
            defaultIndex = sorted.findIndex(v => v.name === settings.voiceName);
        }
        if (defaultIndex === -1) {
            // Mexican Spanish
            defaultIndex = sorted.findIndex(v => {
                const lang = v.lang.toLowerCase().replace('_', '-');
                return lang === 'es-mx' || lang.startsWith('es-mx');
            });
        }
        if (defaultIndex === -1) {
            // General Spanish
            defaultIndex = sorted.findIndex(v => v.lang.toLowerCase().startsWith('es'));
        }
        if (defaultIndex === -1) {
            defaultIndex = sorted.findIndex(v => v.default);
        }
        if (defaultIndex === -1) {
            defaultIndex = 0;
        }
        
        select.selectedIndex = defaultIndex;
        this.selectedVoice = sorted[defaultIndex];
        
        select.onchange = () => {
            this.selectedVoice = sorted[select.selectedIndex];
            const settings = this.app.storage.getSettings();
            settings.voiceName = this.selectedVoice.name;
            this.app.storage.saveSettings(settings);
            
            if (this.isPlaying) {
                this.speakParagraph(this.currentIndex);
            }
        };
    }

    setSpeed(speedVal) {
        this.speed = parseFloat(speedVal);
        document.getElementById('tts-speed-val').textContent = `${this.speed.toFixed(1)}x`;
        document.getElementById('tts-speed-slider').value = this.speed;
        
        const settings = this.app.storage.getSettings();
        settings.speed = this.speed;
        this.app.storage.saveSettings(settings);
        
        if (this.isPlaying) {
            this.speakParagraph(this.currentIndex);
        }
    }

    setParagraphs(paragraphs, index) {
        this.paragraphs = paragraphs;
        this.currentIndex = index;
        this.updatePositionUI();
    }

    highlightParagraph(index) {
        this.clearHighlights();
        if (index >= 0 && index < this.paragraphs.length) {
            this.paragraphs[index].classList.add('tts-highlight');
        }
    }

    clearHighlights() {
        this.paragraphs.forEach(el => {
            el.classList.remove('tts-highlight');
        });
    }

    updatePositionUI() {
        const total = this.paragraphs.length;
        const current = total > 0 ? this.currentIndex + 1 : 0;
        const chapter = this.app.reader.currentChapterIndex + 1;
        const totalChapters = this.app.reader.spineItems.length;
        
        document.getElementById('tts-position-text').textContent = 
            `Capítulo ${chapter}/${totalChapters} · Párrafo ${current}/${total}`;
    }

    updatePlayerUI() {
        const playIcon = document.getElementById('tts-play-icon');
        const pulse = document.querySelector('.tts-indicator');
        const statusText = document.getElementById('tts-status-text');
        
        if (this.isPlaying) {
            playIcon.setAttribute('data-lucide', 'pause');
            statusText.textContent = "Leyendo en voz alta...";
            pulse.classList.add('speaking');
        } else {
            playIcon.setAttribute('data-lucide', 'play');
            statusText.textContent = "Lectura en pausa";
            pulse.classList.remove('speaking');
        }
        lucide.createIcons();
    }

    play() {
        if (!this.synth) return;
        this.isPlaying = true;
        this.updatePlayerUI();
        this.speakParagraph(this.currentIndex);
    }

    speakParagraph(index, useFallbackVoice = false) {
        if (!this.synth) return;

        if (this.utterance) {
            this.utterance.onend = null;
            this.utterance.onerror = null;
        }
        this.synth.cancel();

        if (this.paragraphs.length === 0) return;

        // Auto-advance chapter if index goes past last paragraph
        if (index >= this.paragraphs.length) {
            const nextChapter = this.app.reader.currentChapterIndex + 1;
            if (nextChapter < this.app.reader.spineItems.length) {
                this.app.reader.loadChapter(nextChapter, 0).then(() => {
                    if (this.isPlaying) {
                        this.speakParagraph(0);
                    }
                });
            } else {
                this.stop();
                alert("Has completado la lectura de este libro.");
            }
            return;
        }

        if (index < 0) index = 0;
        this.currentIndex = index;
        this.app.reader.currentParagraphIndex = index;
        this.updatePositionUI();
        this.highlightParagraph(index);

        const element = this.paragraphs[index];
        const text = element.textContent.trim();

        // Scroll to active reading block smoothly
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        this.utterance = new SpeechSynthesisUtterance(text);

        // Fallback to local Spanish voice if remote synthesis breaks (e.g. mobile networks)
        let voiceToUse = this.selectedVoice;
        if (useFallbackVoice) {
            const localSpanishVoice = this.voices.find(v => v.localService && v.lang.toLowerCase().startsWith('es'));
            voiceToUse = localSpanishVoice || null;
            console.warn("Utilizando voz local de respaldo:", voiceToUse ? voiceToUse.name : "Sistema");
        }

        if (voiceToUse) {
            this.utterance.voice = voiceToUse;
        }
        this.utterance.rate = this.speed;

        this.utterance.onend = () => {
            if (this.isPlaying) {
                this.speakParagraph(this.currentIndex + 1);
            }
        };

        this.utterance.onerror = (e) => {
            if (e.error === 'synthesis-failed' && !useFallbackVoice && this.selectedVoice) {
                console.warn("Error en la síntesis. Intentando con voz local de respaldo...");
                this.speakParagraph(this.currentIndex, true);
                return;
            }
            if (e.error !== 'interrupted' && this.isPlaying) {
                this.speakParagraph(this.currentIndex + 1);
            }
        };

        this.synth.speak(this.utterance);
        this.app.reader.saveReadingProgress();
    }

    playPause() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.utterance) {
            this.utterance.onend = null;
            this.utterance.onerror = null;
        }
        if (this.synth) {
            this.synth.cancel();
        }
        this.updatePlayerUI();
    }

    stop() {
        this.isPlaying = false;
        if (this.utterance) {
            this.utterance.onend = null;
            this.utterance.onerror = null;
        }
        if (this.synth) {
            this.synth.cancel();
        }
        this.clearHighlights();
        this.updatePlayerUI();
        this.updatePositionUI();
    }

    next() {
        if (this.paragraphs.length === 0) return;
        this.speakParagraph(this.currentIndex + 1);
    }

    prev() {
        if (this.paragraphs.length === 0) return;
        if (this.currentIndex > 0) {
            this.speakParagraph(this.currentIndex - 1);
        } else {
            // Jump to previous chapter's end paragraph
            const prevChapter = this.app.reader.currentChapterIndex - 1;
            if (prevChapter >= 0) {
                this.app.reader.loadChapter(prevChapter, 9999).then(() => {
                    if (this.isPlaying) {
                        this.speakParagraph(this.app.reader.currentParagraphIndex);
                    }
                });
            }
        }
    }

    startFromParagraph(index) {
        this.currentIndex = index;
        this.isPlaying = true;
        this.updatePlayerUI();
        this.speakParagraph(index);
    }
}


// --- 3. Reader Manager (Vertical DOM Parser) ---
class ReaderManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.book = null;
        this.spineItems = [];
        this.paragraphs = [];
        
        this.currentBookId = null;
        this.currentChapterIndex = 0;
        this.currentParagraphIndex = 0;
    }

    loadBook(fileBlob, bookId, savedHref = null, savedParagraphIndex = 0) {
        return new Promise((resolve, reject) => {
            this.unloadBook();
            this.currentBookId = bookId;
            this.book = ePub();

            this.book.open(fileBlob).then(() => {
                return this.book.ready;
            }).then(() => {
                const title = this.book.package.metadata.title || "Libro sin título";
                document.getElementById('reader-book-title').textContent = title;
                
                this.spineItems = this.book.spine.spineItems || [];
                
                this.populateTOC();
                
                // Show TOC progress info panel
                document.getElementById('toc-progress-container').classList.remove('d-none');
                
                // Find starting chapter index
                let startChapterIndex = 0;
                if (savedHref) {
                    const cleanSaved = savedHref.split('#')[0];
                    const foundIndex = this.spineItems.findIndex(item => item.href.includes(cleanSaved) || cleanSaved.includes(item.href));
                    if (foundIndex !== -1) {
                        startChapterIndex = foundIndex;
                    }
                }
                
                // Load chapter
                this.loadChapter(startChapterIndex, savedParagraphIndex).then(() => {
                    resolve();
                }).catch(reject);
                
            }).catch(reject);
        });
    }

    unloadBook() {
        this.app.tts.stop();
        this.book = null;
        this.spineItems = [];
        this.paragraphs = [];
        this.currentBookId = null;
        this.currentChapterIndex = 0;
        this.currentParagraphIndex = 0;
        
        document.getElementById('viewer').innerHTML = '';
        document.getElementById('toc-list').innerHTML = '';
        document.getElementById('toc-progress-container').classList.add('d-none');
    }

    async loadChapter(chapterIndex, savedParagraphIndex = 0) {
        if (chapterIndex < 0 || chapterIndex >= this.spineItems.length) return;
        this.currentChapterIndex = chapterIndex;
        const item = this.spineItems[chapterIndex];
        
        // Sync Offcanvas navigation active item
        this.updateTOCSelection(item.href);
        
        // Loading status inside DOM
        const viewer = document.getElementById('viewer');
        viewer.innerHTML = `
            <div class="d-flex flex-column align-items-center justify-content-center py-5">
                <div class="spinner-animation mb-3">
                    <i data-lucide="loader-2" class="text-primary" style="width: 32px; height: 32px;"></i>
                </div>
                <span class="text-muted fw-bold">Cargando capítulo...</span>
            </div>
        `;
        lucide.createIcons();

        try {
            // Load chapter document via epub.js spine
            const doc = await item.load(this.book.load.bind(this.book));
            const tempDiv = document.createElement('div');
            
            if (typeof doc === 'string') {
                tempDiv.innerHTML = doc;
            } else if (doc) {
                let bodyNode = null;
                if (typeof doc.querySelector === 'function') {
                    bodyNode = doc.querySelector('body');
                }
                if (!bodyNode && typeof doc.getElementsByTagName === 'function') {
                    bodyNode = doc.getElementsByTagName('body')[0];
                }
                if (!bodyNode) {
                    bodyNode = doc.documentElement;
                }
                tempDiv.innerHTML = bodyNode ? bodyNode.innerHTML : '';
            } else {
                tempDiv.innerHTML = '';
            }
            
            // Resolve relative image URLs from archive to local Blob URLs
            const images = tempDiv.querySelectorAll('img, image');
            for (const img of images) {
                let srcAttr = img.getAttribute('src');
                let isImageTag = img.tagName.toLowerCase() === 'image';
                if (isImageTag) {
                    srcAttr = img.getAttribute('xlink:href') || img.getAttribute('href');
                }
                if (srcAttr && !srcAttr.startsWith('data:') && !srcAttr.startsWith('blob:')) {
                    try {
                        const canonicalPath = item.resolve(srcAttr);
                        let blobUrl;
                        if (this.book.archive && typeof this.book.archive.createUrl === 'function') {
                            blobUrl = await this.book.archive.createUrl(canonicalPath);
                        } else if (this.book.resources && typeof this.book.resources.createUrl === 'function') {
                            blobUrl = await this.book.resources.createUrl(canonicalPath);
                        }
                        if (blobUrl) {
                            if (isImageTag) {
                                img.setAttribute('href', blobUrl);
                                img.setAttribute('xlink:href', blobUrl);
                            } else {
                                img.setAttribute('src', blobUrl);
                            }
                            
                            // Wrap inside a centered container for vertical beauty
                            const wrapper = document.createElement('div');
                            wrapper.className = 'reader-image-container';
                            img.parentNode.insertBefore(wrapper, img);
                            wrapper.appendChild(img);
                        }
                    } catch (err) {
                        console.warn("No se pudo extraer la imagen del EPUB zip", srcAttr, err);
                    }
                }
            }

            // Extract readable blocks (p, lists, headers, blockquotes)
            const readableTags = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
            const elements = Array.from(tempDiv.querySelectorAll(readableTags));
            const filteredElements = elements.filter(el => {
                const text = el.textContent.trim();
                if (text.length === 0) return false;
                if (el.closest('header, footer, nav, noscript, svg')) return false;
                return true;
            });

            // Mark paragraph indexes
            filteredElements.forEach((el, index) => {
                el.classList.add('reader-block');
                el.setAttribute('data-index', index);
            });

            // Put items in main viewer DOM
            viewer.innerHTML = '';
            while (tempDiv.firstChild) {
                viewer.appendChild(tempDiv.firstChild);
            }

            // Bind click interaction directly to readable elements
            this.paragraphs = Array.from(viewer.querySelectorAll('.reader-block'));
            this.paragraphs.forEach((el) => {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const index = parseInt(el.getAttribute('data-index'), 10);
                    this.app.tts.startFromParagraph(index);
                });
            });

            // Update chapter text in UI header
            let chapterTitle = `Capítulo ${chapterIndex + 1}`;
            if (item.href && this.book.navigation) {
                const navItem = this.book.navigation.get(item.href);
                if (navItem) {
                    chapterTitle = navItem.label.trim();
                }
            }
            document.getElementById('reader-chapter-title').textContent = chapterTitle;

            // Apply font scale and font settings
            this.applyReaderStyles();

            // Set TTS pointer
            this.currentParagraphIndex = Math.min(savedParagraphIndex, this.paragraphs.length - 1);
            if (this.currentParagraphIndex < 0) this.currentParagraphIndex = 0;
            this.app.tts.setParagraphs(this.paragraphs, this.currentParagraphIndex);

            // Resaltar
            setTimeout(() => {
                if (this.paragraphs[this.currentParagraphIndex]) {
                    this.app.tts.highlightParagraph(this.currentParagraphIndex);
                    this.paragraphs[this.currentParagraphIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                this.app.tts.updatePositionUI();
            }, 120);

            this.saveReadingProgress();

        } catch (err) {
            console.error("Error al cargar capítulo:", err);
            viewer.innerHTML = `<div class="alert alert-danger m-3">Error al renderizar el contenido de este capítulo.</div>`;
        }
    }

    applyReaderStyles() {
        const settings = this.app.storage.getSettings();
        const viewer = document.getElementById('viewer');
        if (!viewer) return;
        
        // Font Family
        viewer.setAttribute('data-font-family', settings.fontFamily);
        
        // Font Size
        viewer.style.fontSize = `${settings.fontSize}%`;
    }

    setFontSize(sizePercent) {
        const settings = this.app.storage.getSettings();
        settings.fontSize = sizePercent;
        this.app.storage.saveSettings(settings);
        this.applyReaderStyles();
    }

    setFontFamily(family) {
        const settings = this.app.storage.getSettings();
        settings.fontFamily = family;
        this.app.storage.saveSettings(settings);
        this.applyReaderStyles();
    }

    saveReadingProgress() {
        if (!this.currentBookId || !this.spineItems.length) return Promise.resolve();
        const progressHref = this.spineItems[this.currentChapterIndex].href;
        const progressParagraphIndex = this.currentParagraphIndex;
        
        let progressPercent = 0;
        if (this.spineItems.length > 0) {
            const chapterWeight = 1 / this.spineItems.length;
            const chapterProgress = this.paragraphs.length > 0 ? (this.currentParagraphIndex / this.paragraphs.length) : 0;
            progressPercent = Math.round(((this.currentChapterIndex + chapterProgress) * chapterWeight) * 100);
            progressPercent = Math.max(0, Math.min(100, progressPercent));
        }

        return this.app.storage.updateBookProgress(this.currentBookId, progressHref, progressParagraphIndex, progressPercent)
            .then(() => {
                this.app.ui.refreshLibraryGrid();
                const bar = document.getElementById('toc-progress-bar');
                const text = document.getElementById('toc-progress-text');
                if (bar && text) {
                    bar.style.width = `${progressPercent}%`;
                    bar.setAttribute('aria-valuenow', progressPercent);
                    text.textContent = `${progressPercent}% leído`;
                }
            });
    }

    populateTOC() {
        const tocList = document.getElementById('toc-list');
        if (!tocList || !this.book || !this.book.navigation) return;
        
        tocList.innerHTML = '';
        
        const renderTOCItems = (items, level = 0) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'list-group-item';
                li.style.paddingLeft = `${1.25 + level * 0.75}rem`;
                li.textContent = item.label ? item.label.trim() : "Capítulo";
                
                const hrefClean = item.href ? item.href.trim() : "";
                li.setAttribute('data-href', hrefClean);
                
                li.onclick = (e) => {
                    e.stopPropagation();
                    const baseHref = hrefClean.split('#')[0];
                    const index = this.spineItems.findIndex(spine => spine.href.includes(baseHref) || baseHref.includes(spine.href));
                    if (index !== -1) {
                        const offcanvasEl = document.getElementById('tocOffcanvas');
                        const offcanvas = bootstrap.Offcanvas.getInstance(offcanvasEl);
                        if (offcanvas) offcanvas.hide();
                        
                        this.loadChapter(index, 0);
                        if (this.app.tts.isPlaying) {
                            setTimeout(() => this.app.tts.play(), 200);
                        }
                    }
                };
                
                tocList.appendChild(li);
                
                if (item.subitems && item.subitems.length > 0) {
                    renderTOCItems(item.subitems, level + 1);
                }
            });
        };
        
        renderTOCItems(this.book.navigation.toc || []);

        // Fallback to spine items list if TOC metadata is absent
        if (tocList.children.length === 0 && this.spineItems.length > 0) {
            this.spineItems.forEach((item, index) => {
                const li = document.createElement('li');
                li.className = 'list-group-item';
                li.textContent = `Capítulo ${index + 1}`;
                li.setAttribute('data-href', item.href);
                li.onclick = () => {
                    const offcanvasEl = document.getElementById('tocOffcanvas');
                    const offcanvas = bootstrap.Offcanvas.getInstance(offcanvasEl);
                    if (offcanvas) offcanvas.hide();
                    
                    this.loadChapter(index, 0);
                    if (this.app.tts.isPlaying) {
                        setTimeout(() => this.app.tts.play(), 200);
                    }
                };
                tocList.appendChild(li);
            });
        }
    }

    updateTOCSelection(activeHref) {
        const items = document.querySelectorAll('#toc-list .list-group-item');
        items.forEach(li => li.classList.remove('active'));
        
        if (!activeHref) return;
        const cleanHref = activeHref.split('#')[0];
        
        const matched = Array.from(items).find(li => {
            const dataHref = li.getAttribute('data-href').split('#')[0];
            return dataHref.includes(cleanHref) || cleanHref.includes(dataHref);
        });
        
        if (matched) {
            matched.classList.add('active');
        }
    }
}


// --- 4. UI Manager (Coordination & Presentation) ---
class UIManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.activeTheme = 'dark';
        
        this.setupGeneralEvents();
        this.setupLibraryEvents();
        this.setupReaderEvents();
        this.setupTTSEvents();
        this.setupScrollTracker();
        
        this.applySettingsUI();
    }

    applySettingsUI() {
        const settings = this.app.storage.getSettings();
        
        this.setAppTheme(settings.theme);
        
        document.getElementById('font-size-val').textContent = `${settings.fontSize}%`;
        document.getElementById('font-family-select').value = settings.fontFamily;
        
        this.app.tts.setSpeed(settings.speed);
    }

    setAppTheme(themeName) {
        this.activeTheme = themeName;
        document.body.setAttribute('data-theme', themeName);
        
        // Sync active state in navbar buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            const btnTheme = btn.getAttribute('data-set-theme');
            if (btnTheme === themeName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Save settings
        const settings = this.app.storage.getSettings();
        settings.theme = themeName;
        this.app.storage.saveSettings(settings);
    }

    setupGeneralEvents() {
        // Theme buttons click
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.getAttribute('data-set-theme');
                this.setAppTheme(theme);
            });
        });
    }

    setupLibraryEvents() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        
        dropZone.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT') {
                fileInput.click();
            }
        });
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            }, false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
            }, false);
        });
        
        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files && files.length > 0) {
                this.handleImportFile(files[0]);
            }
        });
        
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length > 0) {
                this.handleImportFile(fileInput.files[0]);
                fileInput.value = '';
            }
        });
    }

    setupReaderEvents() {
        // Back to library button
        document.getElementById('close-reader-btn').addEventListener('click', () => {
            this.closeReaderMode();
        });
        
        // Font select settings dropdown
        document.getElementById('font-family-select').addEventListener('change', (e) => {
            this.app.reader.setFontFamily(e.target.value);
        });
        
        // Font Size controls
        document.getElementById('font-inc-btn').addEventListener('click', () => {
            const settings = this.app.storage.getSettings();
            if (settings.fontSize < 200) {
                this.app.reader.setFontSize(settings.fontSize + 10);
                document.getElementById('font-size-val').textContent = `${settings.fontSize + 10}%`;
            }
        });
        
        document.getElementById('font-dec-btn').addEventListener('click', () => {
            const settings = this.app.storage.getSettings();
            if (settings.fontSize > 60) {
                this.app.reader.setFontSize(settings.fontSize - 10);
                document.getElementById('font-size-val').textContent = `${settings.fontSize - 10}%`;
            }
        });
    }

    setupTTSEvents() {
        document.getElementById('tts-play-btn').addEventListener('click', () => {
            this.app.tts.playPause();
        });
        
        document.getElementById('tts-stop-btn').addEventListener('click', () => {
            this.app.tts.stop();
        });
        
        document.getElementById('tts-next-btn').addEventListener('click', () => {
            this.app.tts.next();
        });
        
        document.getElementById('tts-prev-btn').addEventListener('click', () => {
            this.app.tts.prev();
        });
        
        // Speed slider
        const speedSlider = document.getElementById('tts-speed-slider');
        speedSlider.addEventListener('input', (e) => {
            this.app.tts.setSpeed(e.target.value);
        });
    }

    // Scroll tracker: syncs visual position with TTS active block index
    setupScrollTracker() {
        let scrollTimeout;
        window.addEventListener('scroll', () => {
            // Ignore scroll alignment if TTS speech is reading
            if (this.app.tts.isPlaying || !document.getElementById('reader-view').classList.contains('active')) {
                return;
            }
            
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.syncParagraphFromScroll();
            }, 250);
        });
    }

    syncParagraphFromScroll() {
        const paragraphs = this.app.reader.paragraphs;
        if (!paragraphs || paragraphs.length === 0) return;
        
        const viewportMiddle = window.innerHeight / 2;
        let closestIndex = 0;
        let closestDistance = Infinity;
        
        for (let i = 0; i < paragraphs.length; i++) {
            const rect = paragraphs[i].getBoundingClientRect();
            const elementMiddle = rect.top + rect.height / 2;
            const distance = Math.abs(elementMiddle - viewportMiddle);
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestIndex = i;
            }
        }
        
        this.app.reader.currentParagraphIndex = closestIndex;
        this.app.tts.currentIndex = closestIndex;
        
        this.app.tts.highlightParagraph(closestIndex);
        this.app.tts.updatePositionUI();
        
        this.app.reader.saveReadingProgress();
    }

    // --- Core Operations ---
    handleImportFile(file) {
        if (!file.name.endsWith('.epub')) {
            alert("Error: Por favor selecciona únicamente archivos en formato .epub");
            return;
        }
        
        const dropZone = document.getElementById('drop-zone');
        const origContent = dropZone.innerHTML;
        dropZone.style.pointerEvents = 'none';
        dropZone.innerHTML = `
            <div class="upload-icon-wrapper spinner-animation text-primary mb-3">
                <i data-lucide="loader-2" style="width: 32px; height: 32px;"></i>
            </div>
            <h4 class="fw-bold">Procesando libro...</h4>
            <p class="text-muted">Extrayendo portadas y metadatos del EPUB</p>
        `;
        lucide.createIcons();
        
        const tempBook = ePub();
        tempBook.open(file).then(async () => {
            await tempBook.ready;
            
            const metadata = tempBook.package.metadata;
            const title = metadata.title ? metadata.title.trim() : file.name.replace('.epub', '');
            const author = metadata.creator ? metadata.creator.trim() : 'Autor Desconocido';
            
            // Extract cover image as Blob
            let coverBlob = null;
            try {
                const coverUrl = await tempBook.coverUrl();
                if (coverUrl) {
                    const response = await fetch(coverUrl);
                    coverBlob = await response.blob();
                }
            } catch (err) {
                console.warn("No se pudo extraer la portada", err);
            }
            
            const idInput = `${title}-${author}-${file.size}`.toLowerCase().replace(/[^a-z0-9]/g, '-');
            
            const bookRecord = {
                id: idInput,
                title: title,
                author: author,
                cover: coverBlob,
                file: file,
                progressHref: null,
                progressParagraphIndex: 0,
                progressPercent: 0,
                lastRead: Date.now(),
                addedAt: Date.now()
            };
            
            this.app.storage.saveBook(bookRecord).then(() => {
                dropZone.innerHTML = origContent;
                dropZone.style.pointerEvents = 'auto';
                lucide.createIcons();
                this.setupLibraryEvents(); // Rebind events
                
                this.refreshLibraryGrid();
            }).catch(e => {
                console.error(e);
                alert("Error al guardar el libro.");
                dropZone.innerHTML = origContent;
                dropZone.style.pointerEvents = 'auto';
                lucide.createIcons();
                this.setupLibraryEvents();
            });
        }).catch(err => {
            console.error(err);
            alert("Error al abrir el EPUB. El archivo podría estar dañado.");
            dropZone.innerHTML = origContent;
            dropZone.style.pointerEvents = 'auto';
            lucide.createIcons();
            this.setupLibraryEvents();
        });
    }

    refreshLibraryGrid() {
        const grid = document.getElementById('book-grid');
        const empty = document.getElementById('library-empty');
        
        this.app.storage.getAllBooks().then(books => {
            const cards = grid.querySelectorAll('.book-card');
            cards.forEach(card => card.remove());
            
            if (books.length === 0) {
                empty.style.display = 'block';
                return;
            }
            
            empty.style.display = 'none';
            
            books.forEach(book => {
                const col = document.createElement('div');
                col.className = 'col book-card-col';
                
                const card = document.createElement('div');
                card.className = 'book-card shadow-sm';
                card.setAttribute('data-id', book.id);
                
                // Cover Image Container
                const coverContainer = document.createElement('div');
                coverContainer.className = 'book-cover-container';
                
                if (book.cover) {
                    const img = document.createElement('img');
                    img.className = 'book-cover-img';
                    img.src = URL.createObjectURL(book.cover);
                    img.alt = book.title;
                    coverContainer.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'book-cover-placeholder';
                    placeholder.innerHTML = `
                        <span class="placeholder-logo">ECHOREAD</span>
                        <h5 class="placeholder-title mt-4">${book.title}</h5>
                        <span class="placeholder-author mb-2 text-truncate d-block">${book.author}</span>
                    `;
                    coverContainer.appendChild(placeholder);
                }
                
                // Action Overlays
                const overlay = document.createElement('div');
                overlay.className = 'card-overlay';
                
                const playBtn = document.createElement('button');
                playBtn.className = 'overlay-btn play';
                playBtn.innerHTML = `<i data-lucide="play"></i>`;
                playBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.openBookInReader(book.id);
                };
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'overlay-btn delete';
                deleteBtn.innerHTML = `<i data-lucide="trash-2"></i>`;
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm(`¿Eliminar "${book.title}" de la biblioteca?`)) {
                        this.app.storage.deleteBook(book.id).then(() => {
                            this.refreshLibraryGrid();
                        });
                    }
                };
                
                overlay.appendChild(playBtn);
                overlay.appendChild(deleteBtn);
                coverContainer.appendChild(overlay);
                card.appendChild(coverContainer);
                
                // Details
                const details = document.createElement('div');
                details.className = 'book-details';
                
                const title = document.createElement('h5');
                title.className = 'book-title fw-bold';
                title.textContent = book.title;
                
                const author = document.createElement('span');
                author.className = 'book-author text-muted small';
                author.textContent = book.author;
                
                const progressWrapper = document.createElement('div');
                progressWrapper.className = 'book-progress-wrapper w-100';
                
                const barContainer = document.createElement('div');
                barContainer.className = 'progress-bar-container';
                
                const barFill = document.createElement('div');
                barFill.className = 'progress-bar-fill';
                barFill.style.width = `${book.progressPercent || 0}%`;
                
                const labels = document.createElement('div');
                labels.className = 'progress-labels d-flex justify-content-between mt-1 text-muted small';
                labels.innerHTML = `
                    <span>Progreso</span>
                    <span class="fw-bold text-primary">${book.progressPercent || 0}%</span>
                `;
                
                barContainer.appendChild(barFill);
                progressWrapper.appendChild(barContainer);
                progressWrapper.appendChild(labels);
                
                details.appendChild(title);
                details.appendChild(author);
                details.appendChild(progressWrapper);
                card.appendChild(details);
                
                // Open on click
                card.onclick = () => {
                    this.openBookInReader(book.id);
                };
                
                col.appendChild(card);
                grid.appendChild(col);
            });
            
            lucide.createIcons();
        });
    }

    openBookInReader(bookId) {
        this.app.storage.getBook(bookId).then(book => {
            if (!book) return;
            
            const viewer = document.getElementById('viewer');
            viewer.innerHTML = `
                <div class="d-flex flex-column align-items-center justify-content-center py-5">
                    <div class="spinner-animation mb-3">
                        <i data-lucide="loader-2" class="text-primary" style="width: 32px; height: 32px;"></i>
                    </div>
                    <span class="text-muted fw-bold">Cargando libro...</span>
                </div>
            `;
            lucide.createIcons();
            
            // Switch views in UI
            document.getElementById('library-view').classList.add('d-none');
            document.getElementById('reader-view').classList.remove('d-none');
            document.getElementById('tts-player-panel').classList.remove('d-none');
            
            // Toggle navbar items
            document.getElementById('close-reader-btn').classList.remove('d-none');
            document.getElementById('reader-title-info').classList.remove('d-none');
            document.getElementById('toc-btn').classList.remove('d-none');
            document.getElementById('text-settings-dropdown-wrapper').classList.remove('d-none');
            
            setTimeout(() => {
                this.app.reader.loadBook(book.file, book.id, book.progressHref, book.progressParagraphIndex)
                    .then(() => {
                        // Done loading
                    })
                    .catch(err => {
                        console.error(err);
                        alert("Error al cargar el libro. Regresando a biblioteca.");
                        this.closeReaderMode();
                    });
            }, 150);
        });
    }

    closeReaderMode() {
        this.app.reader.unloadBook();
        
        // Toggle views
        document.getElementById('reader-view').classList.add('d-none');
        document.getElementById('tts-player-panel').classList.add('d-none');
        document.getElementById('library-view').classList.remove('d-none');
        
        // Toggle navbar items
        document.getElementById('close-reader-btn').classList.add('d-none');
        document.getElementById('reader-title-info').classList.add('d-none');
        document.getElementById('toc-btn').classList.add('d-none');
        document.getElementById('text-settings-dropdown-wrapper').classList.add('d-none');
        
        this.refreshLibraryGrid();
    }
}


// --- 5. App Orchestrator ---
class EchoReadApp {
    constructor() {
        this.storage = new StorageManager();
        this.tts = new TTSManager(this);
        this.reader = new ReaderManager(this);
        this.ui = new UIManager(this);
    }

    init() {
        this.storage.init().then(() => {
            console.log("IndexedDB inicializado.");
            this.ui.refreshLibraryGrid();
        }).catch(err => {
            console.error("Fallo al inicializar base de datos:", err);
            alert("Atención: No se pudo cargar el almacenamiento local (IndexedDB). Tus libros no se mantendrán al reiniciar.");
        });
        
        lucide.createIcons();
    }
}

// Start app on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
    window.app = new EchoReadApp();
    window.app.init();
    
    // Register PWA Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker registrado con éxito. Scope:', reg.scope))
                .catch(err => console.error('Fallo al registrar Service Worker:', err));
        });
    }
});
