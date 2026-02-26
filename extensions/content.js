console.log("🚀 LearnAloud: Extension Loaded");

let sessionActive = false;
let sessionPaused = false;
let sessionConnecting = false;
let indicator = null;
let indicatorStatusEl = null;
let indicatorDotEl = null;
let pauseResumeBtn = null;
let currentRoom = null;
let scrollObserver = null;
let lastFocusedId = null;
let autoContinueTimer = null;
let pageStructure = null;
let lastFocusSyncId = null;
let lastFocusSyncAt = 0;
let primaryAudioEl = null;
const remoteAudioElsBySid = new Map();
let lastAgentActionAt = 0;
let lastHandledActionKey = null;
let lastHandledActionAt = 0;
const originalInlineStyles = new WeakMap();
let activeHighlightedElement = null;
let dynamicNodeCounter = 0;

const AUTO_CONTINUE_INTERVAL_MS = 18000;
const MAX_CONTEXT_MESSAGE_BYTES = 60000;
const ENABLE_FOCUS_SYNC = false;

async function stopTutor() {
    if (!sessionActive && !sessionConnecting) return;
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
        try {
            await currentRoom.disconnect();
        } catch (error) {
            console.warn("⚠️ Error while disconnecting room:", error);
        }
        currentRoom = null;
    }
    document.querySelectorAll('.la-audio-track').forEach((el) => el.remove());
    remoteAudioElsBySid.clear();
    if (indicator) {
        indicator.remove();
        indicator = null;
    }
    primaryAudioEl = null;
    indicatorStatusEl = null;
    indicatorDotEl = null;
    pauseResumeBtn = null;
    sessionActive = false;
    sessionPaused = false;
    sessionConnecting = false;
    
    // Show the start button again
    const startBtn = document.getElementById('la-start-btn');
    if (startBtn) startBtn.style.display = 'block';
    lastFocusedId = null;
    pageStructure = null;
    lastFocusSyncId = null;
    lastFocusSyncAt = 0;
    lastAgentActionAt = 0;
    lastHandledActionKey = null;
    lastHandledActionAt = 0;

    console.log("✅ Session ended.");
}

function clearAutoContinueTimer() {
    if (autoContinueTimer) {
        clearTimeout(autoContinueTimer);
        autoContinueTimer = null;
    }
}

function setTutorAudioPaused(paused) {
    document.querySelectorAll('.la-audio-track').forEach((el) => {
        el.muted = paused;
        if (paused) {
            el.pause?.();
            return;
        }

        const playPromise = el.play?.();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
        }
    });
}

function updateIndicatorControls() {
    if (!indicator) return;

    if (indicatorStatusEl) {
        indicatorStatusEl.textContent = sessionPaused ? 'LearnAloud Paused' : 'LearnAloud Active';
    }

    if (indicatorDotEl) {
        indicatorDotEl.style.background = sessionPaused ? '#f59e0b' : '#22c55e';
        indicatorDotEl.style.animation = sessionPaused ? 'none' : 'la-pulse 2s infinite';
    }

    if (pauseResumeBtn) {
        pauseResumeBtn.textContent = sessionPaused ? 'Resume' : 'Pause';
    }
}

async function pauseTutor() {
    if (!sessionActive || sessionPaused) return;

    sessionPaused = true;
    clearAutoContinueTimer();
    setTutorAudioPaused(true);
    if (currentRoom?.localParticipant) {
        try {
            await currentRoom.localParticipant.setMicrophoneEnabled(false);
        } catch (error) {
            console.warn("⚠️ Could not disable microphone while pausing:", error);
        }
    }

    await publishClientAction(currentRoom, 'session_paused', {
        focus_id: lastFocusedId || null
    });
    updateIndicatorControls();
    console.log("⏸️ Session paused.");
}

async function resumeTutor() {
    if (!sessionActive || !sessionPaused) return;

    sessionPaused = false;
    setTutorAudioPaused(false);
    if (currentRoom?.localParticipant) {
        try {
            await currentRoom.localParticipant.setMicrophoneEnabled(true);
        } catch (error) {
            console.warn("⚠️ Could not enable microphone while resuming:", error);
        }
    }

    const focusId = lastFocusedId || getVisibleNodeId() || null;
    if (focusId) {
        await publishClientAction(currentRoom, 'user_scroll', { id: focusId, source: 'resume' });
        await syncFocusContext(currentRoom, focusId, 'resume');
    }
    await publishClientAction(currentRoom, 'session_resumed', {
        focus_id: focusId
    });
    armAutoContinue(currentRoom, focusId);
    updateIndicatorControls();
    console.log("▶️ Session resumed.");
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

function isLikelyNodeId(value) {
    const id = String(value || '').trim();
    if (!id) return false;
    return /^la-node-\d+$/.test(id) || /^la-node-dyn-\d+$/.test(id) || /^dom-[A-Za-z0-9:_-]+$/.test(id);
}

function cleanSegmentText(value) {
    return String(value || '')
        .replace(/\[edit\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseHeadingLevel(tagName) {
    if (!tagName) return null;
    const match = String(tagName).toLowerCase().match(/^h([1-6])$/);
    return match ? Number(match[1]) : null;
}

function isHeadingTag(tagName) {
    return parseHeadingLevel(tagName) !== null;
}

function scoreTextMatch(candidateText, targetText) {
    const candidate = normalizeLookupText(candidateText);
    const target = normalizeLookupText(targetText);
    if (!candidate || !target) return 0;

    if (candidate === target) return 120;
    if (candidate.startsWith(target)) return 95;
    if (target.startsWith(candidate)) return 85;
    if (candidate.includes(target)) return 75;
    if (target.includes(candidate)) return 60;

    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    const targetTokens = target.split(' ').filter(Boolean);
    if (!candidateTokens.size || !targetTokens.length) return 0;

    let overlap = 0;
    for (const token of targetTokens) {
        if (candidateTokens.has(token)) overlap += 1;
    }

    return Math.floor((overlap / targetTokens.length) * 50);
}

function findBestSectionByQuery(query) {
    if (!pageStructure) return null;

    const normalizedQuery = normalizeLookupText(query);
    if (!normalizedQuery) return null;

    const directSection = pageStructure.sectionById.get(normalizedQuery) || pageStructure.sectionById.get(query);
    if (directSection) return directSection;

    let bestSection = null;
    let bestScore = 0;
    for (const section of pageStructure.sections) {
        let score = scoreTextMatch(section.title, normalizedQuery);

        if (section.path && section.path.length) {
            score = Math.max(score, scoreTextMatch(section.path.join(' > '), normalizedQuery) - 5);
        }

        if (score > bestScore) {
            bestScore = score;
            bestSection = section;
        }
    }

    return bestScore >= 40 ? bestSection : null;
}

function buildPageStructure() {
    const segments = [];
    const sections = [];
    const segmentById = new Map();
    const sectionById = new Map();

    const root = {
        id: 'root',
        title: 'Document',
        level: 0,
        parent_id: null,
        children: [],
        segment_ids: [],
        path: ['Document']
    };
    sectionById.set(root.id, root);

    const sectionStack = [root];
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'));

    for (const element of candidates) {
        const tag = element.tagName.toLowerCase();
        const text = cleanSegmentText(element.innerText || element.textContent || '');
        if (!text) continue;

        const id = `la-node-${segments.length}`;
        element.setAttribute('data-la-id', id);

        const segment = { id, text, tag };
        segments.push(segment);
        segmentById.set(id, segment);

        const headingLevel = parseHeadingLevel(tag);
        if (headingLevel !== null) {
            while (sectionStack.length > 1 && sectionStack[sectionStack.length - 1].level >= headingLevel) {
                sectionStack.pop();
            }

            const parent = sectionStack[sectionStack.length - 1] || root;
            const section = {
                id,
                title: text,
                level: headingLevel,
                parent_id: parent.id,
                children: [],
                segment_ids: [id],
                path: [...(parent.path || ['Document']), text]
            };

            parent.children.push(id);
            sections.push(section);
            sectionById.set(id, section);
            segment.section_id = id;
            sectionStack.push(section);
            continue;
        }

        const currentSection = sectionStack[sectionStack.length - 1] || root;
        segment.section_id = currentSection.id;
        currentSection.segment_ids.push(id);
        root.segment_ids.push(id);
    }

    return {
        segments,
        sections,
        segmentById,
        sectionById,
        root
    };
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
    const matchedSection = findBestSectionByQuery(label);
    if (matchedSection?.id) {
        const sectionElement = document.querySelector(`[data-la-id="${matchedSection.id}"]`);
        if (sectionElement) return sectionElement;
    }

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

function resolveElementFromPayload(payload, options = {}) {
    const { allowLabelFallback = true } = options;
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

    if (!element && allowLabelFallback) {
        const sectionQuery = (
            resolvedPayload?.section ||
            resolvedPayload?.title ||
            resolvedPayload?.heading ||
            resolvedPayload?.topic ||
            resolvedPayload?.query ||
            null
        );
        if (sectionQuery) {
            const matchedSection = findBestSectionByQuery(sectionQuery);
            if (matchedSection) {
                id = matchedSection.id;
                element = document.querySelector(`[data-la-id="${id}"]`);
            }
        }
    }

    if (!element && Number.isInteger(resolvedPayload?.index)) {
        const fallbackId = `la-node-${resolvedPayload.index}`;
        id = fallbackId;
        element = document.querySelector(`[data-la-id="${fallbackId}"]`);
    }

    if (!element && allowLabelFallback) {
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

function isNavigationAction(action) {
    return [
        'navigate_to_section',
        'jump_to_section',
        'goto_section',
        'go_to_section',
        'navigate',
        'jump_to'
    ].includes(action);
}

function resolveNavigationQuery(payload) {
    const resolved = resolveActionPayload(payload);
    if (typeof resolved === 'string') return resolved;

    return (
        resolved?.section ||
        resolved?.title ||
        resolved?.heading ||
        resolved?.topic ||
        resolved?.query ||
        resolved?.id ||
        null
    );
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

function getFocusContextPayload(focusedId, source = 'agent_action') {
    if (!pageStructure || !focusedId) return null;

    const focusedSegment = pageStructure.segmentById.get(focusedId);
    if (!focusedSegment) return null;

    const idx = pageStructure.segments.findIndex((segment) => segment.id === focusedId);
    if (idx < 0) return null;

    const start = Math.max(0, idx - 1);
    const end = Math.min(pageStructure.segments.length, idx + 2);
    const windowSegments = pageStructure.segments.slice(start, end).map(({ id, text }) => ({ id, text }));
    const section = pageStructure.sectionById.get(focusedSegment.section_id);

    return {
        segments: windowSegments,
        focus_id: focusedId,
        focus_text: focusedSegment.text,
        focus_tag: focusedSegment.tag,
        focus_section: section ? {
            id: section.id,
            title: section.title,
            level: section.level
        } : null,
        mode: 'focus_sync',
        source
    };
}

async function syncFocusContext(room, focusedId, source = 'agent_action') {
    if (!room || !focusedId) return;

    const now = Date.now();
    if (focusedId === lastFocusSyncId && now - lastFocusSyncAt < 5000) {
        return;
    }

    const payload = getFocusContextPayload(focusedId, source);
    if (!payload) return;

    const ok = await publishClientAction(room, 'update_context', payload);
    if (ok) {
        lastFocusSyncId = focusedId;
        lastFocusSyncAt = now;
    }
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
    if (!sessionActive || sessionPaused) return;

    autoContinueTimer = setTimeout(async () => {
        if (!sessionActive || sessionPaused || currentRoom !== room) return;

        const idleForMs = Date.now() - lastAgentActionAt;
        if (lastAgentActionAt && idleForMs < AUTO_CONTINUE_INTERVAL_MS + 7000) {
            armAutoContinue(room, fallbackId);
            return;
        }

        const id = lastFocusedId || getVisibleNodeId() || fallbackId;
        if (!id) return;

        console.log(`⏩ Auto-continue ping for ${id}`);
        await publishClientAction(room, 'user_scroll', { id, source: 'auto_continue' });
        armAutoContinue(room, fallbackId);
    }, AUTO_CONTINUE_INTERVAL_MS);
}

function buildContextPayload(structure, maxBytes = MAX_CONTEXT_MESSAGE_BYTES) {
    const isHeading = (segment) => isHeadingTag(segment.tag);
    const toWireSegments = (segments) => segments.map(({ id, text }) => ({ id, text }));
    const toSectionIndex = (sections) => sections.map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
        parent_id: section.parent_id,
        children: section.children
    }));

    const sectionIndex = toSectionIndex(structure.sections);

    const createPayload = (segments, truncated) => ({
        segments: toWireSegments(segments),
        section_index: sectionIndex,
        truncated
    });

    const createMessage = (payload) => JSON.stringify({
        type: 'client_action',
        action: 'update_context',
        payload
    });

    const allSegments = [...structure.segments];
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
    if (sessionActive || sessionConnecting) return;
    console.log("⏳ Starting session...");
    sessionPaused = false;
    sessionConnecting = true;

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
        room.on(RoomEvent.TrackSubscribed, (track, publication) => {
            if (track.kind === "audio") {
                const sid = publication?.trackSid || track.sid || `track-${Date.now()}`;
                if (remoteAudioElsBySid.has(sid)) {
                    return;
                }
                const el = track.attach();
                el.classList.add('la-audio-track');
                el.dataset.trackSid = sid;
                el.autoplay = true;
                el.playsInline = true;
                el.volume = 1;
                if (sessionPaused) {
                    el.muted = true;
                    el.pause?.();
                } else {
                    el.muted = false;
                    const playPromise = el.play?.();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch((error) => {
                            console.warn("⚠️ Audio play blocked by browser policy:", error?.message || error);
                        });
                    }
                }
                document.body.appendChild(el);
                primaryAudioEl = el;
                remoteAudioElsBySid.set(sid, el);
                console.log("🔊 Audio attached.", {
                    sid,
                    muted: el.muted,
                    paused: el.paused,
                    volume: el.volume,
                    readyState: el.readyState
                });
            }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
            if (track.kind !== "audio") return;
            const sid = publication?.trackSid || track.sid;
            if (!sid) return;

            const element = remoteAudioElsBySid.get(sid) || document.querySelector(`.la-audio-track[data-track-sid="${sid}"]`);
            if (element) {
                element.remove();
            }
            remoteAudioElsBySid.delete(sid);
            if (primaryAudioEl && primaryAudioEl.dataset.trackSid === sid) {
                primaryAudioEl = remoteAudioElsBySid.values().next().value || null;
            }
        });

        // 2. Handle Agent Actions
        room.on(RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
            if (topic && topic !== 'client_actions') return;

            try {
                const str = new TextDecoder().decode(payload);
                const data = JSON.parse(str);
                console.log("📩 Received from agent:", data);
                if (!sessionPaused) {
                    armAutoContinue(room, lastFocusedId || getVisibleNodeId() || null);
                }

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

                    if (sessionPaused) {
                        console.log(`⏸️ Ignoring agent action while paused: ${action}`);
                        return;
                    }

                    lastAgentActionAt = Date.now();
                    // Handle other agent actions
                    await handleAgentAction(action, data.payload || data, room);
                }
            } catch (e) {
                console.error("Error parsing agent message:", e);
            }
        });

        // 3. Build page structure (segments + heading tree)
        pageStructure = buildPageStructure();
        const pageMap = pageStructure.segments;

        // 4. Connect via Relay
        const res = await fetch("http://localhost:3000/token", { method: 'POST' });
        const { livekit_url, token } = await res.json();

        await room.connect(livekit_url, token);
        if (typeof room.startAudio === 'function') {
            try {
                await room.startAudio();
            } catch (error) {
                console.warn("⚠️ LiveKit startAudio warning:", error?.message || error);
            }
        }
        await room.localParticipant.setMicrophoneEnabled(true);

        // 4.5 Set up Scroll Tracking (after connect)
        setupScrollTracking(room);

        // 5. Sync Context as a single message (trimmed only if too large)
        const contextPayload = buildContextPayload(pageStructure);
        console.log(`📤 Sending context (${contextPayload.segments.length} segments${contextPayload.truncated ? ', truncated' : ''})`);
        await publishClientAction(room, 'update_context', contextPayload);

        // Kickstart the tutoring loop at the current viewport section
        const initialId = getVisibleNodeId() || pageMap[0]?.id || null;
        if (initialId) {
            lastFocusedId = initialId;
            await publishClientAction(room, 'user_scroll', { id: initialId, source: 'session_start' });
        }

        sessionActive = true;
        sessionConnecting = false;
        createIndicator();
        armAutoContinue(room, initialId);
        console.log("%c 🎙️ LearnAloud ACTIVE ", "background: #4f46e5; color: white; padding: 5px; border-radius: 4px;");

    } catch (error) {
        console.error("❌ LearnAloud Error:", error);
        sessionActive = false;
        sessionPaused = false;
        sessionConnecting = false;
        pageStructure = null;
        clearAutoContinueTimer();
        clearHighlight();
        const startBtn = document.getElementById('la-start-btn');
        if (startBtn) startBtn.style.display = 'block';
    }
}

function createIndicator() {
    const existingStyle = document.getElementById('la-indicator-style');
    if (!existingStyle) {
        const style = document.createElement('style');
        style.id = 'la-indicator-style';
        style.textContent = `
            @keyframes la-pulse {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
            }
        `;
        document.head.appendChild(style);
    }

    indicator = document.createElement('div');
    indicator.id = 'la-indicator';
    Object.assign(indicator.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '9999',
        background: '#111827',
        color: '#fff',
        padding: '12px',
        borderRadius: '12px',
        fontFamily: 'sans-serif',
        boxShadow: '0 10px 20px rgba(0,0,0,0.25)',
        minWidth: '220px'
    });

    const statusRow = document.createElement('div');
    Object.assign(statusRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '10px',
        fontWeight: '600'
    });

    indicatorDotEl = document.createElement('div');
    Object.assign(indicatorDotEl.style, {
        width: '10px',
        height: '10px',
        borderRadius: '50%',
        background: '#22c55e',
        animation: 'la-pulse 2s infinite'
    });

    indicatorStatusEl = document.createElement('span');
    indicatorStatusEl.textContent = 'LearnAloud Active';

    statusRow.appendChild(indicatorDotEl);
    statusRow.appendChild(indicatorStatusEl);

    const controls = document.createElement('div');
    Object.assign(controls.style, {
        display: 'flex',
        gap: '8px'
    });

    pauseResumeBtn = document.createElement('button');
    pauseResumeBtn.type = 'button';
    pauseResumeBtn.textContent = 'Pause';
    Object.assign(pauseResumeBtn.style, {
        flex: '1',
        border: 'none',
        borderRadius: '8px',
        padding: '8px 10px',
        background: '#f59e0b',
        color: '#111827',
        fontWeight: '700',
        cursor: 'pointer'
    });
    pauseResumeBtn.onclick = () => {
        if (sessionPaused) {
            resumeTutor();
            return;
        }
        pauseTutor();
    };

    const disconnectBtn = document.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.textContent = 'Disconnect';
    Object.assign(disconnectBtn.style, {
        flex: '1',
        border: 'none',
        borderRadius: '8px',
        padding: '8px 10px',
        background: '#ef4444',
        color: '#fff',
        fontWeight: '700',
        cursor: 'pointer'
    });
    disconnectBtn.onclick = stopTutor;

    controls.appendChild(pauseResumeBtn);
    controls.appendChild(disconnectBtn);
    indicator.appendChild(statusRow);
    indicator.appendChild(controls);
    document.body.appendChild(indicator);
    updateIndicatorControls();
}

async function navigateToSection(payload, room = currentRoom) {
    const navigationQuery = resolveNavigationQuery(payload);
    const matchedSection = findBestSectionByQuery(navigationQuery);

    if (!matchedSection) {
        console.warn(`❌ Could not resolve section for navigation query: ${navigationQuery}`);
        await publishClientAction(room, 'navigation_result', {
            status: 'not_found',
            query: navigationQuery || null
        });
        return false;
    }

    const element = document.querySelector(`[data-la-id="${matchedSection.id}"]`);
    if (!element) {
        console.warn(`❌ Matched section ${matchedSection.id} but element was not found in DOM.`);
        await publishClientAction(room, 'navigation_result', {
            status: 'not_found',
            query: navigationQuery || null,
            id: matchedSection.id
        });
        return false;
    }

    const resolvedPayload = resolveActionPayload(payload);
    const shouldHighlight = normalizeActionName(resolvedPayload?.mode || 'highlight') !== 'scroll_only';

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (shouldHighlight) {
        applyHighlight(element);
    }

    lastFocusedId = matchedSection.id;
    lastAgentActionAt = Date.now();
    await publishClientAction(room, 'user_scroll', {
        id: matchedSection.id,
        source: 'navigate_to_section'
    });
    if (ENABLE_FOCUS_SYNC) {
        await syncFocusContext(room, matchedSection.id, 'navigate_to_section');
    }
    await publishClientAction(room, 'navigation_result', {
        status: 'ok',
        query: navigationQuery || null,
        id: matchedSection.id,
        title: matchedSection.title,
        level: matchedSection.level
    });
    armAutoContinue(room, matchedSection.id);
    return true;
}

async function handleAgentAction(action, payload, room = currentRoom) {
    const normalizedAction = normalizeActionName(action);
    if (!normalizedAction) return;

    if (isNavigationAction(normalizedAction)) {
        await navigateToSection(payload, room);
        return;
    }

    const { id, element } = resolveElementFromPayload(payload, { allowLabelFallback: false });
    console.log(`🚀 Executing action: ${action} on ID: ${id}`, payload);

    if (!element) {
        const rejectedTarget = typeof payload === 'string' ? payload : (payload?.id || payload?.element_id || payload?.node_id || null);
        console.warn(`❌ Element with ID ${id} not found in the DOM.`);
        if (rejectedTarget && !isLikelyNodeId(rejectedTarget)) {
            await publishClientAction(room, 'action_rejected', {
                action: normalizedAction,
                reason: 'invalid_or_non_id_target',
                target: String(rejectedTarget).slice(0, 120)
            });
        }
        return;
    }

    lastFocusedId = id || element.getAttribute('data-la-id') || null;
    const actionKey = `${normalizedAction}:${lastFocusedId || 'unknown'}`;
    const now = Date.now();
    if (actionKey === lastHandledActionKey && now - lastHandledActionAt < 2500) {
        return;
    }
    lastHandledActionKey = actionKey;
    lastHandledActionAt = now;
    lastAgentActionAt = now;

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
        if (ENABLE_FOCUS_SYNC) {
            await syncFocusContext(room, focusedId, 'agent_action');
        }
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
                    if (sessionPaused) return;
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
