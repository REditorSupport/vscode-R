// Both extension hosts and the detached agent embed this resource. Return a fresh
// buffer for each worker because webR can transfer ownership across the channel.
const archive = require('../../dist/resources/webr-viewer-jsonlite.json') as string;
export function viewerJsonlite(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(archive), (character) => character.charCodeAt(0));
}
