/**
 * Progressive virtual character list renderer.
 *
 * This intentionally avoids bottom-spacer estimation. Items append in normal flow,
 * sentinel sits directly after the last rendered node, and only removed top items
 * are represented by a measured top spacer.
 */
export class VirtualCharacterList {
    #container;
    #options;
    #entities = [];
    /** @type {{index:number,node:HTMLElement}[]} */
    #rendered = [];
    #renderedIndices = new Set();
    #pool = [];
    #topSpacer;
    #sentinel;
    #observer = null;
    #scrollRafPending = false;
    #loadedUntil = -1;
    #maxDOMNodes = 200;
    #knownHeights = new Map();
    #totalRemovedHeight = 0;
    #removedCount = 0;
    #loadingNextChunk = false;
    #allLoadedEmitted = false;

    /**
	 * @param {HTMLElement} container Scroll container element.
	 * @param {object} options Renderer options.
	 * @param {(entity: object, index: number, recycledNode?: HTMLElement) => HTMLElement|JQuery} [options.renderItem] Item renderer.
	 * @param {() => void} [options.onChunkLoaded] Called after a chunk renders.
	 * @param {() => void} [options.onAllLoaded] Called when all entities are loaded.
	 * @param {number} [options.chunkSize=50] Incremental loading chunk size.
	 * @param {number} [options.maxDOMNodes=200] Maximum rendered nodes before top windowing.
	 */
    constructor(container, options = {}) {
        if (!(container instanceof HTMLElement)) {
            throw new TypeError(
                'VirtualCharacterList container must be an HTMLElement',
            );
        }

        if (typeof options.renderItem !== 'function') {
            throw new TypeError('VirtualCharacterList requires options.renderItem');
        }

        this.#container = container;
        this.#options = {
            chunkSize: 50,
            maxDOMNodes: 200,
            onChunkLoaded: null,
            onAllLoaded: null,
            ...options,
        };
        this.#maxDOMNodes = Math.max(
            this.#options.chunkSize,
            Number(this.#options.maxDOMNodes) || 200,
        );

        this.#topSpacer = document.createElement('div');
        this.#topSpacer.classList.add(
            'virtual-character-list-spacer',
            'virtual-character-list-top-spacer',
        );
        this.#topSpacer.setAttribute('aria-hidden', 'true');
        this.#topSpacer.style.cssText = 'width:100%;height:0px;flex-shrink:0;';

        this.#sentinel = document.createElement('div');
        this.#sentinel.classList.add('virtual-character-list-sentinel');
        this.#sentinel.setAttribute('aria-hidden', 'true');
        this.#sentinel.style.cssText = 'width:100%;height:1px;flex-shrink:0;';

        this.#container.addEventListener('scroll', this.#onScroll, {
            passive: true,
        });
        this.#setupObserver();
    }

    /**
	 * Set or replace entity list and render initial chunk.
	 * @param {object[]} entities Entity list.
	 */
    setEntities(entities) {
        this.#entities = Array.isArray(entities) ? [...entities] : [];
        this.#loadedUntil = Math.min(
            this.#entities.length - 1,
            this.#options.chunkSize - 1,
        );
        this.#totalRemovedHeight = 0;
        this.#removedCount = 0;
        this.#knownHeights.clear();
        this.#loadingNextChunk = false;
        this.#allLoadedEmitted = false;

        this.#releaseAll();
        this.#container.textContent = '';
        this.#topSpacer.style.height = '0px';
        this.#container.append(this.#topSpacer, this.#sentinel);
        this.#container.scrollTop = 0;

        if (this.#loadedUntil >= 0) {
            this.#renderChunk(0, this.#loadedUntil);
        }

        this.#observeSentinel();
        this.#options.onChunkLoaded?.();

        if (this.#loadedUntil >= this.#entities.length - 1) {
            this.#emitAllLoaded();
        }
    }

    /**
	 * Get current entity list.
	 * @returns {object[]}
	 */
    getEntities() {
        return this.#entities;
    }

    /**
	 * Destroy renderer and clean up DOM/observers.
	 */
    destroy() {
        this.#container.removeEventListener('scroll', this.#onScroll);
        this.#observer?.disconnect();
        this.#observer = null;
        this.#releaseAll();
        this.#pool.length = 0;
        this.#knownHeights.clear();
        this.#entities = [];
        this.#container.textContent = '';
    }

    /**
	 * Scroll to entity by index. Loads intermediate chunks when needed.
	 * @param {number} index Entity index.
	 */
    scrollToEntity(index) {
        if (!this.#entities.length) {
            return;
        }

        const targetIndex = this.#clampIndex(index);
        if (targetIndex > this.#loadedUntil) {
            this.#loadedUntil = targetIndex;
            this.#renderChunk(this.#lastRenderedIndex() + 1, targetIndex);
            this.#options.onChunkLoaded?.();
        }

        const item = this.#rendered.find((x) => x.index === targetIndex);
        if (item) {
            item.node.scrollIntoView({ block: 'nearest' });
            return;
        }

        this.#container.scrollTop = this.#estimateOffset(targetIndex);
    }

    /**
	 * Get first visible entity index.
	 * @returns {number}
	 */
    getFirstVisibleIndex() {
        const containerTop = this.#container.getBoundingClientRect().top;
        for (const item of this.#rendered) {
            if (item.node.getBoundingClientRect().bottom >= containerTop) {
                return item.index;
            }
        }
        return this.#rendered[0]?.index ?? 0;
    }

    /**
	 * Restore saved scrollTop.
	 * @param {number} scrollTop Saved scrollTop.
	 */
    restoreScrollPosition(scrollTop) {
        const value = Number(scrollTop);
        if (!Number.isFinite(value)) {
            return;
        }
        this.#container.scrollTop = Math.max(0, value);
    }

    /**
	 * Get current scrollTop.
	 * @returns {number}
	 */
    getScrollPosition() {
        return this.#container.scrollTop;
    }

    /**
	 * Re-render an entity if currently visible.
	 * @param {number} index Entity index.
	 */
    updateEntity(index) {
        const targetIndex = Number(index);
        const itemIndex = this.#rendered.findIndex((x) => x.index === targetIndex);
        if (!Number.isInteger(targetIndex) || itemIndex === -1) {
            return;
        }

        const oldItem = this.#rendered[itemIndex];
        const newNode = this.#createNode(targetIndex, oldItem.node);
        if (newNode !== oldItem.node) {
            oldItem.node.replaceWith(newNode);
        }
        this.#rendered[itemIndex] = { index: targetIndex, node: newNode };
        this.#measureItem(targetIndex, newNode);
    }

    /**
	 * Apply selection CSS state to visible character nodes.
	 * @param {Set<number>|number[]} selectedIds Selected data-chid values.
	 * @param {string} className Class to apply/remove.
	 */
    applySelectionState(selectedIds, className) {
        const selectedSet =
			selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);

        for (const item of this.#rendered) {
            const chid = Number(item.node.getAttribute('data-chid'));
            const selected = selectedSet.has(chid);
            item.node.classList.toggle(className, selected);
            const checkbox = item.node.querySelector('.bulk_select_checkbox');
            if (checkbox instanceof HTMLInputElement) {
                checkbox.checked = selected;
            }
        }
    }

    #setupObserver() {
        if (typeof IntersectionObserver !== 'function') {
            return;
        }

        this.#observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    this.#loadNextChunk();
                }
            },
            { root: this.#container, rootMargin: '200px' },
        );
    }

    #observeSentinel() {
        this.#observer?.disconnect();
        this.#observer?.observe(this.#sentinel);
    }

    #onScroll = () => {
        if (this.#scrollRafPending) {
            return;
        }

        this.#scrollRafPending = true;
        requestAnimationFrame(() => {
            this.#scrollRafPending = false;
            this.#maybeWindow();
        });
    };

    #loadNextChunk() {
        if (this.#loadingNextChunk) {
            return;
        }

        if (
            !this.#entities.length ||
			this.#loadedUntil >= this.#entities.length - 1
        ) {
            this.#emitAllLoaded();
            return;
        }

        this.#loadingNextChunk = true;
        const previousLoaded = this.#loadedUntil;
        this.#loadedUntil = Math.min(
            this.#entities.length - 1,
            this.#loadedUntil + this.#options.chunkSize,
        );
        this.#renderChunk(previousLoaded + 1, this.#loadedUntil);
        this.#maybeWindow();
        this.#options.onChunkLoaded?.();

        if (this.#loadedUntil >= this.#entities.length - 1) {
            this.#emitAllLoaded();
        }

        this.#loadingNextChunk = false;

        requestAnimationFrame(() => {
            if (this.#isSentinelNearViewport()) {
                this.#loadNextChunk();
            }
        });
    }

    #emitAllLoaded() {
        if (this.#allLoadedEmitted) {
            return;
        }
        this.#allLoadedEmitted = true;
        this.#options.onAllLoaded?.();
    }

    #isSentinelNearViewport() {
        if (!this.#sentinel.isConnected || !this.#container.isConnected) {
            return false;
        }

        const sentinelRect = this.#sentinel.getBoundingClientRect();
        const containerRect = this.#container.getBoundingClientRect();
        return sentinelRect.top <= containerRect.bottom + 200;
    }

    #renderChunk(firstIndex, lastIndex) {
        if (!this.#entities.length || firstIndex > lastIndex) {
            return;
        }

        const fragment = document.createDocumentFragment();
        for (let index = firstIndex; index <= lastIndex; index++) {
            if (this.#renderedIndices.has(index)) {
                continue;
            }

            const node = this.#createNode(index);
            this.#rendered.push({ index, node });
            this.#renderedIndices.add(index);
            fragment.append(node);
        }

        this.#container.insertBefore(fragment, this.#sentinel);
        this.#measureRenderedRange(firstIndex, lastIndex);
    }

    #createNode(index, recycledNode = this.#acquireNode()) {
        const rendered = this.#options.renderItem(
            this.#entities[index],
            index,
            recycledNode,
        );
        const node = this.#normalizeRenderedNode(rendered);

        if (recycledNode && recycledNode !== node) {
            recycledNode.remove();
        }

        node.dataset.virtualIndex = String(index);
        return node;
    }

    #acquireNode() {
        return this.#pool.pop() || null;
    }

    #normalizeRenderedNode(rendered) {
        if (rendered instanceof HTMLElement) {
            return rendered;
        }

        if (rendered?.jquery && rendered[0] instanceof HTMLElement) {
            return rendered[0];
        }

        throw new TypeError(
            'VirtualCharacterList renderItem must return an HTMLElement or jQuery object',
        );
    }

    #maybeWindow() {
        if (this.#rendered.length <= this.#maxDOMNodes) {
            return;
        }

        const scrollDirectionDown =
			this.#container.scrollTop > this.#totalRemovedHeight;
        if (!scrollDirectionDown) {
            return;
        }

        const removeCount = Math.min(
            this.#rendered.length - this.#maxDOMNodes + this.#options.chunkSize,
            this.#rendered.length - this.#options.chunkSize,
        );

        if (removeCount <= 0) {
            return;
        }

        const anchor = this.#rendered[removeCount];
        const oldAnchorTop = anchor?.node.getBoundingClientRect().top ?? 0;
        let removedHeight = 0;

        for (let i = 0; i < removeCount; i++) {
            const item = this.#rendered.shift();
            if (!item) {
                break;
            }

            const height = this.#measureItem(item.index, item.node);
            removedHeight += height;
            this.#renderedIndices.delete(item.index);
            item.node.remove();
            this.#releaseNode(item.node);
        }

        this.#totalRemovedHeight += removedHeight;
        this.#removedCount += removeCount;
        this.#topSpacer.style.height = `${this.#totalRemovedHeight}px`;

        if (anchor) {
            const newAnchorTop = anchor.node.getBoundingClientRect().top;
            this.#container.scrollTop += newAnchorTop - oldAnchorTop;
        }
    }

    #releaseAll() {
        for (const item of this.#rendered) {
            item.node.remove();
            this.#releaseNode(item.node);
        }
        this.#rendered.length = 0;
        this.#renderedIndices.clear();
    }

    #releaseNode(node) {
        if (!(node instanceof HTMLElement)) {
            return;
        }

        node.remove();
        const img = node.querySelector('img');
        if (img instanceof HTMLImageElement) {
            img.src = '';
            img.removeAttribute('srcset');
        }

        if (this.#pool.length < this.#maxDOMNodes) {
            this.#pool.push(node);
        }
    }

    #measureRenderedRange(firstIndex, lastIndex) {
        for (let index = firstIndex; index <= lastIndex; index++) {
            const item = this.#rendered.find((x) => x.index === index);
            if (item) {
                this.#measureItem(index, item.node);
            }
        }
    }

    #measureItem(index, node) {
        const height =
			node.getBoundingClientRect().height ||
			this.#knownHeights.get(index) ||
			80;
        this.#knownHeights.set(index, height);
        return height;
    }

    #estimateOffset(index) {
        let offset = 0;
        for (let i = 0; i < index; i++) {
            offset += this.#knownHeights.get(i) || 80;
        }
        return offset;
    }

    #lastRenderedIndex() {
        return this.#rendered.at(-1)?.index ?? -1;
    }

    #clampIndex(index) {
        if (!this.#entities.length) {
            return 0;
        }
        return Math.max(0, Math.min(this.#entities.length - 1, Number(index) || 0));
    }
}
