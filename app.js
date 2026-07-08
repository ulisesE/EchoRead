/* ==========================================================================
   EchoRead - Application Logic (ES6 SPA)
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
                    // keyPath is 'id', which will be generated from metadata (title + author + size)
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
                // Return books sorted by lastRead timestamp (newest first)
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

    updateBookProgress(id, progressCfi, progressPercent) {
        return new Promise((resolve, reject) => {
            this.getBook(id).then(book => {
                if (!book) return reject("Book not found");
                book.progress = progressCfi;
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
        
        this.textElements = [];
        this.currentIndex = -1;
        this.currentUtterance = null;
        this.isPlaying = false;
        
        this.autoPlayNextPage = false;
        this.currentDoc = null;
        this.targetSpeakIndex = null;
        this.skipVisibilityCheck = false;
        this.currentPageIndex = 0;
        this.isUpdatingLocationFromTTS = false;
        
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
            option.textContent = "No se encontraron voces (TTS)";
            select.appendChild(option);
            return;
        }
        
        // Sort voices
        const sorted = [...voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
        
        // Populate dropdown
        sorted.forEach((voice, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.localService) {
                option.textContent += ' [Local]';
            }
            select.appendChild(option);
        });

        // Find default or saved voice
        let defaultIndex = -1;
        const settings = this.app.storage.getSettings();
        
        // 1. Try to restore saved voice
        if (settings.voiceName) {
            defaultIndex = sorted.findIndex(v => v.name === settings.voiceName);
        }
        
        // 2. Try to find Mexican Spanish (es-MX)
        if (defaultIndex === -1) {
            defaultIndex = sorted.findIndex(v => {
                const lang = v.lang.toLowerCase().replace('_', '-');
                return lang === 'es-mx' || lang.startsWith('es-mx');
            });
        }
        
        // 3. Try to find any Spanish voice (es-*)
        if (defaultIndex === -1) {
            defaultIndex = sorted.findIndex(v => v.lang.toLowerCase().startsWith('es'));
        }
        
        // 4. Try to find system default voice
        if (defaultIndex === -1) {
            defaultIndex = sorted.findIndex(v => v.default);
        }
        
        // 5. Fallback to index 0
        if (defaultIndex === -1) {
            defaultIndex = 0;
        }
        
        select.selectedIndex = defaultIndex;
        this.selectedVoice = sorted[defaultIndex];
        
        // Setup listener
        select.onchange = () => {
            this.selectedVoice = sorted[select.selectedIndex];
            const settings = this.app.storage.getSettings();
            settings.voiceName = this.selectedVoice.name;
            this.app.storage.saveSettings(settings);
            
            // If currently speaking, restart current paragraph with new voice
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
        
        // Restart speech if active to apply speed immediately
        if (this.isPlaying) {
            this.speakParagraph(this.currentIndex);
        }
    }

    setDocument(doc) {
        const isSameDoc = (this.currentDoc === doc);
        this.currentDoc = doc;
        const wasPlaying = this.isPlaying;
        
        // Stop current speaking to prevent overlaps when relocating
        this.stopSilence();
        this.clearHighlights();
        
        if (!isSameDoc) {
            // Find all readable nodes inside the iframe doc
            const selectors = 'p, h1, h2, h3, h4, h5, h6, li';
            const rawElements = Array.from(doc.querySelectorAll(selectors));
            
            // Filter elements with non-empty text, excluding nav/header/footer content
            this.textElements = rawElements.filter(el => {
                const text = el.textContent.trim();
                // Skip short metadata, SVGs, header/footers or empty items
                if (text.length === 0) return false;
                if (el.closest('header, footer, nav, noscript, svg')) return false;
                return true;
            });
            
            // Generate CFI for each element
            const location = this.app.reader.rendition ? this.app.reader.rendition.currentLocation() : null;
            const section = location && location.start ? this.app.reader.book.section(location.start.href) : null;
            
            // Add click events and attach CFI to text elements
            this.textElements.forEach((el, index) => {
                el.style.cursor = 'pointer';
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.speakParagraph(index);
                });
                
                if (section) {
                    try {
                        el.cfi = section.cfiFromElement(el);
                    } catch (err) {
                        console.warn("Failed to generate CFI for element", el, err);
                        el.cfi = null;
                    }
                } else {
                    el.cfi = null;
                }
            });
        }
        
        // If we are updating location internally from TTS, skip rebuilding state to prevent loops
        if (this.isUpdatingLocationFromTTS) {
            this.isUpdatingLocationFromTTS = false;
            return;
        }
        
        // Find the index of the first visible paragraph on the current page view
        // Wait 150ms for epub.js layout to settle before measuring
        setTimeout(() => {
            this.currentPageIndex = this.getCurrentReaderPageIndex();
            this.currentIndex = this.findFirstParagraphOnPage(this.currentPageIndex);
            this.updatePositionUI();
            
            // If it was playing, resume speaking from the first visible paragraph
            if (wasPlaying || this.autoPlayNextPage) {
                this.autoPlayNextPage = false;
                this.isPlaying = true;
                this.updatePlayerUI();
                
                // If it is a new chapter, skip the first visibility check to prevent jumping back
                if (!isSameDoc) {
                    this.skipVisibilityCheck = true;
                }
                this.speakParagraph(this.currentIndex);
            } else {
                this.highlightElement(this.currentIndex);
            }
        }, 150);
    }

    getParagraphPageIndex(el) {
        if (!el) return 0;
        const contents = this.app.reader.rendition ? this.app.reader.rendition.getContents()[0] : null;
        if (!contents) return 0;
        
        const viewportHeight = contents.document.documentElement.clientHeight || window.innerHeight;
        
        // Find absolute top position of the element inside the document
        let top = 0;
        let current = el;
        while (current && current.offsetParent) {
            top += current.offsetTop || 0;
            current = current.offsetParent;
        }
        
        return Math.floor(top / (viewportHeight || 600));
    }

    getCurrentReaderPageIndex() {
        if (!this.app.reader.rendition) return 0;
        const contents = this.app.reader.rendition.getContents()[0];
        if (!contents) return 0;
        
        const scrollLeft = contents.document.documentElement.scrollLeft || contents.document.body.scrollLeft || 0;
        const viewportWidth = contents.document.documentElement.clientWidth || window.innerWidth;
        
        return Math.round(scrollLeft / (viewportWidth || 360));
    }

    findFirstParagraphOnPage(pageIndex) {
        for (let i = 0; i < this.textElements.length; i++) {
            if (this.getParagraphPageIndex(this.textElements[i]) === pageIndex) {
                return i;
            }
        }
        return 0;
    }

    speakParagraph(index, useFallbackVoice = false) {
        if (!this.synth) return;
        
        const skipVis = this.skipVisibilityCheck;
        this.skipVisibilityCheck = false; // Reset immediately
        
        if (this.currentUtterance) {
            this.currentUtterance.onend = null;
            this.currentUtterance.onerror = null;
        }
        this.synth.cancel();
        
        if (index < 0) index = 0;
        
        // If we reached the end of the current section
        if (index >= this.textElements.length) {
            this.clearHighlights();
            this.autoPlayNextPage = true;
            this.app.reader.nextPage().then(navigated => {
                if (!navigated) {
                    // No next chapter, stop
                    this.stop();
                    this.autoPlayNextPage = false;
                    alert("Has llegado al final del libro.");
                }
            });
            return;
        }
        
        this.currentIndex = index;
        this.updatePositionUI();
        
        const el = this.textElements[index];
        
        // Check page transitions if in paginated mode
        if (!skipVis && el.cfi && this.app.reader.rendition && this.app.reader.rendition.settings.flow === 'paginated') {
            const targetPageIndex = this.getParagraphPageIndex(el);
            
            // If the element is on a different page, use CFI navigation to turn page
            if (targetPageIndex !== this.currentPageIndex) {
                this.currentPageIndex = targetPageIndex;
                this.isUpdatingLocationFromTTS = true;
                
                this.app.reader.rendition.display(el.cfi).then(() => {
                    if (this.isPlaying) {
                        this.speakParagraph(index, useFallbackVoice);
                    }
                });
                return;
            }
        }
        
        this.highlightElement(index);
        
        const text = el.textContent.trim();
        
        this.currentUtterance = new SpeechSynthesisUtterance(text);
        
        // Determine voice to use: fallback to a local Spanish voice (or system default) if cloud voice failed
        let voiceToUse = this.selectedVoice;
        if (useFallbackVoice) {
            const localSpanishVoice = this.voices.find(v => v.localService && v.lang.toLowerCase().startsWith('es'));
            voiceToUse = localSpanishVoice || null;
            console.warn("Using fallback local voice:", voiceToUse ? voiceToUse.name : "System default");
        }
        
        if (voiceToUse) {
            this.currentUtterance.voice = voiceToUse;
        }
        this.currentUtterance.rate = this.speed;
        
        this.currentUtterance.onend = () => {
            if (this.isPlaying) {
                this.speakParagraph(this.currentIndex + 1, useFallbackVoice);
            }
        };
        
        this.currentUtterance.onerror = (e) => {
            if (e.error !== 'interrupted') {
                console.warn("TTS Utterance boundary/error: ", e);
            }
            if (e.error === 'synthesis-failed' && !useFallbackVoice && this.selectedVoice) {
                console.warn("TTS cloud voice failed. Retrying with local Spanish fallback voice...");
                this.speakParagraph(this.currentIndex, true); // Retry current paragraph with fallback
                return;
            }
            if (e.error !== 'interrupted' && this.isPlaying) {
                this.speakParagraph(this.currentIndex + 1, useFallbackVoice);
            }
        };
        
        this.isPlaying = true;
        this.updatePlayerUI();
        this.synth.speak(this.currentUtterance);
    }

    playPause() {
        if (!this.synth) return;
        
        if (this.isPlaying) {
            // Pause
            if (this.currentUtterance) {
                this.currentUtterance.onend = null;
                this.currentUtterance.onerror = null;
            }
            this.synth.cancel(); // cancel current, set state to paused
            this.isPlaying = false;
            this.updatePlayerUI();
        } else {
            // Play
            this.isPlaying = true;
            this.speakParagraph(this.currentIndex !== -1 ? this.currentIndex : 0);
        }
    }

    stop() {
        if (!this.synth) return;
        this.isPlaying = false;
        this.autoPlayNextPage = false;
        this.targetSpeakIndex = null;
        if (this.currentUtterance) {
            this.currentUtterance.onend = null;
            this.currentUtterance.onerror = null;
        }
        this.synth.cancel();
        this.clearHighlights();
        this.currentIndex = 0;
        this.updatePositionUI();
        this.updatePlayerUI();
    }
    
    stopSilence() {
        if (this.currentUtterance) {
            this.currentUtterance.onend = null;
            this.currentUtterance.onerror = null;
        }
        if (this.synth) {
            this.synth.cancel();
        }
    }

    next() {
        if (this.textElements.length === 0) return;
        this.speakParagraph(this.currentIndex + 1);
    }

    prev() {
        if (this.textElements.length === 0) return;
        this.speakParagraph(this.currentIndex - 1);
    }

    highlightElement(index) {
        this.clearHighlights();
        if (index >= 0 && index < this.textElements.length) {
            const el = this.textElements[index];
            el.classList.add('tts-highlight');
            
            // Only scroll into view if NOT in paginated mode (horizontal flow)
            const isPaginated = this.app.reader.rendition && this.app.reader.rendition.settings.flow === 'paginated';
            if (!isPaginated) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    clearHighlights() {
        this.textElements.forEach(el => {
            el.classList.remove('tts-highlight');
        });
    }

    updatePositionUI() {
        const total = this.textElements.length;
        const current = total > 0 ? this.currentIndex + 1 : 0;
        document.getElementById('tts-position-text').textContent = `Párrafo ${current}/${total}`;
    }

    updatePlayerUI() {
        const playIcon = document.getElementById('tts-play-icon');
        const playBtn = document.getElementById('tts-play-btn');
        const pulse = document.querySelector('.tts-indicator-pulse');
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
}


// --- 3. Reader Manager (epub.js controller) ---
class ReaderManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.book = null;
        this.rendition = null;
        this.currentBookId = null;
        this.currentLocation = null;
        this.displayedCfi = null;
    }

    loadBook(fileBlob, bookId, savedCfi = null) {
        return new Promise((resolve, reject) => {
            // Clean up existing book
            this.unloadBook();
            this.currentBookId = bookId;
            
            // Init book
            this.book = ePub();
            
            // We use ArrayBuffer or Blob
            this.book.open(fileBlob).then(() => {
                return this.book.ready;
            }).then(() => {
                // Get title for reader header
                const title = this.book.package.metadata.title || "Libro sin título";
                document.getElementById('reader-book-title').textContent = title;
                
                // Get TOC (Table of Contents)
                this.populateTOC();
                
                // Lock viewer height to workspace client height in pixels to prevent mobile iframe height expansion
                const workspaceHeight = document.getElementById('reader-workspace').clientHeight || 600;
                document.getElementById('viewer').style.height = `${workspaceHeight}px`;
                
                // Create Rendition inside viewer
                const settings = this.app.storage.getSettings();
                this.rendition = this.book.renderTo("viewer", {
                    width: "100%",
                    height: "100%",
                    spread: "none",
                    flow: "paginated",
                    allowScriptedContent: true
                });
                
                // Inject custom CSS styling inside the iframe
                this.rendition.hooks.content.register((contents) => {
                    // Inject viewport meta tag to force correct layout scale on mobile
                    let meta = contents.document.querySelector('meta[name="viewport"]');
                    if (!meta) {
                        meta = contents.document.createElement('meta');
                        meta.setAttribute('name', 'viewport');
                        meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
                        contents.document.head.appendChild(meta);
                    }
                    
                    // Tap margins to turn pages
                    contents.document.addEventListener("click", (e) => {
                        const width = contents.document.documentElement.clientWidth;
                        const x = e.clientX;
                        // Skip if user clicks an interactive element or paragraph with click-to-read pointer
                        if (e.target.closest('a, button, input, select') || e.target.style.cursor === 'pointer') {
                            return;
                        }
                        if (x < width * 0.18) {
                            this.prevPage();
                        } else if (x > width * 0.82) {
                            this.nextPage();
                        }
                    });
                    
                    contents.addStylesheetRules({
                        "body": {
                            "font-family": `${settings.fontFamily} !important`,
                            "line-height": "1.6 !important",
                            "padding": "12px 24px !important",
                            "margin": "0 !important",
                            "box-sizing": "border-box !important"
                        },
                        "p": {
                            "margin-bottom": "1.2em !important",
                            "font-size": "inherit !important",
                            "line-height": "1.6 !important",
                            "word-wrap": "break-word !important",
                            "break-inside": "avoid !important",
                            "-webkit-column-break-inside": "avoid !important",
                            "page-break-inside": "avoid !important"
                        },
                        "li": {
                            "break-inside": "avoid !important",
                            "-webkit-column-break-inside": "avoid !important",
                            "page-break-inside": "avoid !important"
                        },
                        "img": {
                            "max-width": "100% !important",
                            "height": "auto !important"
                        },
                        ".tts-highlight": {
                            "background-color": "rgba(99, 102, 241, 0.25) !important",
                            "border-bottom": "2px solid var(--primary-color, #6366f1) !important",
                            "border-radius": "4px",
                            "transition": "background-color 0.2s ease, border-bottom 0.2s ease"
                        }
                    });
                });
                
                // Setup themes
                this.rendition.themes.register("light", {
                    "body": { "background": "#ffffff", "color": "#0f172a" }
                });
                this.rendition.themes.register("sepia", {
                    "body": { "background": "#fdfaf2", "color": "#431407" }
                });
                this.rendition.themes.register("dark", {
                    "body": { "background": "#0c111d", "color": "#f1f5f9" }
                });
                this.rendition.themes.select(settings.theme);
                this.setFontSize(settings.fontSize);

                // Relocation handler
                this.rendition.on("relocated", (location) => {
                    this.currentLocation = location;
                    this.displayedCfi = location.start.cfi;
                    
                    // Save progress
                    const percentage = Math.round((location.start.percentage || 0) * 100);
                    this.app.storage.updateBookProgress(this.currentBookId, this.displayedCfi, percentage)
                        .then(() => {
                            this.app.ui.refreshLibraryGrid(); // Refresh cards to update visual progress
                        });
                    
                    // Update chapter title
                    let chapterTitle = "Capítulo";
                    if (location.start.href && this.book.navigation) {
                        const chapter = this.book.navigation.get(location.start.href);
                        if (chapter) {
                            chapterTitle = chapter.label.trim();
                        }
                    }
                    document.getElementById('reader-chapter-title').textContent = chapterTitle;
                    
                    // Highlight active chapter in TOC list
                    const activeTOCItem = document.querySelector(`#toc-list li[data-href="${location.start.href}"]`);
                    document.querySelectorAll('#toc-list li').forEach(li => li.classList.remove('active'));
                    if (activeTOCItem) {
                        activeTOCItem.classList.add('active');
                    }
                    
                    // Setup new elements in TTS manager
                    const contents = this.rendition.getContents()[0];
                    if (contents && contents.document) {
                        this.app.tts.setDocument(contents.document);
                    }
                });
                
                // Listen to arrow navigation keys inside reader view
                this.rendition.on("keyup", (e) => {
                    if (e.key === "ArrowRight") this.nextPage();
                    if (e.key === "ArrowLeft") this.prevPage();
                });
                
                // Display the book at either saved CFI or first page
                this.rendition.display(savedCfi || undefined).then(() => {
                    resolve();
                }).catch(reject);
            }).catch(reject);
        });
    }

    unloadBook() {
        this.app.tts.stopSilence();
        this.app.tts.currentDoc = null; // Reset document reference
        this.app.tts.targetSpeakIndex = null; // Clear lock
        if (this.rendition) {
            this.rendition.destroy();
            this.rendition = null;
        }
        this.book = null;
        this.currentBookId = null;
        this.currentLocation = null;
        this.displayedCfi = null;
        document.getElementById('viewer').innerHTML = '';
        document.getElementById('toc-list').innerHTML = '';
    }

    nextPage() {
        if (this.rendition) {
            return this.rendition.next().then(() => true).catch(() => false);
        }
        return Promise.resolve(false);
    }

    prevPage() {
        if (this.rendition) {
            return this.rendition.prev().then(() => true).catch(() => false);
        }
        return Promise.resolve(false);
    }

    jumpTo(cfi) {
        if (this.rendition) {
            this.rendition.display(cfi);
        }
    }

    setTheme(themeName) {
        if (this.rendition) {
            this.rendition.themes.select(themeName);
        }
    }

    setFontSize(sizePercent) {
        if (this.rendition) {
            this.rendition.themes.fontSize(`${sizePercent}%`);
        }
    }
    
    setFontFamily(family) {
        if (this.rendition) {
            this.rendition.themes.font(family);
        }
    }

    populateTOC() {
        const tocList = document.getElementById('toc-list');
        if (!tocList || !this.book || !this.book.navigation) return;
        
        tocList.innerHTML = '';
        
        const renderTOCItems = (items) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.textContent = item.label ? item.label.trim() : "Capítulo";
                li.setAttribute('data-href', item.href);
                
                li.onclick = (e) => {
                    e.stopPropagation();
                    this.jumpTo(item.href);
                    document.getElementById('toc-dropdown').parentElement.classList.remove('open');
                };
                
                tocList.appendChild(li);
                
                if (item.subitems && item.subitems.length > 0) {
                    renderTOCItems(item.subitems);
                }
            });
        };
        
        renderTOCItems(this.book.navigation.toc);
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
        
        // Initialize visual states from settings
        this.applySettingsUI();
    }

    applySettingsUI() {
        const settings = this.app.storage.getSettings();
        
        // Theme
        this.setAppTheme(settings.theme);
        
        // Font Size
        document.getElementById('font-size-val').textContent = `${settings.fontSize}%`;
        
        // Font Family
        document.getElementById('font-family-select').value = settings.fontFamily;
        
        // TTS Speed
        this.app.tts.setSpeed(settings.speed);
    }

    setAppTheme(themeName) {
        this.activeTheme = themeName;
        document.body.setAttribute('data-theme', themeName);
        
        // Sync active state in top-header buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            if (btn.getAttribute('data-set-theme') === themeName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Sync active state in reader settings buttons
        document.querySelectorAll('.theme-picker-btn').forEach(btn => {
            if (btn.getAttribute('data-theme-val') === themeName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Sync inside EPUB rendition iframe
        this.app.reader.setTheme(themeName);
        
        // Save settings
        const settings = this.app.storage.getSettings();
        settings.theme = themeName;
        this.app.storage.saveSettings(settings);
    }

    setupGeneralEvents() {
        // Top header theme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.getAttribute('data-set-theme');
                this.setAppTheme(theme);
            });
        });
        
        // Window resize debounced to resize epub.js iframe
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.app.reader.rendition) {
                    const workspaceHeight = document.getElementById('reader-workspace').clientHeight || 600;
                    document.getElementById('viewer').style.height = `${workspaceHeight}px`;
                    this.app.reader.rendition.resize();
                }
            }, 250);
        });

        // Close dropdowns when clicking outside
        window.addEventListener('click', (e) => {
            if (!e.target.closest('.dropdown-container')) {
                document.querySelectorAll('.dropdown-container').forEach(c => {
                    c.classList.remove('open');
                });
            }
        });
    }

    setupLibraryEvents() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        
        // Handle browse link trigger
        dropZone.addEventListener('click', (e) => {
            // Avoid trigger looping
            if (e.target.tagName !== 'INPUT') {
                fileInput.click();
            }
        });
        
        // Handle drag & drop hover states
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
        
        // Drop file event
        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files && files.length > 0) {
                this.handleImportFile(files[0]);
            }
        });
        
        // File input changed event
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length > 0) {
                this.handleImportFile(fileInput.files[0]);
                fileInput.value = ''; // Reset input
            }
        });
    }

    setupReaderEvents() {
        // Volver / Back to library button
        document.getElementById('close-reader-btn').addEventListener('click', () => {
            this.closeReaderMode();
        });
        
        // Nav Arrow Buttons
        document.getElementById('prev-page-btn').addEventListener('click', () => {
            this.app.reader.prevPage();
        });
        
        document.getElementById('next-page-btn').addEventListener('click', () => {
            this.app.reader.nextPage();
        });
        
        // Dropdown toggle triggers (TOC & Settings)
        document.querySelectorAll('.dropdown-container button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const container = btn.parentElement;
                const wasOpen = container.classList.contains('open');
                
                // Close other dropdowns
                document.querySelectorAll('.dropdown-container').forEach(c => {
                    c.classList.remove('open');
                });
                
                if (!wasOpen) {
                    container.classList.add('open');
                }
            });
        });
        
        // Theme picker selection in settings panel
        document.querySelectorAll('.theme-picker-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.getAttribute('data-theme-val');
                this.setAppTheme(theme);
            });
        });
        
        // Font family select dropdown
        document.getElementById('font-family-select').addEventListener('change', (e) => {
            const val = e.target.value;
            this.app.reader.setFontFamily(val);
            
            const settings = this.app.storage.getSettings();
            settings.fontFamily = val;
            this.app.storage.saveSettings(settings);
        });
        
        // Font Size Adjustments
        document.getElementById('font-inc-btn').addEventListener('click', () => {
            const settings = this.app.storage.getSettings();
            if (settings.fontSize < 200) {
                settings.fontSize += 10;
                document.getElementById('font-size-val').textContent = `${settings.fontSize}%`;
                this.app.reader.setFontSize(settings.fontSize);
                this.app.storage.saveSettings(settings);
            }
        });
        
        document.getElementById('font-dec-btn').addEventListener('click', () => {
            const settings = this.app.storage.getSettings();
            if (settings.fontSize > 60) {
                settings.fontSize -= 10;
                document.getElementById('font-size-val').textContent = `${settings.fontSize}%`;
                this.app.reader.setFontSize(settings.fontSize);
                this.app.storage.saveSettings(settings);
            }
        });
    }

    setupTTSEvents() {
        // Controls
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
        
        // Speed slider adjustments
        const speedSlider = document.getElementById('tts-speed-slider');
        speedSlider.addEventListener('input', (e) => {
            this.app.tts.setSpeed(e.target.value);
        });
    }

    // --- Core Operations ---
    handleImportFile(file) {
        if (!file.name.endsWith('.epub')) {
            alert("Error: Por favor sube únicamente archivos en formato .epub");
            return;
        }
        
        // Loading state
        const dropZone = document.getElementById('drop-zone');
        const origContent = dropZone.innerHTML;
        dropZone.style.pointerEvents = 'none';
        dropZone.innerHTML = `
            <div class="upload-icon-wrapper spinner-animation">
                <i data-lucide="loader-2"></i>
            </div>
            <h3>Procesando libro...</h3>
            <p>Extrayendo metadatos y portada</p>
        `;
        lucide.createIcons();
        
        // Temporarily load in memory with epub.js to extract metadata & cover
        const book = ePub();
        book.open(file).then(async () => {
            await book.ready;
            
            const metadata = book.package.metadata;
            const title = metadata.title ? metadata.title.trim() : file.name.replace('.epub', '');
            const author = metadata.creator ? metadata.creator.trim() : 'Autor Desconocido';
            
            // Extract cover
            let coverBlob = null;
            try {
                const coverUrl = await book.coverUrl();
                if (coverUrl) {
                    const response = await fetch(coverUrl);
                    coverBlob = await response.blob();
                }
            } catch (err) {
                console.warn("Cover image extraction failed", err);
            }
            
            // Generate unique ID (título + autor + size)
            const idInput = `${title}-${author}-${file.size}`.toLowerCase().replace(/[^a-z0-9]/g, '-');
            
            const bookRecord = {
                id: idInput,
                title: title,
                author: author,
                cover: coverBlob, // Saved as Blob object in IndexedDB
                file: file, // Full file Blob
                progress: null, // CFI pointer
                progressPercent: 0,
                lastRead: Date.now(),
                addedAt: Date.now()
            };
            
            // Save to IndexedDB
            this.app.storage.saveBook(bookRecord).then(() => {
                // Restore Dropzone UI
                dropZone.innerHTML = origContent;
                dropZone.style.pointerEvents = 'auto';
                lucide.createIcons();
                this.setupLibraryEvents(); // Rebind since innerHTML was reset
                
                // Refresh library list
                this.refreshLibraryGrid();
            }).catch(e => {
                console.error(e);
                alert("Error al guardar el libro en la base de datos.");
                dropZone.innerHTML = origContent;
                dropZone.style.pointerEvents = 'auto';
                lucide.createIcons();
                this.setupLibraryEvents();
            });
        }).catch(err => {
            console.error(err);
            alert("Error al procesar el archivo EPUB. Puede estar corrupto.");
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
            // Remove existing card nodes (keep empty item only if no books)
            const cards = grid.querySelectorAll('.book-card');
            cards.forEach(card => card.remove());
            
            if (books.length === 0) {
                empty.style.display = 'flex';
                return;
            }
            
            empty.style.display = 'none';
            
            books.forEach(book => {
                const card = document.createElement('div');
                card.className = 'book-card';
                card.setAttribute('data-id', book.id);
                
                // Cover
                const coverContainer = document.createElement('div');
                coverContainer.className = 'book-cover-container';
                
                if (book.cover) {
                    const img = document.createElement('img');
                    img.className = 'book-cover-img';
                    img.src = URL.createObjectURL(book.cover);
                    img.alt = book.title;
                    coverContainer.appendChild(img);
                } else {
                    // Fallback visual placeholder
                    const placeholder = document.createElement('div');
                    placeholder.className = 'book-cover-placeholder';
                    placeholder.innerHTML = `
                        <span class="placeholder-logo">ECHOREAD</span>
                        <h4 class="placeholder-title">${book.title}</h4>
                        <span class="placeholder-author">${book.author}</span>
                    `;
                    coverContainer.appendChild(placeholder);
                }
                
                // Hover actions overlay
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
                    if (confirm(`¿Estás seguro de que quieres eliminar "${book.title}" de tu biblioteca?`)) {
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
                
                const title = document.createElement('h3');
                title.className = 'book-title';
                title.textContent = book.title;
                
                const author = document.createElement('span');
                author.className = 'book-author';
                author.textContent = book.author;
                
                const progressWrapper = document.createElement('div');
                progressWrapper.className = 'book-progress-wrapper';
                
                const barContainer = document.createElement('div');
                barContainer.className = 'progress-bar-container';
                
                const barFill = document.createElement('div');
                barFill.className = 'progress-bar-fill';
                barFill.style.width = `${book.progressPercent || 0}%`;
                
                const labels = document.createElement('div');
                labels.className = 'progress-labels';
                labels.innerHTML = `
                    <span>Progreso</span>
                    <span>${book.progressPercent || 0}%</span>
                `;
                
                barContainer.appendChild(barFill);
                progressWrapper.appendChild(barContainer);
                progressWrapper.appendChild(labels);
                
                details.appendChild(title);
                details.appendChild(author);
                details.appendChild(progressWrapper);
                card.appendChild(details);
                
                // Double click / Click to open anywhere on card
                card.onclick = () => {
                    this.openBookInReader(book.id);
                };
                
                grid.appendChild(card);
            });
            
            // Create icons
            lucide.createIcons();
        });
    }

    openBookInReader(bookId) {
        // Load details from DB
        this.app.storage.getBook(bookId).then(book => {
            if (!book) return;
            
            // Show loading placeholder inside reader
            const viewer = document.getElementById('viewer');
            viewer.innerHTML = `
                <div class="reader-loading-spinner" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 16px;">
                    <div class="upload-icon-wrapper spinner-animation" style="margin-bottom:0;">
                        <i data-lucide="loader-2" style="width:32px; height:32px; color:var(--primary-color)"></i>
                    </div>
                    <span style="font-weight:600; color:var(--text-secondary)">Cargando libro...</span>
                </div>
            `;
            lucide.createIcons();
            
            // Switch views
            document.getElementById('library-view').classList.remove('active');
            document.getElementById('reader-view').classList.add('active');
            
            // Wait for browser layout to settle so epub.js measures width correctly
            setTimeout(() => {
                this.app.reader.loadBook(book.file, book.id, book.progress).then(() => {
                    // Done loading
                    const spinner = viewer.querySelector('.reader-loading-spinner');
                    if (spinner) spinner.remove();
                }).catch(err => {
                    console.error(err);
                    alert("Error al renderizar el libro. Volviendo a la biblioteca.");
                    this.closeReaderMode();
                });
            }, 100);
        });
    }

    closeReaderMode() {
        this.app.reader.unloadBook();
        document.getElementById('reader-view').classList.remove('active');
        document.getElementById('library-view').classList.add('active');
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
            console.log("StorageManager DB initialized successfully.");
            this.ui.refreshLibraryGrid();
        }).catch(err => {
            console.error("Failed to initialize database", err);
            alert("Advertencia: No se pudo cargar el almacenamiento IndexedDB. Los libros no se guardarán al reiniciar.");
        });
        
        // Initial setup for Lucide Icons
        lucide.createIcons();
    }
}

// Instantiate and start app on page load
window.addEventListener('DOMContentLoaded', () => {
    window.app = new EchoReadApp();
    window.app.init();
    
    // Register Service Worker for PWA offline capabilities
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker registered successfully with scope:', reg.scope))
                .catch(err => console.error('Service Worker registration failed:', err));
        });
    }
});
