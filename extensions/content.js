console.log("🚀 LearnAloud: Extension Loaded");

let sessionActive = false;
let indicator = null;
let currentRoom = null;
let scrollObserver = null;
let lastFocusedId = null;
let autoContinueTimer = null;
const originalInlineStyles = new WeakMap();
let activeHighlightedElement = null;
let dynamicNodeCounter = 0;

const AUTO_CONTINUE_INTERVAL_MS = 12000;
const MAX_CONTEXT_MESSAGE_BYTES = 60000;

async function stopTutor() {
    if (!sessionActive) return;
    console.log("🛑 Stopping session...");

    if (autoContinueTimer) {
        clearTimeout(autoContinueTimer);
        autoContinueTimer = null;
    }
    if (scrollObserver) {
        scrollObserver.disconnect();
        scrollObserver = null;
    }
    clearHighlight();
    if (currentRoom) {
        await currentRoom.disconnect();
        currentRoom = null;
    }
    if (indicator) {
        indicator.remove();
        indicator = null;
    }
    sessionActive = false;
    
    // Show the start button again
    const startBtn = document.getElementById('la-start-btn');
    if (startBtn) startBtn.style.display = 'block';
    lastFocusedId = null;

    console.log("✅ Session ended.");
}

function clearAutoContinueTimer() {
    if (autoContinueTimer) {
        clearTimeout(autoContinueTimer);
        autoContinueTimer = null;
    }
}

async function publishClientAction(room, action, payload = {}) {
    if (!room || !room.localParticipant) return false;

    const message = JSON.stringify({
        type: 'client_action',
        action,
        payload
    });

    try {
        await room.localParticipant.publishData(new TextEncoder().encode(message), {
            reliable: true,
            topic: 'client_actions'
        });
        return true;
    } catch (error) {
        console.warn(`⚠️ Failed to publish client action "${action}"`, error);
        return false;
    }
}

function normalizeActionName(action) {
    return String(action || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
}

function normalizeLookupText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function ensureDataNodeId(element) {
    if (!element) return null;

    let id = element.getAttribute('data-la-id');
    if (id) return id;

    const domId = (element.getAttribute('id') || '').trim();
    if (domId) {
        id = domId.startsWith('la-node-') ? domId : `dom-${domId}`;
    } else {
        dynamicNodeCounter += 1;
        id = `la-node-dyn-${dynamicNodeCounter}`;
    }

    element.setAttribute('data-la-id', id);
    return id;
}

function findElementByLabel(label) {
    const target = normalizeLookupText(label);
    if (!target) return null;

    const candidates = Array.from(document.querySelectorAll('[data-la-id], h1, h2, h3, h4, h5, h6'));
    let bestElement = null;
    let bestScore = 0;

    for (const element of candidates) {
        const candidateText = normalizeLookupText((element.textContent || '').slice(0, 250));
        if (!candidateText) continue;

        let score = 0;
        if (candidateText === target) score = 5;
        else if (candidateText.startsWith(target)) score = 4;
        else if (candidateText.includes(target)) score = 3;
        else if (target.includes(candidateText) && candidateText.length > 10) score = 2;

        if (/^H[1-6]$/.test(element.tagName)) score += 1;

        if (score > bestScore) {
            bestScore = score;
            bestElement = element;
        }
    }

    return bestElement;
}

function resolveActionPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.payload && typeof payload.payload === 'object') return payload.payload;
    return payload;
}

function resolveElementFromPayload(payload) {
    const resolvedPayload = resolveActionPayload(payload);
    const candidateId = typeof resolvedPayload === 'string'
        ? resolvedPayload
        : (
            resolvedPayload?.id ||
            resolvedPayload?.node_id ||
            resolvedPayload?.target_id ||
            resolvedPayload?.element_id ||
            resolvedPayload?.elementId ||
            null
        );

    let id = candidateId ? String(candidateId).trim() : null;
    if (id && id.startsWith('#')) id = id.slice(1);

    let element = null;
    if (id) {
        element = document.querySelector(`[data-la-id="${id}"]`) || document.getElementById(id);
    }

    if (!element && Number.isInteger(resolvedPayload?.index)) {
        const fallbackId = `la-node-${resolvedPayload.index}`;
        id = fallbackId;
        element = document.querySelector(`[data-la-id="${fallbackId}"]`);
    }

    if (!element) {
        const labelCandidate = (
            resolvedPayload?.section ||
            resolvedPayload?.title ||
            resolvedPayload?.heading ||
            resolvedPayload?.label ||
            resolvedPayload?.query ||
            (typeof resolvedPayload === 'string' ? resolvedPayload : null) ||
            (id && !id.startsWith('la-node-') ? id : null)
        );

        if (labelCandidate) {
            element = findElementByLabel(labelCandidate);
            if (element) {
                id = ensureDataNodeId(element);
            }
        }
    }

    if (element && !id) {
        id = ensureDataNodeId(element);
    }

    return { id, element };
}

function clearHighlight() {
    if (!activeHighlightedElement) return;

    const original = originalInlineStyles.get(activeHighlightedElement);
    if (original) {
        activeHighlightedElement.style.setProperty('background-color', original.backgroundColor || '');
        activeHighlightedElement.style.setProperty('outline', original.outline || '');
        activeHighlightedElement.style.setProperty('border-radius', original.borderRadius || '');
        activeHighlightedElement.style.setProperty('transition', original.transition || '');
        originalInlineStyles.delete(activeHighlightedElement);
    }

    activeHighlightedElement = null;
}

function applyHighlight(element) {
    if (!element) return;

    if (activeHighlightedElement && activeHighlightedElement !== element) {
        clearHighlight();
    }

    if (!originalInlineStyles.has(element)) {
        originalInlineStyles.set(element, {
            backgroundColor: element.style.getPropertyValue('background-color'),
            outline: element.style.getPropertyValue('outline'),
            borderRadius: element.style.getPropertyValue('border-radius'),
            transition: element.style.getPropertyValue('transition')
        });
    }

    element.style.setProperty('background-color', '#fef08a', 'important');
    element.style.setProperty('outline', '3px solid #facc15', 'important');
    element.style.setProperty('border-radius', '4px', 'important');
    element.style.setProperty('transition', 'background-color 220ms ease, outline-color 220ms ease', 'important');
    activeHighlightedElement = element;
}

function getVisibleNodeId() {
    const nodes = Array.from(document.querySelectorAll('[data-la-id]'));
    const viewportCenter = window.innerHeight / 2;

    for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.top <= viewportCenter && rect.bottom >= viewportCenter) {
            return node.getAttribute('data-la-id');
        }
    }

    return nodes[0]?.getAttribute('data-la-id') || null;
}

function armAutoContinue(room, fallbackId) {
    clearAutoContinueTimer();
    if (!sessionActive) return;

    autoContinueTimer = setTimeout(async () => {
        if (!sessionActive || currentRoom !== room) return;

        const id = lastFocusedId || getVisibleNodeId() || fallbackId;
        if (!id) return;

        console.log(`⏩ Auto-continue ping for ${id}`);
        await publishClientAction(room, 'user_scroll', { id, source: 'auto_continue' });
        armAutoContinue(room, fallbackId);
    }, AUTO_CONTINUE_INTERVAL_MS);
}

function buildContextPayload(pageMap, maxBytes = MAX_CONTEXT_MESSAGE_BYTES) {
    const isHeading = (segment) => segment.tag === 'h1' || segment.tag === 'h2' || segment.tag === 'h3';
    const toWireSegments = (segments) => segments.map(({ id, text }) => ({ id, text }));

    const createPayload = (segments, truncated) => {
        const sectionIndex = segments
            .filter(isHeading)
            .map(({ id, text }) => ({ id, title: text }));

        return {
            segments: toWireSegments(segments),
            section_index: sectionIndex,
            truncated
        };
    };

    const createMessage = (payload) => JSON.stringify({
        type: 'client_action',
        action: 'update_context',
        payload
    });

    const allSegments = [...pageMap];
    if (createMessage(createPayload(allSegments, false)).length <= maxBytes) {
        return createPayload(allSegments, false);
    }

    const selected = [];
    const selectedIds = new Set();

    const tryAdd = (segment) => {
        if (!segment || selectedIds.has(segment.id)) return;
        selected.push(segment);
        selectedIds.add(segment.id);
        if (createMessage(createPayload(selected, true)).length > maxBytes) {
            selected.pop();
            selectedIds.delete(segment.id);
        }
    };

    for (const segment of allSegments.filter(isHeading)) {
        tryAdd(segment);
    }

    const remaining = allSegments.filter((segment) => !selectedIds.has(segment.id));
    for (const segment of remaining) {
        tryAdd(segment);
    }

    if (selected.length === 0 && allSegments.length > 0) {
        selected.push(allSegments[0]);
    }

    return createPayload(selected, selected.length < allSegments.length);
}

window.startTutor = startTutor;
async function startTutor() {
    if (sessionActive) return;
    console.log("⏳ Starting session...");

    try {
        // 0. Ensure LiveKit is available
        let LK = window.LiveKitClient || window.LivekitClient;
        
        if (!LK) {
            console.log("fetching sdk from relay...");
            const script = document.createElement('script');
            script.src = "http://localhost:3000/livekit.js";
            document.head.appendChild(script);
            
            // Wait for it to load
            await new Promise((resolve, reject) => {
                script.onload = () => {
                    LK = window.LiveKitClient || window.LivekitClient;
                    resolve();
                };
                script.onerror = reject;
                setTimeout(() => reject(new Error("Timeout loading SDK")), 5000);
            });
        }

        if (!LK) {
            throw new Error("LiveKit library not found even after fallback.");
        }

        const { Room, RoomEvent } = LK;
        const room = new Room();
        currentRoom = room;

        // 0. Handle Disconnection
        room.on(RoomEvent.Disconnected, () => {
            console.log("🔌 Room disconnected.");
            stopTutor();
        });

        // 1. Attach Audio
        room.on(RoomEvent.TrackSubscribed, (track) => {
            if (track.kind === "audio") {
                const el = track.attach();
                el.id = 'la-audio-track';
                document.body.appendChild(el);
                console.log("🔊 Audio attached.");
            }
        });

        // 2. Handle Agent Actions
        room.on(RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
            if (topic && topic !== 'client_actions') return;

            try {
                const str = new TextDecoder().decode(payload);
                const data = JSON.parse(str);
                console.log("📩 Received from agent:", data);
                armAutoContinue(room, lastFocusedId || getVisibleNodeId() || null);

                const action = data?.action || data?.client_action || data?.name;
                const normalizedAction = normalizeActionName(action);

                if (data.type === 'client_action' || data.type === 'agent_action' || normalizedAction) {
                    // Built-in heartbeat: verify data channel connectivity
                    if (normalizedAction === 'heartbeat') {
                        console.log('💓 Connection verified! Agent:', data.payload.agent_identity);
                        // Send ack for round-trip latency measurement
                        await publishClientAction(room, 'heartbeat_ack', { timestamp: data.payload.timestamp });
                        return;
                    }

                    // Handle other agent actions
                    await handleAgentAction(action, data.payload || data, room);
                }
            } catch (e) {
                console.error("Error parsing agent message:", e);
            }
        });

        // 3. Map Page
        const pageMap = [];
        const candidateElements = Array.from(document.querySelectorAll('p, h1, h2, h3, li'));
        candidateElements.forEach((el) => {
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!text) return;

            const id = `la-node-${pageMap.length}`;
            el.setAttribute('data-la-id', id);
            pageMap.push({
                id,
                text,
                tag: el.tagName.toLowerCase()
            });
        });

        // 4. Connect via Relay
        const res = await fetch("http://localhost:3000/token", { method: 'POST' });
        const { livekit_url, token } = await res.json();

        await room.connect(livekit_url, token);
        await room.localParticipant.setMicrophoneEnabled(true);

        // 4.5 Set up Scroll Tracking (after connect)
        setupScrollTracking(room);

        // 5. Sync Context as a single message (trimmed only if too large)
        const contextPayload = buildContextPayload(pageMap);
        console.log(`📤 Sending context (${contextPayload.segments.length} segments${contextPayload.truncated ? ', truncated' : ''})`);
        await publishClientAction(room, 'update_context', contextPayload);

        // Kickstart the tutoring loop at the current viewport section
        const initialId = getVisibleNodeId() || pageMap[0]?.id || null;
        if (initialId) {
            lastFocusedId = initialId;
            await publishClientAction(room, 'user_scroll', { id: initialId, source: 'session_start' });
        }

        sessionActive = true;
        createIndicator();
        armAutoContinue(room, initialId);
        console.log("%c 🎙️ LearnAloud ACTIVE ", "background: #4f46e5; color: white; padding: 5px; border-radius: 4px;");

    } catch (error) {
        console.error("❌ LearnAloud Error:", error);
        sessionActive = false;
        clearAutoContinueTimer();
        clearHighlight();
        const startBtn = document.getElementById('la-start-btn');
        if (startBtn) startBtn.style.display = 'block';
    }
}

function createIndicator() {
    indicator = document.createElement('div');
    indicator.id = 'la-indicator';
    indicator.innerHTML = `
        <div style="position: fixed; bottom: 20px; right: 20px; z-index: 9999; 
                    background: #4f46e5; color: white; padding: 10px 20px; 
                    border-radius: 50px; font-family: sans-serif; font-weight: bold;
                    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); display: flex; 
                    align-items: center; gap: 10px; cursor: pointer; user-select: none;"
             title="Click to stop session">
            <div style="width: 10px; height: 10px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite;"></div>
            LearnAloud Active (Click to Stop)
        </div>
        <style>
            @keyframes pulse {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
            }
        </style>
    `;
    indicator.onclick = stopTutor;
    document.body.appendChild(indicator);
}

async function handleAgentAction(action, payload, room = currentRoom) {
    const normalizedAction = normalizeActionName(action);
    if (!normalizedAction) return;

    const { id, element } = resolveElementFromPayload(payload);
    console.log(`🚀 Executing action: ${action} on ID: ${id}`, payload);

    if (!element) {
        console.warn(`❌ Element with ID ${id} not found in the DOM.`);
        return;
    }

    lastFocusedId = id || element.getAttribute('data-la-id') || null;

    switch (normalizedAction) {
        case 'scroll_to':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        case 'scrollto':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        case 'highlight':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            applyHighlight(element);
            break;
        case 'hilight':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            applyHighlight(element);
            break;
        default:
            console.log("Unknown action:", action);
            return;
    }

    const focusedId = id || element.getAttribute('data-la-id');
    if (focusedId) {
        await publishClientAction(room, 'user_scroll', { id: focusedId, source: 'agent_action' });
        armAutoContinue(room, focusedId);
    }
}

function setupScrollTracking(room) {
    if (scrollObserver) {
        scrollObserver.disconnect();
    }
    let lastId = null;
    scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('data-la-id');
                if (id !== lastId) {
                    lastId = id;
                    lastFocusedId = id;
                    publishClientAction(room, 'user_scroll', {
                        id,
                        source: 'observer'
                    });
                    armAutoContinue(room, id);
                }
            }
        });
    }, { threshold: 0.5 });

    document.querySelectorAll('[data-la-id]').forEach(el => scrollObserver.observe(el));
}

// Global Listener
window.addEventListener('keydown', (e) => {
    console.log("⌨️ Key pressed:", e.code, "Ctrl:", e.ctrlKey, "Shift:", e.shiftKey);
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyS' || e.key === 'S')) {
        console.log("🎯 Hotkey detected!");
        startTutor();
    }
}, true);

// Add a floating button for easy start
function addStartButton() {
    // Prevent duplicates
    if (document.getElementById('la-start-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'la-start-btn';
    btn.innerText = '🎙️ Start Tutor';
    Object.assign(btn.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: '99999',
        padding: '10px 15px',
        background: '#4f46e5',
        color: 'white',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        fontWeight: 'bold',
        boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
    });
    btn.onclick = () => {
        btn.style.display = 'none';
        startTutor();
    };
    document.body.appendChild(btn);
}

// Delay slightly to ensure body exists
setTimeout(addStartButton, 1000);
