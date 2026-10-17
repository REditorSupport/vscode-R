'use strict';

// The "Follow" toggle shared by the Data Viewer and List Viewer toolbars. It is shown
// only for jdv views that can follow a variable (`tracking` in the descriptor).

import type { JdvTracking } from './jdvAdapter';

/** Update the toggle for a tracking state. Runs in the webview, so it must be self-contained. */
export function updateFollowButton(button: HTMLButtonElement, tracking: JdvTracking): void {
    const lost = tracking.state === 'lost';
    button.disabled = lost;
    button.setAttribute('aria-pressed', String(tracking.state === 'active'));
    if (lost) {
        button.title = tracking.message || `The variable "${tracking.name}" is no longer available.`;
    } else if (tracking.state === 'active') {
        button.title = `Following "${tracking.name}": the view updates when the variable changes. Click to pause.`;
    } else {
        button.title = `Paused. Click to follow "${tracking.name}" again.`;
    }
}

/**
 * Webview script that wires the toggle `buttonId`. `onStart` and `onError` are
 * source snippets that show a status; `onError` can use `message.error`.
 */
export function getFollowScript(
    tracking: JdvTracking, buttonId: string, onStart: string, onError: string,
): string {
    return `
    (() => {
        const followButton = document.getElementById(${JSON.stringify(buttonId)});
        if (!followButton) { return; }
        const updateFollowButton = ${updateFollowButton.toString()};
        let tracking = ${JSON.stringify(tracking).replace(/</g, '\\u003c')};
        updateFollowButton(followButton, tracking);
        followButton.addEventListener('click', () => {
            followButton.disabled = true;
            ${onStart}
            vscode.postMessage({ message: 'viewer/track', documentGeneration, enabled: tracking.state !== 'active' });
        });
        // A rebuilt view replaces this document, so only state changes and failures arrive.
        window.addEventListener('message', event => {
            const message = event.data;
            if (!message || message.documentGeneration !== documentGeneration) { return; }
            if (message.message === 'viewer/tracking') {
                tracking = message.tracking;
                updateFollowButton(followButton, tracking);
            } else if (message.message === 'viewer/trackFailed') {
                updateFollowButton(followButton, tracking);
                ${onError}
            }
        });
    })();`;
}
