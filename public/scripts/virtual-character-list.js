/**
 * Virtualized character list renderer.
 * Keeps only visible rows plus buffer in DOM, using spacers to preserve scroll size.
 */
export class VirtualCharacterList {
    #container;
    #options;
    #entities = [];
    #rendered = new Map();
    #heights = new Map();
    #pool = [];
    #topSpacer;
    #bottomSpacer;
    #sentinel;
    #sentinelObserver = null;
    #scrollRafPending = false;
    #measurementRafPending = false;
    #firstRenderedIndex = -1;
    #lastRenderedIndex = -1;
    #loadedUntil = -1;
    #averageItemHeight = 80;
    #maxPoolSize = 200;

    /**
	 * @param {HTMLElement} container Scroll container element.
	 * @param {object} options Renderer options.
	 * @param {(entity: object, index: number, recycledNode?: HTMLElement) => HTMLElement|JQuery} options.renderItem Item renderer.
	 * @param {() => void} [options.onChunkLoaded] Called after a chunk/range renders.
	 * @param {() => void} [options.onAllLoaded] Called when all entities are available to render.
	 * @param {number} [options.chunkSize=50] Incremental loading chunk size.
	 * @param {number} [options.bufferSize=20] Items to keep above/below viewport.
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
            bufferSize: 20,
            onChunkLoaded: null,
            onAllLoaded: null,
            ...options,
        };

        this.#topSpacer = document.createElement('div');
        this.#topSpacer.classList.add(
            'virtual-character-list-spacer',
            'virtual-character-list-top-spacer',
        );
        this.#topSpacer.setAttribute('aria-hidden', 'true');

        this.#bottomSpacer = document.createElement('div');
        this.#bottomSpacer.classList.add(
            'virtual-character-list-spacer',
            'virtual-character-list-bottom-spacer',
        );
        this.#bottomSpacer.setAttribute('aria-hidden', 'true');

        this.#sentinel = document.createElement('div');
        this.#sentinel.classList.add('virtual-character-list-sentinel');
        this.#sentinel.setAttribute('aria-hidden', 'true');

        this.#container.addEventListener('scroll', this.#onScroll, {
            passive: true,
        });
        this.#setupSentinelObserver();
    }

    /**
	 * Set or replace entity list and render from top.
	 * @param {object[]} entities Entity list.
	 */
    setEntities(entities) {
        this.#entities = Array.isArray(entities) ? entities : [];
        this.#loadedUntil = Math.min(
            this.#entities.length - 1,
            this.#options.chunkSize - 1,
        );
        this.#firstRenderedIndex = -1;
        this.#lastRenderedIndex = -1;
        this.#heights.clear();
        this.#releaseAllRendered();
        this.#container.textContent = '';
        this.#container.append(this.#topSpacer, this.#bottomSpacer, this.#sentinel);
        this.#container.scrollTop = 0;
        this.#updateVisibleRange(true);
        this.#observeSentinel();
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
        this.#sentinelObserver?.disconnect();
        this.#sentinelObserver = null;
        this.#releaseAllRendered();
        this.#pool.length = 0;
        this.#heights.clear();
        this.#entities = [];
        this.#container.textContent = '';
    }

    /**
	 * Scroll to entity by index.
	 * @param {number} index Entity index.
	 */
    scrollToEntity(index) {
        if (!this.#entities.length) {
            return;
        }

        const clampedIndex = this.#clampIndex(index);
        this.#ensureLoaded(clampedIndex);
        this.#container.scrollTop = this.#getEstimatedOffset(clampedIndex);
        this.#updateVisibleRange(true);
    }

    /**
	 * Get first visible entity index.
	 * @returns {number}
	 */
    getFirstVisibleIndex() {
        return this.#clampIndex(
            Math.floor(this.#container.scrollTop / this.#averageItemHeight),
        );
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

        this.#ensureLoaded(
            Math.ceil(value / this.#averageItemHeight) + this.#getVisibleCount(),
        );
        this.#container.scrollTop = Math.max(0, value);
        this.#updateVisibleRange(true);
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
        const clampedIndex = Number(index);
        if (!Number.isInteger(clampedIndex) || !this.#rendered.has(clampedIndex)) {
            return;
        }

        const oldNode = this.#rendered.get(clampedIndex);
        const newNode = this.#renderEntity(clampedIndex);
        oldNode.replaceWith(newNode);
        this.#rendered.set(clampedIndex, newNode);
        this.#scheduleMeasurement();
    }

    /**
	 * Apply selection CSS state to visible character nodes.
	 * @param {Set<number>|number[]} selectedIds Selected data-chid values.
	 * @param {string} className Class to apply/remove.
	 */
    applySelectionState(selectedIds, className) {
        const selectedSet =
			selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
        const visibleItems = this.#container.querySelectorAll('[data-chid]');

        for (const item of visibleItems) {
            const chid = Number(item.getAttribute('data-chid'));
            item.classList.toggle(className, selectedSet.has(chid));
            const checkbox = item.querySelector('.bulk_select_checkbox');
            if (checkbox instanceof HTMLInputElement) {
                checkbox.checked = selectedSet.has(chid);
            }
        }
    }

    #setupSentinelObserver() {
        if (typeof IntersectionObserver !== 'function') {
            return;
        }

        this.#sentinelObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    this.#loadNextChunk();
                }
            },
            {
                root: this.#container,
                rootMargin: '200px',
            },
        );
    }

    #observeSentinel() {
        this.#sentinelObserver?.disconnect();
        this.#sentinelObserver?.observe(this.#sentinel);
    }

    #onScroll = () => {
        if (this.#scrollRafPending) {
            return;
        }

        this.#scrollRafPending = true;
        requestAnimationFrame(() => {
            this.#updateVisibleRange();
            this.#scrollRafPending = false;
        });
    };

    #loadNextChunk() {
        if (
            !this.#entities.length ||
			this.#loadedUntil >= this.#entities.length - 1
        ) {
            this.#options.onAllLoaded?.();
            return;
        }

        this.#loadedUntil = Math.min(
            this.#entities.length - 1,
            this.#loadedUntil + this.#options.chunkSize,
        );
        this.#updateVisibleRange(true);
        this.#options.onChunkLoaded?.();

        if (this.#loadedUntil >= this.#entities.length - 1) {
            this.#options.onAllLoaded?.();
        }
    }

    #ensureLoaded(index) {
        if (!this.#entities.length) {
            return;
        }

        this.#loadedUntil = Math.max(
            this.#loadedUntil,
            Math.min(this.#entities.length - 1, index),
        );
    }

    #updateVisibleRange(force = false) {
        if (!this.#entities.length) {
            this.#topSpacer.style.height = '0px';
            this.#bottomSpacer.style.height = '0px';
            this.#releaseAllRendered();
            return;
        }

        const visibleCount = this.#getVisibleCount();
        const firstVisible = this.#clampIndex(
            Math.floor(this.#container.scrollTop / this.#averageItemHeight),
        );
        this.#ensureLoaded(firstVisible + visibleCount + this.#options.bufferSize);

        const firstIndex = Math.max(0, firstVisible - this.#options.bufferSize);
        const lastIndex = Math.min(
            this.#loadedUntil,
            firstVisible + visibleCount + this.#options.bufferSize,
        );

        if (
            !force &&
			firstIndex === this.#firstRenderedIndex &&
			lastIndex === this.#lastRenderedIndex
        ) {
            return;
        }

        this.#renderRange(firstIndex, lastIndex);
        this.#firstRenderedIndex = firstIndex;
        this.#lastRenderedIndex = lastIndex;
        this.#updateSpacers(firstIndex, lastIndex);
        this.#scheduleMeasurement();
        this.#options.onChunkLoaded?.();
    }

    #scheduleMeasurement() {
        if (this.#measurementRafPending) {
            return;
        }

        this.#measurementRafPending = true;
        requestAnimationFrame(() => {
            this.#measureRenderedItems();
            this.#measurementRafPending = false;
        });
    }

    #renderRange(firstIndex, lastIndex) {
        for (const [index, node] of this.#rendered.entries()) {
            if (index < firstIndex || index > lastIndex) {
                node.remove();
                this.#releaseNode(node);
                this.#rendered.delete(index);
            }
        }

        let insertBefore = this.#bottomSpacer;
        for (let index = lastIndex; index >= firstIndex; index--) {
            let node = this.#rendered.get(index);
            if (!node) {
                node = this.#renderEntity(index);
                this.#rendered.set(index, node);
            }
            if (node.nextSibling !== insertBefore) {
                this.#container.insertBefore(node, insertBefore);
            }
            insertBefore = node;
        }
    }

    #renderEntity(index) {
        const recycledNode = this.#acquireNode();
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

    #releaseAllRendered() {
        for (const node of this.#rendered.values()) {
            node.remove();
            this.#releaseNode(node);
        }
        this.#rendered.clear();
    }

    #releaseNode(node) {
        if (!(node instanceof HTMLElement)) {
            return;
        }

        node.remove();

        // Clear avatar images to free browser image decode resources
        const img = node.querySelector('img');
        if (img instanceof HTMLImageElement) {
            img.src = '';
            img.removeAttribute('srcset');
        }

        if (this.#pool.length < this.#maxPoolSize) {
            this.#pool.push(node);
        }
    }

    #measureRenderedItems() {
        let total = 0;
        let count = 0;

        for (const [index, node] of this.#rendered.entries()) {
            const height = node.getBoundingClientRect().height;
            if (height > 0) {
                this.#heights.set(index, height);
                total += height;
                count++;
            }
        }

        if (count > 0) {
            const newAverage = Math.max(1, total / count);
            const averageChanged =
				Math.abs(newAverage - this.#averageItemHeight) /
					this.#averageItemHeight >
				0.05;

            if (averageChanged) {
                this.#averageItemHeight = newAverage;
                if (this.#firstRenderedIndex >= 0 && this.#lastRenderedIndex >= 0) {
                    this.#updateSpacers(
                        this.#firstRenderedIndex,
                        this.#lastRenderedIndex,
                    );
                }
            }
        }
    }

    #updateSpacers(firstIndex, lastIndex) {
        const savedScrollTop = this.#container.scrollTop;
        const topHeight = this.#getEstimatedHeight(0, firstIndex);
        const bottomHeight = this.#getEstimatedHeight(
            lastIndex + 1,
            this.#entities.length,
        );
        const currentTopHeight = parseFloat(this.#topSpacer.style.height) || 0;
        const currentBottomHeight =
			parseFloat(this.#bottomSpacer.style.height) || 0;

        if (Math.abs(topHeight - currentTopHeight) > 1) {
            this.#topSpacer.style.height = `${topHeight}px`;
        }

        if (Math.abs(bottomHeight - currentBottomHeight) > 1) {
            this.#bottomSpacer.style.height = `${bottomHeight}px`;
        }

        if (this.#container.scrollTop !== savedScrollTop) {
            this.#container.scrollTop = savedScrollTop;
        }
    }

    #getEstimatedHeight(startIndex, endIndex) {
        let height = 0;
        for (let index = startIndex; index < endIndex; index++) {
            height += this.#heights.get(index) || this.#averageItemHeight;
        }
        return Math.max(0, height);
    }

    #getEstimatedOffset(index) {
        return this.#getEstimatedHeight(0, index);
    }

    #getVisibleCount() {
        return Math.max(
            1,
            Math.ceil(this.#container.clientHeight / this.#averageItemHeight),
        );
    }

    #clampIndex(index) {
        if (!this.#entities.length) {
            return 0;
        }
        return Math.max(0, Math.min(this.#entities.length - 1, Number(index) || 0));
    }
}
