// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INCOMING_CHANNELS = new Set([
    'update-status',
    'new-response',
    'update-response',
    'session-initializing',
    'whisper-downloading',
    'navigate-previous-response',
    'navigate-next-response',
    'scroll-response-up',
    'scroll-response-down',
    'clear-sensitive-data',
    'save-session-context',
    'save-conversation-turn',
    'save-screen-analysis',
    'click-through-toggled',
    'reconnect-failed',
]);

const listenerMap = new Map();

function on(channel, callback) {
    if (!ALLOWED_INCOMING_CHANNELS.has(channel)) {
        console.warn(`[preload] Blocked unapproved listener on channel: ${channel}`);
        return;
    }
    if (typeof callback !== 'function') {
        console.warn(`[preload] Callback for channel ${channel} is not a function`);
        return;
    }

    const wrapped = (_event, ...args) => callback(...args);

    if (!listenerMap.has(channel)) {
        listenerMap.set(channel, new Map());
    }
    listenerMap.get(channel).set(callback, wrapped);
    ipcRenderer.on(channel, wrapped);
}

function removeListener(channel, callback) {
    if (!ALLOWED_INCOMING_CHANNELS.has(channel) || typeof callback !== 'function') {
        return;
    }
    const channelMap = listenerMap.get(channel);
    if (channelMap && channelMap.has(callback)) {
        const wrapped = channelMap.get(callback);
        ipcRenderer.removeListener(channel, wrapped);
        channelMap.delete(callback);
    }
}

function removeAllListeners(channel) {
    if (!ALLOWED_INCOMING_CHANNELS.has(channel)) {
        return;
    }
    ipcRenderer.removeAllListeners(channel);
    listenerMap.delete(channel);
}

contextBridge.exposeInMainWorld('electronAPI', {
    // Platform detection
    platform: process.platform,
    isMacOS: process.platform === 'darwin',
    isLinux: process.platform === 'linux',
    isWindows: process.platform === 'win32',

    // Storage API
    storage: {
        getConfig: () => ipcRenderer.invoke('storage:get-config'),
        setConfig: config => ipcRenderer.invoke('storage:set-config', config),
        updateConfig: (key, value) => ipcRenderer.invoke('storage:update-config', key, value),
        getCredentials: () => ipcRenderer.invoke('storage:get-credentials'),
        setCredentials: credentials => ipcRenderer.invoke('storage:set-credentials', credentials),
        getApiKey: () => ipcRenderer.invoke('storage:get-api-key'),
        setApiKey: apiKey => ipcRenderer.invoke('storage:set-api-key', apiKey),
        getGroqApiKey: () => ipcRenderer.invoke('storage:get-groq-api-key'),
        setGroqApiKey: groqApiKey => ipcRenderer.invoke('storage:set-groq-api-key', groqApiKey),
        getPreferences: () => ipcRenderer.invoke('storage:get-preferences'),
        setPreferences: preferences => ipcRenderer.invoke('storage:set-preferences', preferences),
        updatePreference: (key, value) => ipcRenderer.invoke('storage:update-preference', key, value),
        getKeybinds: () => ipcRenderer.invoke('storage:get-keybinds'),
        setKeybinds: keybinds => ipcRenderer.invoke('storage:set-keybinds', keybinds),
        getAllSessions: () => ipcRenderer.invoke('storage:get-all-sessions'),
        getSession: sessionId => ipcRenderer.invoke('storage:get-session', sessionId),
        saveSession: (sessionId, data) => ipcRenderer.invoke('storage:save-session', sessionId, data),
        deleteSession: sessionId => ipcRenderer.invoke('storage:delete-session', sessionId),
        deleteAllSessions: () => ipcRenderer.invoke('storage:delete-all-sessions'),
        clearAll: () => ipcRenderer.invoke('storage:clear-all'),
        getTodayLimits: () => ipcRenderer.invoke('storage:get-today-limits'),
    },

    // Session & AI Control
    initializeGemini: (apiKey, customPrompt, profile, language) =>
        ipcRenderer.invoke('initialize-gemini', apiKey, customPrompt, profile, language),
    initializeLocal: (ollamaHost, ollamaModel, whisperModel, profile, customPrompt) =>
        ipcRenderer.invoke('initialize-local', ollamaHost, ollamaModel, whisperModel, profile, customPrompt),
    initializeCloud: (token, profile, customPrompt) =>
        ipcRenderer.invoke('initialize-cloud', token, profile, customPrompt),
    startMacOSAudio: () => ipcRenderer.invoke('start-macos-audio'),
    stopMacOSAudio: () => ipcRenderer.invoke('stop-macos-audio'),
    sendMicAudioContent: data => ipcRenderer.invoke('send-mic-audio-content', data),
    sendAudioContent: data => ipcRenderer.invoke('send-audio-content', data),
    sendImageContent: data => ipcRenderer.invoke('send-image-content', data),
    sendTextMessage: text => ipcRenderer.invoke('send-text-message', text),
    triggerPendingResponse: () => ipcRenderer.invoke('trigger-pending-response'),
    getCurrentSession: () => ipcRenderer.invoke('get-current-session'),
    startNewSession: () => ipcRenderer.invoke('start-new-session'),
    updateGoogleSearchSetting: enabled => ipcRenderer.invoke('update-google-search-setting', enabled),

    // Window & App Lifecycle
    closeSession: () => ipcRenderer.invoke('close-session'),
    quitApplication: () => ipcRenderer.invoke('quit-application'),
    windowMinimize: () => ipcRenderer.invoke('window-minimize'),
    toggleWindowVisibility: () => ipcRenderer.invoke('toggle-window-visibility'),
    openExternal: url => ipcRenderer.invoke('open-external', url),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // One-way events
    viewChanged: view => ipcRenderer.send('view-changed', view),
    updateKeybinds: keybinds => ipcRenderer.send('update-keybinds', keybinds),
    logMessage: msg => ipcRenderer.send('log-message', msg),

    // Event Subscriptions
    on,
    removeListener,
    removeAllListeners,
});
