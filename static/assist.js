(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const state = {
        recognition: null,
        listening: false,
        requests: [],
        seenRequestIds: new Set(),
        initializedRequests: false,
        pollBusy: false,
        audioContext: null,
        alarmTimer: null,
        alarmStopTimer: null,
        alarmDeadline: 0,
        alarmLockToken: null,
        manualLocationMode: false
    };

    const alarmLockKey = "trinetra-assist-alarm-lock";
    const alarmDurationMs = 5000;

    const emergencyPhrases = [
        "fell", "fallen", "fall down", "injured", "hurt badly", "emergency",
        "help me immediately", "emergency help", "call emergency", "sos"
    ];
    const urgentPhrases = [
        "can't move", "cannot move", "cant move", "help getting up", "get me up",
        "stuck", "urgent", "immediate assistance", "help me up", "cannot get up",
        "can't get up", "cant get up"
    ];
    const checkInPhrases = ["i am safe", "i'm safe", "im safe", "i am okay", "i'm okay", "im okay", "i am fine", "i'm fine"];

    function setFeedback(message, kind = "") {
        $("requestFeedback").textContent = message;
        $("requestFeedback").className = `feedback-box${kind ? ` is-${kind}` : ""}`;
    }

    function normalizeTranscript(text) {
        return text.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    }

    function processVoiceCommand(transcript) {
        const normalized = normalizeTranscript(transcript);
        const has = (phrases) => phrases.some((phrase) => normalized.includes(normalizeTranscript(phrase)));

        if (has(emergencyPhrases)) {
            return { category: "emergency", message: transcript.trim(), spoken: "Emergency assistance has been requested. Your caregiver has been alerted." };
        }
        if (has(urgentPhrases)) {
            return { category: "urgent", message: transcript.trim(), spoken: "I have sent an urgent assistance request to your caregiver." };
        }
        if (has(checkInPhrases)) {
            return { category: "check_in", message: transcript.trim(), spoken: "Your safety check-in has been sent." };
        }
        return { category: "normal", message: transcript.trim(), spoken: "Your request has been sent to your caregiver." };
    }

    function speak(text) {
        if (!("speechSynthesis" in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.92;
        utterance.pitch = 1;
        window.speechSynthesis.speak(utterance);
    }

    function showVoiceStatus(message, status = "ready") {
        $("voiceStatus").textContent = message;
        $("listenButtonText").textContent = status === "listening"
            ? "LISTENING…"
            : status === "starting" ? "CHECKING MICROPHONE…" : "TAP TO SPEAK";
        $("listenButton").classList.toggle("is-listening", status === "listening");
        const badge = status === "listening" ? "LISTENING"
            : status === "unsupported" ? "UNAVAILABLE"
                : status === "blocked" ? "MIC BLOCKED"
                    : status === "starting" ? "CHECKING" : "READY";
        $("voiceReadyBadge").className = `status-chip${status === "listening" ? " listening" : status === "blocked" || status === "unsupported" ? " unavailable" : " ready"}`;
        $("voiceReadyBadge").innerHTML = `<i></i> ${badge}`;
    }

    function microphoneErrorMessage(error) {
        if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
            return "Microphone access is blocked. Allow microphone access for this site in your browser settings, then reload. If you are in the VS Code preview, open http://127.0.0.1:5000/assist in Chrome or Edge.";
        }
        if (error && error.name === "NotFoundError") {
            return "No microphone was found. Connect or enable a microphone, then try again.";
        }
        if (error && error.name === "NotReadableError") {
            return "The microphone is busy or unavailable. Close other apps using it, then try again.";
        }
        return error && error.message
            ? error.message
            : "Could not access the microphone. Check browser permissions and try again.";
    }

    async function checkMicrophonePermission() {
        if (!navigator.permissions || !navigator.permissions.query) return;
        try {
            const permission = await navigator.permissions.query({ name: "microphone" });
            if (permission.state === "denied") {
                const message = microphoneErrorMessage({ name: "NotAllowedError" });
                $("voiceAvailability").textContent = "Microphone blocked";
                $("voiceAvailability").classList.add("error-text");
                showVoiceStatus(message, "blocked");
                setFeedback(message, "error");
            }
        } catch (error) {
            // Some browsers do not expose microphone permission through the Permissions API.
            console.debug("Microphone permission state is unavailable:", error);
        }
    }

    async function requestMicrophoneAccess() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

        if (navigator.permissions && navigator.permissions.query) {
            try {
                const permission = await navigator.permissions.query({ name: "microphone" });
                if (permission.state === "denied") {
                    throw Object.assign(new Error("Microphone permission is blocked."), { name: "NotAllowedError" });
                }
            } catch (error) {
                if (error.name === "NotAllowedError") throw error;
            }
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
    }

    function initializeSpeechRecognition() {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            $("voiceAvailability").textContent = "Not supported";
            $("voiceAvailability").classList.add("error-text");
            showVoiceStatus("⚠️ Voice recognition is not supported in this browser. Please use Chrome.", "unsupported");
            setFeedback("Voice recognition is not supported in this browser. Please use Google Chrome; the assistance buttons still work.", "error");
            $("listenButton").disabled = true;
            return;
        }

        state.recognition = new Recognition();
        state.recognition.lang = navigator.language || "en-US";
        state.recognition.continuous = false;
        state.recognition.interimResults = true;
        $("voiceAvailability").textContent = "Ready";

        state.recognition.onstart = () => {
            state.listening = true;
            showVoiceStatus("🔴 Listening…", "listening");
        };
        state.recognition.onresult = (event) => {
            let interim = "";
            let finalText = "";
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const phrase = event.results[index][0].transcript;
                if (event.results[index].isFinal) finalText += phrase;
                else interim += phrase;
            }
            const text = finalText || interim;
            $("transcriptOutput").textContent = text || "Listening for a request…";
            $("transcriptOutput").classList.toggle("has-text", Boolean(text));
            if (finalText.trim()) {
                showVoiceStatus("🧠 Processing request…");
                handleVoiceCommand(finalText.trim());
            }
        };
        state.recognition.onerror = (event) => {
            state.listening = false;
            const errors = {
                "not-allowed": "Microphone permission denied. Allow microphone access in browser settings.",
                "service-not-allowed": "Speech service is unavailable. Check browser permissions and internet access.",
                "audio-capture": "No microphone was found. Connect or enable a microphone.",
                "no-speech": "No speech was detected. Please try again.",
                "network": "Voice recognition needs a network connection in this browser.",
                "language-not-supported": "This browser does not support the selected recognition language."
            };
                const message = event.error === "not-allowed" || event.error === "service-not-allowed"
                    ? microphoneErrorMessage({ name: "NotAllowedError" })
                    : errors[event.error] || `Voice recognition error: ${event.error}.`;
                $("voiceAvailability").textContent = event.error === "not-allowed" || event.error === "service-not-allowed"
                    ? "Microphone blocked"
                    : "Ready";
                $("voiceAvailability").classList.toggle("error-text", event.error === "not-allowed" || event.error === "service-not-allowed");
                showVoiceStatus(message, event.error === "not-allowed" || event.error === "service-not-allowed" ? "blocked" : "ready");
                setFeedback(message, "error");
        };
        state.recognition.onend = () => {
            state.listening = false;
            if ($("voiceStatus").textContent.includes("Listening")) showVoiceStatus("Ready to listen");
        };
        showVoiceStatus("🎙️ Ready to listen");
    }

    function requestBrowserLocation() {
        if (state.manualLocationMode) {
            const latitude = Number($("testLatitude").value);
            const longitude = Number($("testLongitude").value);
            if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
                && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
                return Promise.resolve({
                    latitude,
                    longitude,
                    accuracy: 0,
                    source: "Test coordinates",
                    captured_at: new Date().toISOString()
                });
            }
            setFeedback("Enter valid test coordinates. The request will still be sent without a location.", "error");
            return Promise.resolve(null);
        }

        if (!navigator.geolocation) return Promise.resolve(null);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeoutId);
                resolve(result);
            };
            const timeoutId = window.setTimeout(() => finish(null), 4500);
            navigator.geolocation.getCurrentPosition(
                (position) => finish({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracy: position.coords.accuracy,
                    source: "Browser GPS",
                    captured_at: new Date().toISOString()
                }),
                () => finish(null),
                { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 }
            );
        });
    }

    function updateLocationDisplay(location) {
        if (!location) {
            $("locationAvailability").textContent = "Location unavailable";
            $("locationDetails").textContent = "Location unavailable. Your assistance request was still sent.";
            $("locationTime").textContent = "Not shared";
            return;
        }
        $("locationAvailability").textContent = "Available";
        $("locationTime").textContent = new Date(location.captured_at).toLocaleTimeString();
        const accuracy = `±${Math.round(location.accuracy)} m`;
        const mapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}#map=17/${encodeURIComponent(location.latitude)}/${encodeURIComponent(location.longitude)}`;
        $("locationDetails").replaceChildren();
        const coordinates = document.createElement("span");
        coordinates.textContent = `${location.source}: ${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)} · ${accuracy} `;
        const link = document.createElement("a");
        link.className = "location-link";
        link.href = mapUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View map";
        $("locationDetails").append(coordinates, link);
    }

    async function sendRequest(request) {
        const user = $("userNameInput").value.trim();
        if (!user) {
            setFeedback("Please enter your name before sending a request.", "error");
            $("userNameInput").focus();
            return;
        }
        setFeedback("Getting an optional location. Your request will send even if GPS is unavailable.");
        const location = await requestBrowserLocation();
        updateLocationDisplay(location);

        const payload = {
            user,
            message: request.message,
            category: request.category,
            location: location ? {
                latitude: location.latitude,
                longitude: location.longitude,
                accuracy: location.accuracy
            } : null
        };
        const endpoint = request.category === "emergency"
            ? "/api/assist/emergency"
            : request.category === "check_in"
                ? "/api/assist/check-in"
                : "/api/assist/request";

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Could not send request (${response.status}).`);

            const created = result.request;
            state.seenRequestIds.add(created.id);
            state.requests = [created, ...state.requests.filter((item) => item.id !== created.id)];
            renderRequests();
            $("lastRequestText").textContent = created.message;
            $("lastRequestStatus").textContent = `${created.severity} · ${created.status}`;
            showVoiceStatus(request.category === "emergency" ? "🚨 Emergency alert sent" : "✅ Request understood");
            setFeedback(request.category === "emergency"
                ? "Emergency assistance has been requested. Your caregiver has been alerted."
                : request.category === "urgent"
                    ? "Urgent assistance request sent to your caregiver."
                    : request.category === "check_in"
                        ? "Safety check-in sent. This is not an emergency alert."
                        : "Request sent to caregiver.",
                "success");
            if (request.spoken) speak(request.spoken);
            if (request.category === "emergency") {
                startAlarm();
                showEmergencyBanner(created);
                notifyEmergency(created);
            }
        } catch (error) {
            console.error("Could not submit TRINETRA assistance request:", error);
            setFeedback(`Request could not be sent: ${error.message}`, "error");
            showVoiceStatus("❌ Could not send request");
        }
    }

    function handleVoiceCommand(transcript) {
        $("transcriptOutput").textContent = transcript;
        $("transcriptOutput").classList.add("has-text");
        const request = processVoiceCommand(transcript);
        sendRequest(request);
    }

    function quickAction(button) {
        if (button.dataset.action === "confirm-emergency") {
            openSosConfirmation();
            return;
        }
        const category = button.dataset.action;
        sendRequest({
            category,
            message: button.dataset.message,
            spoken: button.dataset.spoken
        });
    }

    function openSosConfirmation() {
        const dialog = $("sosDialog");
        if (typeof dialog.showModal === "function") dialog.showModal();
        else if (window.confirm("Are you sure you need emergency assistance?")) sendEmergencySos();
    }

    function sendEmergencySos() {
        $("sosDialog").close();
        sendRequest({
            category: "emergency",
            message: "Emergency SOS requested.",
            spoken: "Emergency alert sent to your caregiver."
        });
    }

    function severityClass(item) {
        if (item.category === "URGENT") return "urgent";
        if (item.category === "EMERGENCY") return "emergency";
        if (item.category === "CHECK-IN") return "check-in";
        return "normal";
    }

    function makeHistoryItem(item) {
        const row = document.createElement("article");
        row.className = "history-item";
        const top = document.createElement("div");
        top.className = "history-topline";
        const title = document.createElement("strong");
        title.textContent = item.message;
        const severity = document.createElement("span");
        severity.className = `severity-chip ${severityClass(item)}`;
        severity.textContent = item.severity;
        top.append(title, severity);

        const metadata = document.createElement("p");
        metadata.textContent = `${new Date(item.timestamp).toLocaleString()} · `;
        const status = document.createElement("span");
        status.className = `request-status ${item.status === "ACKNOWLEDGED" ? "acknowledged" : "pending"}`;
        status.textContent = item.status;
        metadata.append(status);
        row.append(top, metadata);
        return row;
    }

    function makeCaregiverCard(item) {
        const card = document.createElement("article");
        card.className = `caregiver-request${item.category === "EMERGENCY" ? " is-emergency" : item.category === "URGENT" ? " is-urgent" : ""}`;
        card.dataset.requestId = String(item.id);

        const top = document.createElement("div");
        top.className = "caregiver-topline";
        const title = document.createElement("h3");
        title.textContent = item.category === "EMERGENCY" ? "🚨 EMERGENCY" : item.severity;
        const severity = document.createElement("span");
        severity.className = `severity-chip ${severityClass(item)}`;
        severity.textContent = item.status;
        top.append(title, severity);

        const details = document.createElement("p");
        details.textContent = `User: ${item.user} · ${new Date(item.timestamp).toLocaleString()}`;
        const message = document.createElement("p");
        message.textContent = `Request: “${item.message}”`;
        const location = document.createElement("p");
        if (item.location) {
            const mapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(item.location.latitude)}&mlon=${encodeURIComponent(item.location.longitude)}#map=17/${encodeURIComponent(item.location.latitude)}/${encodeURIComponent(item.location.longitude)}`;
            const link = document.createElement("a");
            link.className = "location-link";
            link.href = mapUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = `${Number(item.location.latitude).toFixed(6)}, ${Number(item.location.longitude).toFixed(6)} · View location`;
            location.append("📍 ", link);
        } else {
            location.textContent = "📍 Location unavailable";
        }

        const actions = document.createElement("div");
        actions.className = "request-actions";
        if (item.location) {
            const view = document.createElement("a");
            view.className = "button button-soft";
            view.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(item.location.latitude)}&mlon=${encodeURIComponent(item.location.longitude)}#map=17/${encodeURIComponent(item.location.latitude)}/${encodeURIComponent(item.location.longitude)}`;
            view.target = "_blank";
            view.rel = "noopener noreferrer";
            view.textContent = "View location";
            actions.append(view);
        }
        const acknowledge = document.createElement("button");
        acknowledge.className = "button button-soft";
        acknowledge.type = "button";
        acknowledge.dataset.acknowledge = String(item.id);
        acknowledge.textContent = item.status === "ACKNOWLEDGED" ? "Acknowledged" : "Acknowledge";
        acknowledge.disabled = item.status === "ACKNOWLEDGED";
        actions.append(acknowledge);
        card.append(top, details, message, location, actions);
        return card;
    }

    function renderRequests() {
        $("requestCount").textContent = `${state.requests.length} REQUEST${state.requests.length === 1 ? "" : "S"}`;
        $("requestHistory").replaceChildren();
        $("caregiverRequests").replaceChildren();

        if (!state.requests.length) {
            const emptyHistory = document.createElement("p");
            emptyHistory.className = "empty-state";
            emptyHistory.textContent = "No assistance requests yet.";
            $("requestHistory").append(emptyHistory);
            const emptyCaregiver = document.createElement("p");
            emptyCaregiver.className = "empty-state";
            emptyCaregiver.textContent = "Waiting for requests.";
            $("caregiverRequests").append(emptyCaregiver);
            return;
        }

        for (const item of state.requests) $("requestHistory").append(makeHistoryItem(item));
        for (const item of state.requests) $("caregiverRequests").append(makeCaregiverCard(item));
    }

    function startAlarm() {
        stopAlarm();
        const now = Date.now();
        const lockToken = `${now}-${Math.random().toString(36).slice(2)}`;
        try {
            const currentLock = JSON.parse(localStorage.getItem(alarmLockKey) || "null");
            if (currentLock && currentLock.expiresAt > now) return;
            localStorage.setItem(alarmLockKey, JSON.stringify({
                token: lockToken,
                expiresAt: now + alarmDurationMs + 1000
            }));
            const confirmedLock = JSON.parse(localStorage.getItem(alarmLockKey) || "null");
            if (!confirmedLock || confirmedLock.token !== lockToken) return;
            state.alarmLockToken = lockToken;
        } catch (error) {
            console.warn("Could not coordinate the emergency alert sound across tabs:", error);
        }
        state.alarmDeadline = now + alarmDurationMs;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            setFeedback("Emergency sent. Your browser does not support the optional alert sound.", "error");
            return;
        }
        try {
            state.audioContext = state.audioContext || new AudioContext();
            state.audioContext.resume().catch((error) => console.warn("Could not resume alert audio:", error));
            const beep = () => {
                if (Date.now() >= state.alarmDeadline) {
                    stopAlarm();
                    return;
                }
                if (!state.audioContext || state.audioContext.state !== "running") return;
                const oscillator = state.audioContext.createOscillator();
                const gain = state.audioContext.createGain();
                oscillator.type = "sine";
                oscillator.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.2, state.audioContext.currentTime + 0.025);
                gain.gain.exponentialRampToValueAtTime(0.0001, state.audioContext.currentTime + 0.42);
                oscillator.connect(gain);
                gain.connect(state.audioContext.destination);
                oscillator.start();
                oscillator.stop(state.audioContext.currentTime + 0.43);
            };
            beep();
            state.alarmTimer = window.setInterval(beep, 1100);
            state.alarmStopTimer = window.setTimeout(stopAlarm, alarmDurationMs);
        } catch (error) {
            console.error("Could not play the emergency alert sound:", error);
            stopAlarm();
        }
    }

    function stopAlarm() {
        if (state.alarmTimer !== null) window.clearInterval(state.alarmTimer);
        if (state.alarmStopTimer !== null) window.clearTimeout(state.alarmStopTimer);
        state.alarmTimer = null;
        state.alarmStopTimer = null;
        state.alarmDeadline = 0;
        if (state.alarmLockToken) {
            try {
                const currentLock = JSON.parse(localStorage.getItem(alarmLockKey) || "null");
                if (currentLock && currentLock.token === state.alarmLockToken) {
                    localStorage.removeItem(alarmLockKey);
                }
            } catch (error) {
                console.warn("Could not release the emergency alert sound lock:", error);
            }
            state.alarmLockToken = null;
        }
    }

    function showEmergencyBanner(item) {
        $("emergencyTitle").textContent = `${item.user} needs emergency assistance`;
        $("emergencyDetails").textContent = `${item.message} · ${new Date(item.timestamp).toLocaleTimeString()}`;
        $("emergencyBanner").hidden = false;
    }

    function notifyEmergency(item) {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        try {
            new Notification("TRINETRA Emergency Alert", {
                body: `${item.user} requested emergency assistance.`,
                tag: `trinetra-assist-${item.id}`
            });
        } catch (error) {
            console.warn("Could not show the browser notification:", error);
        }
    }

    async function pollRequests() {
        if (state.pollBusy) return;
        state.pollBusy = true;
        try {
            const response = await fetch("/api/assist/requests", { headers: { Accept: "application/json" } });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Could not load requests (${response.status}).`);
            const incoming = Array.isArray(result.requests) ? result.requests : [];
            if (state.initializedRequests) {
                const newEmergency = incoming.find((item) =>
                    item.category === "EMERGENCY" && !state.seenRequestIds.has(item.id)
                );
                if (newEmergency) {
                    startAlarm();
                    showEmergencyBanner(newEmergency);
                    notifyEmergency(newEmergency);
                }
            }
            for (const item of incoming) state.seenRequestIds.add(item.id);
            state.requests = incoming;
            const pendingEmergency = incoming.find((item) =>
                item.category === "EMERGENCY" && item.status === "PENDING"
            );
            if (pendingEmergency && !state.initializedRequests && $("emergencyBanner").hidden) {
                showEmergencyBanner(pendingEmergency);
            }
            if (!pendingEmergency) {
                stopAlarm();
                $("emergencyBanner").hidden = true;
            }
            state.initializedRequests = true;
            $("caregiverConnection").textContent = "LIVE";
            $("caregiverConnection").className = "status-chip ready";
            renderRequests();
            if (incoming.length) {
                const latest = incoming[0];
                $("lastRequestText").textContent = latest.message;
                $("lastRequestStatus").textContent = `${latest.severity} · ${latest.status}`;
            }
        } catch (error) {
            console.error("Caregiver request polling failed:", error);
            $("caregiverConnection").textContent = "RECONNECTING";
            $("caregiverConnection").className = "status-chip";
            setFeedback(`Caregiver panel is reconnecting: ${error.message}`, "error");
        } finally {
            state.pollBusy = false;
        }
    }

    async function acknowledgeRequest(requestId) {
        try {
            const response = await fetch(`/api/assist/requests/${encodeURIComponent(requestId)}/acknowledge`, {
                method: "POST",
                headers: { Accept: "application/json" }
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Could not acknowledge request (${response.status}).`);
            state.requests = state.requests.map((item) => item.id === result.request.id ? result.request : item);
            renderRequests();
            const acknowledged = state.requests.find((item) => item.id === result.request.id);
            if (acknowledged) speak(`${acknowledged.user}, your caregiver has acknowledged your request.`);
            if (!state.requests.some((item) => item.category === "EMERGENCY" && item.status === "PENDING")) {
                stopAlarm();
                $("emergencyBanner").hidden = true;
            }
            setFeedback("Caregiver acknowledgement recorded.", "success");
        } catch (error) {
            console.error("Could not acknowledge caregiver request:", error);
            setFeedback(error.message, "error");
        }
    }

    function submitTestRequest(category) {
        const messages = {
            normal: "I need water.",
            urgent: "I need help getting up.",
            emergency: "I fell down. This is an emergency.",
            check_in: "I am safe."
        };
        sendRequest({
            category,
            message: messages[category],
            spoken: category === "emergency"
                ? "Emergency assistance has been requested. Your caregiver has been alerted."
                : "Your test request has been sent to the caregiver panel."
        });
    }

    function initialize() {
        initializeSpeechRecognition();
        checkMicrophonePermission();
        $("listenButton").addEventListener("click", () => {
            if (!state.recognition || state.listening) return;
            $("transcriptOutput").textContent = "Listening for a request…";
            $("transcriptOutput").classList.add("has-text");
            showVoiceStatus("Checking microphone access…", "starting");
            $("listenButton").disabled = true;
            requestMicrophoneAccess()
                .then(() => {
                    state.recognition.start();
                })
                .catch((error) => {
                    const message = microphoneErrorMessage(error);
                    $("voiceAvailability").textContent = error.name === "NotAllowedError" ? "Microphone blocked" : "Microphone unavailable";
                    $("voiceAvailability").classList.add("error-text");
                    showVoiceStatus(message, error.name === "NotAllowedError" ? "blocked" : "ready");
                    setFeedback(message, "error");
                })
                .finally(() => {
                    $("listenButton").disabled = false;
                });
        });

        document.querySelectorAll("[data-action]").forEach((button) => {
            button.addEventListener("click", () => quickAction(button));
        });
        $("sosButton").addEventListener("click", openSosConfirmation);
        $("confirmSosButton").addEventListener("click", (event) => {
            event.preventDefault();
            sendEmergencySos();
        });
        $("cancelSosButton").addEventListener("click", () => $("sosDialog").close());
        $("dismissEmergency").addEventListener("click", () => {
            $("emergencyBanner").hidden = true;
            if (!state.requests.some((item) => item.category === "EMERGENCY" && item.status === "PENDING")) stopAlarm();
        });
        $("caregiverRequests").addEventListener("click", (event) => {
            const button = event.target.closest("[data-acknowledge]");
            if (button) acknowledgeRequest(button.dataset.acknowledge);
        });
        $("testModeToggle").addEventListener("change", (event) => {
            state.manualLocationMode = event.target.checked;
            $("testLocationFields").hidden = !state.manualLocationMode;
            setFeedback(state.manualLocationMode
                ? "Test location enabled. Requests will include the entered coordinates."
                : "Real browser location is the default. Test coordinates are no longer used.");
        });
        document.querySelectorAll("[data-test]").forEach((button) => {
            button.addEventListener("click", () => submitTestRequest(button.dataset.test));
        });
        pollRequests();
        window.setInterval(pollRequests, 4000);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
    else initialize();
})();
