/// <reference lib="dom" />

export function plotImageSource(page: Record<string, unknown>): string {
    // The notebook already carries small/portable images. Using them also avoids
    // a second transfer through the remote asset tunnel and its failure modes.
    if (typeof page.imageData === 'string' && page.imageData) {
        return `data:${String(page.mime)};base64,${page.imageData}`;
    }
    if (typeof page.svgData === 'string' && page.svgData) {
        return `data:image/svg+xml;base64,${page.svgData}`;
    }
    return typeof page.url === 'string' ? page.url : '';
}

/** Load one snapshot at a time, coalescing updates without clearing the visible plot. */
export class PlotImage {
    image?: HTMLImageElement;
    private loading?: HTMLImageElement;
    private desired?: { source: string; width: number; height: number; alt: string };
    private shown?: string;
    private disposed = false;

    constructor(
        private element: HTMLElement,
        private status: (error: boolean) => void,
    ) {}

    ready(): boolean {
        return (
            !!this.image?.complete &&
            this.image.naturalWidth > 0 &&
            (this.shown === this.desired?.source || this.image.src === this.desired?.source)
        );
    }

    update(page: Record<string, unknown>, alt: string): void {
        this.desired = {
            source: plotImageSource(page),
            width: Number(page.width),
            height: Number(page.height),
            alt,
        };
        if (this.shown === this.desired.source && this.image) {
            this.image.alt = alt;
        }
        this.load();
    }

    dispose(): void {
        this.disposed = true;
        if (this.loading) {
            this.loading.onload = null;
            this.loading.onerror = null;
            this.loading.removeAttribute('src');
        }
        this.loading = undefined;
    }

    private load(): void {
        if (this.disposed || this.loading || !this.desired || this.shown === this.desired.source) {
            return;
        }
        const requested = this.desired;
        const image = document.createElement('img');
        image.crossOrigin = 'anonymous';
        image.style.cssText = 'display:block;max-width:100%;height:auto';
        image.alt = requested.alt;
        if (requested.width > 0 && requested.height > 0) {
            image.width = requested.width;
            image.height = requested.height;
        }
        this.loading = image;
        // Reserve space on the first frame; subsequent frames load off screen.
        if (!this.image) {
            this.image = image;
            this.element.append(image);
        }
        const complete = (error: boolean): void => {
            if (this.disposed || this.loading !== image) {
                return;
            }
            this.loading = undefined;
            image.onload = null;
            image.onerror = null;
            if (this.desired?.source !== requested.source) {
                this.load();
                return;
            }
            if (!error) {
                image.width = image.naturalWidth;
                image.height = image.naturalHeight;
                image.alt = this.desired.alt;
                if (this.image !== image) {
                    this.image!.replaceWith(image);
                    this.image = image;
                }
                this.shown = requested.source;
            }
            this.status(error);
        };
        image.onload = () => complete(false);
        image.onerror = () => complete(true);
        image.src = requested.source;
    }
}
