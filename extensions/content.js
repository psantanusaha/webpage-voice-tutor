console.log("🚀 LearnAloud: Extension Loaded");

let sessionActive = false;
let indicator = null;
let currentRoom = null;

async function stopTutor() {
    if (!sessionActive) return;
    console.log("🛑 Stopping session...");
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
    
    console.log("✅ Session ended.");
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
        room.on(RoomEvent.DataReceived, (payload, participant) => {
            try {
                const str = new TextDecoder().decode(payload);
                const data = JSON.parse(str);
                console.log("📩 Received from agent:", data);

                if (data.type === 'client_action') {
                    // Built-in heartbeat: verify data channel connectivity
                    if (data.action === 'heartbeat') {
                        console.log('💓 Connection verified! Agent:', data.payload.agent_identity);
                        // Send ack for round-trip latency measurement
                        const ackMsg = JSON.stringify({
                            type: 'client_action',
                            action: 'heartbeat_ack',
                            payload: { timestamp: data.payload.timestamp }
                        });
                        room.localParticipant.publishData(new TextEncoder().encode(ackMsg), { 
                            reliable: true, 
                            topic: 'client_actions' 
                        });
                        return;
                    }

                    // Handle other agent actions
                    handleAgentAction(data.action, data.payload);
                } else if (data.type === 'agent_action') {
                    // Fallback for legacy format or agent-specific actions
                    handleAgentAction(data.action, data.payload);
                }
            } catch (e) {
                console.error("Error parsing agent message:", e);
            }
        });

        // 3. Map Page
        const pageMap = Array.from(document.querySelectorAll('p, h1, h2, h3, li')).map((el, i) => {
            const id = `la-node-${i}`;
            el.setAttribute('data-la-id', id);
            return { id, text: el.innerText.trim() };
        });

        // 3.5 Set up Scroll Tracking
        setupScrollTracking(room);

        // 4. Connect via Relay
        const res = await fetch("http://localhost:3000/token", { method: 'POST' });
        const { livekit_url, token } = await res.json();
        
        await room.connect(livekit_url, token);
        await room.localParticipant.setMicrophoneEnabled(true);

        // 5. Sync Context (with size check)
        let finalSegments = pageMap;
        const createMsg = (segments) => JSON.stringify({ 
            type: 'client_action', 
            action: 'update_context', 
            payload: { segments } 
        });

        // If message is too large, prune segments
        while (createMsg(finalSegments).length > 60000 && finalSegments.length > 0) {
            finalSegments.pop(); // Remove last segment until it fits
        }

        const msg = createMsg(finalSegments);
        console.log(`📤 Sending context (${finalSegments.length} segments, ${msg.length} bytes)`);
        
        await room.localParticipant.publishData(new TextEncoder().encode(msg), { 
            reliable: true, 
            topic: 'client_actions' 
        });

        sessionActive = true;
        createIndicator();
        console.log("%c 🎙️ LearnAloud ACTIVE ", "background: #4f46e5; color: white; padding: 5px; border-radius: 4px;");

    } catch (error) {
        console.error("❌ LearnAloud Error:", error);
        sessionActive = false;
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

function handleAgentAction(action, payload) {
    const id = typeof payload === 'string' ? payload : payload.id;
    console.log(`🚀 Executing action: ${action} on ID: ${id}`, payload);
    
    const element = document.querySelector(`[data-la-id="${id}"]`);
    
    if (!element) {
        console.warn(`❌ Element with ID ${id} not found in the DOM.`);
        return;
    }

    const normalizedAction = action.toLowerCase();

    // Ensure our highlight style exists
    if (!document.getElementById('la-highlight-style')) {
        const style = document.createElement('style');
        style.id = 'la-highlight-style';
        style.innerHTML = `
            @keyframes la-flash {
                0% { background-color: transparent; }
                20% { background-color: #fef08a; outline: 3px solid #facc15; }
                80% { background-color: #fef08a; outline: 3px solid #facc15; }
                100% { background-color: transparent; outline: 3px solid transparent; }
            }
            .la-highlight-active {
                animation: la-flash 4s ease-in-out;
                border-radius: 4px;
                transition: all 0.3s;
            }
        `;
        document.head.appendChild(style);
    }

    switch (normalizedAction) {
        case 'scroll_to':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        case 'highlight':
            // Remove class if it was already there to restart animation
            element.classList.remove('la-highlight-active');
            void element.offsetWidth; // Trigger reflow
            
            element.classList.add('la-highlight-active');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            setTimeout(() => {
                element.classList.remove('la-highlight-active');
            }, 4000);
            break;
        default:
            console.log("Unknown action:", action);
    }
}

function setupScrollTracking(room) {
    let lastId = null;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('data-la-id');
                if (id !== lastId) {
                    lastId = id;
                    const msg = JSON.stringify({
                        type: 'client_action',
                        action: 'user_scroll',
                        payload: { id: id }
                    });
                    room.localParticipant.publishData(new TextEncoder().encode(msg), { 
                        reliable: true, 
                        topic: 'client_actions' 
                    });
                }
            }
        });
    }, { threshold: 0.5 });

    document.querySelectorAll('[data-la-id]').forEach(el => observer.observe(el));
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