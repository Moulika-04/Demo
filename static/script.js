(() => {
    "use strict";

    const SAMPLE_HOME = { latitude: 13.16, longitude: 79.98 };
    const EARTH_RADIUS_METERS = 6371000;
    const elements = {};
    const uiIds = [
        "monitoringBadge", "gpsIndicator", "emergencyAlert", "alertDistance", "alertTime",
        "alertHome", "alertChild", "viewChildButton", "acknowledgeButton", "setCurrentHomeButton",
        "homeLatitudeInput", "homeLongitudeInput", "setManualHomeButton", "safeRadiusInput",
        "radiusValue", "customRadiusInput", "homeLatitudeDisplay", "homeLongitudeDisplay",
        "homeLocationTag", "gpsActiveTag", "childStatusCard", "childStatusText", "distanceDisplay",
        "statusRadiusDisplay", "accuracyDisplay", "updatedDisplay", "childLatitudeDisplay",
        "childLongitudeDisplay", "startMonitoringButton", "stopMonitoringButton", "gpsMessage",
        "modeBadge", "toggleTestModeButton", "testControls", "testLatitudeInput", "testLongitudeInput",
        "insideTestButton", "outsideTestButton", "updateTestLocationButton", "alertHistory", "map"
    ];
    for (const id of uiIds) elements[id] = document.getElementById(id);

    const state = {
        home: null,
        radius: 100,
        child: null,
        childStatus: null,
        monitoring: false,
        testMode: false,
        watchId: null,
        map: null,
        homeMarker: null,
        childMarker: null,
        safeCircle: null,
        audioContext: null,
        alarmTimer: null,
        latestAlertId: null,
        apiErrorShown: false,
        autoFitNextLocation: false
    };

    const formatCoordinate = (value) => Number(value).toFixed(6);
    const coordinateText = (point) => `${formatCoordinate(point.latitude)}, ${formatCoordinate(point.longitude)}`;

    function calculateDistance(lat1, lon1, lat2, lon2) {
        const radians = (degrees) => degrees * Math.PI / 180;
        const latitudeDelta = radians(lat2 - lat1);
        const longitudeDelta = radians(lon2 - lon1);
        const haversine = Math.sin(latitudeDelta / 2) ** 2
            + Math.cos(radians(lat1)) * Math.cos(radians(lat2))
            * Math.sin(longitudeDelta / 2) ** 2;
        return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    async function apiRequest(path, body) {
        const response = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Server request failed (${response.status}).`);
        state.apiErrorShown = false;
        return result;
    }

    function reportApiError(error) {
        console.error("TRINETRA server synchronization failed:", error);
        state.apiErrorShown = true;
        setMessage(`Server sync error: ${error.message}`, true);
    }

    function setMessage(message, isError = false) {
        elements.gpsMessage.textContent = message;
        elements.gpsMessage.classList.toggle("message-error", isError);
    }

    function setHome(latitude, longitude, source) {
        state.home = { latitude, longitude };
        state.childStatus = null;
        elements.homeLatitudeInput.value = formatCoordinate(latitude);
        elements.homeLongitudeInput.value = formatCoordinate(longitude);
        elements.homeLatitudeDisplay.textContent = formatCoordinate(latitude);
        elements.homeLongitudeDisplay.textContent = formatCoordinate(longitude);
        elements.homeLocationTag.textContent = source;
        elements.homeLocationTag.classList.add("is-set");
        if (state.map) {
            const location = [latitude, longitude];
            if (state.homeMarker) state.homeMarker.setLatLng(location);
            else state.homeMarker = L.marker(location, { icon: createMapIcon("🏠", "home-pin"), title: "Home" }).addTo(state.map);
            if (state.safeCircle) state.safeCircle.setLatLng(location).setRadius(state.radius);
            else state.safeCircle = L.circle(location, circleOptions()).addTo(state.map);
            state.autoFitNextLocation = true;
            state.map.setView(location, 16);
            fitMapWhenReady();
        }
        if (state.child) updateChildLocation(state.child);
        setMessage(`Home location set from ${source.toLowerCase()}. Safe radius: ${state.radius} meters.`);
    }

    function createMapIcon(emoji, className) {
        return L.divIcon({
            className: "",
            html: `<span class="map-pin ${className}">${emoji}</span>`,
            iconSize: [38, 38],
            iconAnchor: [19, 19]
        });
    }

    function circleOptions() {
        return {
            radius: state.radius,
            color: "#327bd0",
            weight: 2,
            opacity: 0.85,
            fillColor: "#4d91e4",
            fillOpacity: 0.14
        };
    }

    function fitMapWhenReady() {
        if (!state.map || !state.home || !state.child || !state.autoFitNextLocation) return;
        state.map.fitBounds(L.latLngBounds(
            [state.home.latitude, state.home.longitude],
            [state.child.latitude, state.child.longitude]
        ).pad(0.18), { maxZoom: 17 });
        state.autoFitNextLocation = false;
    }

    function initializeMap() {
        if (!window.L) {
            setMessage("Map library did not load. Check your internet connection and refresh.", true);
            return;
        }
        state.map = L.map(elements.map, { scrollWheelZoom: true }).setView(
            [SAMPLE_HOME.latitude, SAMPLE_HOME.longitude], 15
        );
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors"
        }).addTo(state.map);
        if (state.home) setHome(state.home.latitude, state.home.longitude, "MANUAL");
        window.setTimeout(() => state.map.invalidateSize(), 100);
    }

    function updateRadius(rawValue) {
        const radius = Number(rawValue);
        if (!Number.isFinite(radius) || radius < 1 || radius > 10000) {
            setMessage("Enter a safe radius from 1 to 10,000 meters.", true);
            return;
        }
        state.radius = radius;
        elements.radiusValue.textContent = String(radius);
        elements.statusRadiusDisplay.textContent = `${radius} m`;
        elements.safeRadiusInput.value = String(Math.min(1000, Math.max(50, radius - (radius % 50))));
        elements.customRadiusInput.value = String(radius);
        if (state.safeCircle) state.safeCircle.setRadius(radius);
        if (state.child && state.home) updateChildLocation(state.child);
    }

    async function updateChildLocation(position, mode = "gps") {
        if (!state.home) {
            setMessage("Set a home location before monitoring the safe zone.", true);
            return;
        }
        const child = {
            latitude: position.latitude,
            longitude: position.longitude,
            accuracy: Number.isFinite(position.accuracy) ? position.accuracy : 0,
            mode,
            updatedAt: new Date().toISOString()
        };
        state.child = child;
        const distance = calculateDistance(
            state.home.latitude, state.home.longitude, child.latitude, child.longitude
        );
        const currentStatus = distance <= state.radius ? "SAFE" : "OUTSIDE";

        elements.distanceDisplay.textContent = `${Math.round(distance)} m`;
        elements.accuracyDisplay.textContent = `±${Math.round(child.accuracy)} m`;
        elements.updatedDisplay.textContent = new Date(child.updatedAt).toLocaleTimeString();
        elements.childLatitudeDisplay.textContent = formatCoordinate(child.latitude);
        elements.childLongitudeDisplay.textContent = formatCoordinate(child.longitude);
        elements.statusRadiusDisplay.textContent = `${state.radius} m`;
        elements.childStatusText.textContent = currentStatus === "SAFE" ? "SAFE ZONE" : "OUTSIDE SAFE ZONE";
        elements.childStatusCard.classList.toggle("status-safe", currentStatus === "SAFE");
        elements.childStatusCard.classList.toggle("status-outside", currentStatus === "OUTSIDE");
        elements.childStatusCard.classList.remove("status-idle");

        if (state.map) {
            const location = [child.latitude, child.longitude];
            if (state.childMarker) {
                state.childMarker.setLatLng(location);
                state.childMarker.setIcon(createMapIcon("👦", currentStatus === "OUTSIDE" ? "child-pin outside" : "child-pin"));
            } else {
                state.childMarker = L.marker(location, {
                    icon: createMapIcon("👦", currentStatus === "OUTSIDE" ? "child-pin outside" : "child-pin"),
                    title: "Child"
                }).addTo(state.map);
            }
            state.map.panTo(location, { animate: true });
            fitMapWhenReady();
        }

        const crossedOutside = currentStatus === "OUTSIDE" && state.childStatus !== "OUTSIDE";
        state.childStatus = currentStatus;
        if (crossedOutside) await triggerAlert(distance, child);

        try {
            await apiRequest("/api/location", {
                latitude: child.latitude,
                longitude: child.longitude,
                accuracy: child.accuracy,
                distance,
                safe_radius: state.radius,
                status: currentStatus,
                mode
            });
        } catch (error) {
            reportApiError(error);
        }
    }

    async function triggerAlert(distance, child) {
        const detectedAt = new Date();
        elements.emergencyAlert.hidden = false;
        elements.alertDistance.textContent = `${Math.round(distance)} meters`;
        elements.alertTime.textContent = detectedAt.toLocaleTimeString();
        elements.alertHome.textContent = coordinateText(state.home);
        elements.alertChild.textContent = coordinateText(child);
        startAlarm();
        addHistoryItem({
            distance,
            detectedAt: detectedAt.toISOString(),
            acknowledged: false
        }, true);

        if ("Notification" in window && Notification.permission === "granted") {
            new Notification("TRINETRA: Child outside safe zone", {
                body: `Distance from home: ${Math.round(distance)} meters.`,
                tag: "trinetra-geofence"
            });
        }
        try {
            const result = await apiRequest("/api/alerts", {
                distance,
                safe_radius: state.radius,
                latitude: child.latitude,
                longitude: child.longitude,
                home_latitude: state.home.latitude,
                home_longitude: state.home.longitude
            });
            state.latestAlertId = result.alert.id;
            replaceLatestHistoryId(result.alert.id);
        } catch (error) {
            reportApiError(error);
        }
    }

    function addHistoryItem(alert, pending = false) {
        const empty = elements.alertHistory.querySelector(".empty-history");
        if (empty) empty.remove();
        const item = document.createElement("article");
        item.className = "history-item";
        if (pending) item.dataset.pending = "true";
        const title = document.createElement("strong");
        title.textContent = `Outside safe zone · ${Math.round(alert.distance)} m from home`;
        const details = document.createElement("p");
        details.textContent = new Date(alert.detectedAt).toLocaleString();
        const acknowledgment = document.createElement("p");
        acknowledgment.className = alert.acknowledged ? "acknowledged" : "";
        acknowledgment.textContent = alert.acknowledged ? "Acknowledged" : "Needs acknowledgment";
        item.append(title, details, acknowledgment);
        elements.alertHistory.prepend(item);
    }

    function replaceLatestHistoryId(id) {
        const pending = elements.alertHistory.querySelector('[data-pending="true"]');
        if (pending) {
            pending.dataset.alertId = String(id);
            pending.removeAttribute("data-pending");
        }
    }

    function startAlarm() {
        stopAlarm();
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        try {
            state.audioContext = state.audioContext || new AudioContext();
            state.audioContext.resume().catch((error) => console.warn("Audio could not start:", error));
            const beep = () => {
                if (!state.audioContext || state.audioContext.state !== "running") return;
                const oscillator = state.audioContext.createOscillator();
                const gain = state.audioContext.createGain();
                oscillator.type = "sine";
                oscillator.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.25, state.audioContext.currentTime + 0.025);
                gain.gain.exponentialRampToValueAtTime(0.0001, state.audioContext.currentTime + 0.45);
                oscillator.connect(gain);
                gain.connect(state.audioContext.destination);
                oscillator.start();
                oscillator.stop(state.audioContext.currentTime + 0.46);
            };
            beep();
            state.alarmTimer = window.setInterval(beep, 1100);
        } catch (error) {
            console.error("Could not play the geofence alarm:", error);
            setMessage("Alert shown, but the alarm could not play. Check browser audio settings.", true);
        }
    }

    function stopAlarm() {
        if (state.alarmTimer) window.clearInterval(state.alarmTimer);
        state.alarmTimer = null;
    }

    async function acknowledgeAlert() {
        stopAlarm();
        elements.emergencyAlert.hidden = true;
        const item = elements.alertHistory.querySelector(".history-item:not([data-pending])");
        if (item) {
            const acknowledgement = item.querySelector("p:last-child");
            acknowledgement.textContent = "Acknowledged";
            acknowledgement.classList.add("acknowledged");
        }
        if (state.latestAlertId !== null) {
            try {
                await apiRequest(`/api/alerts/${state.latestAlertId}/acknowledge`, {});
            } catch (error) {
                reportApiError(error);
            }
        }
    }

    function handleGeolocationError(error) {
        state.monitoring = false;
        elements.startMonitoringButton.disabled = false;
        elements.stopMonitoringButton.disabled = true;
        elements.monitoringBadge.textContent = "MONITORING OFF";
        elements.gpsIndicator.classList.remove("is-on");
        elements.gpsIndicator.innerHTML = '<span class="status-dot muted-dot"></span> GPS UNAVAILABLE';
        elements.gpsActiveTag.textContent = "GPS OFF";
        elements.gpsActiveTag.classList.remove("is-on");
        const messages = {
            1: "Location permission denied. Please enable location access in your browser.",
            2: "GPS location unavailable. Check your device location settings and try again.",
            3: "GPS request timed out. Move to an area with a clearer GPS signal and retry."
        };
        const message = messages[error.code] || "GPS location unavailable. Please try again.";
        setMessage(`⚠️ ${message}`, true);
        apiRequest("/api/monitoring", { monitoring: false }).catch(reportApiError);
        if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }

    async function startMonitoring() {
        if (!state.home) {
            setMessage("Set a home location before starting monitoring.", true);
            return;
        }
        if (state.monitoring) return;
        if (!state.testMode && !("geolocation" in navigator)) {
            setMessage("⚠️ GPS location unavailable. This browser does not support geolocation.", true);
            return;
        }

        state.monitoring = true;
        state.childStatus = null;
        elements.startMonitoringButton.disabled = true;
        elements.stopMonitoringButton.disabled = false;
        elements.monitoringBadge.textContent = "MONITORING ON";
        elements.gpsIndicator.classList.add("is-on");
        elements.gpsIndicator.innerHTML = `<span class="status-dot"></span> ${state.testMode ? "TEST MODE ACTIVE" : "GPS ACTIVE"}`;
        elements.gpsActiveTag.textContent = state.testMode ? "TEST MODE" : "GPS ACTIVE";
        elements.gpsActiveTag.classList.add("is-on");
        if (state.audioContext) state.audioContext.resume().catch((error) => console.warn("Audio context resume failed:", error));

        if ("Notification" in window && Notification.permission === "default") {
            try { await Notification.requestPermission(); }
            catch (error) { console.warn("Notification permission request failed:", error); }
        }
        try {
            await apiRequest("/api/monitoring", { monitoring: true });
        } catch (error) {
            reportApiError(error);
        }

        if (state.testMode) {
            setMessage("Test mode is on. Enter a simulated child position or use an inside/outside preset.");
            return;
        }
        setMessage("Requesting GPS permission. Keep this page open for live location updates.");
        state.watchId = navigator.geolocation.watchPosition(
            (position) => {
                elements.gpsIndicator.classList.add("is-on");
                elements.gpsIndicator.innerHTML = '<span class="status-dot"></span> GPS ACTIVE';
                elements.gpsActiveTag.textContent = "GPS ACTIVE";
                updateChildLocation({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracy: position.coords.accuracy
                }, "gps");
                setMessage("Live GPS location is being monitored.");
            },
            handleGeolocationError,
            { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
        );
    }

    async function stopMonitoring() {
        state.monitoring = false;
        if (state.watchId !== null && "geolocation" in navigator) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }
        elements.startMonitoringButton.disabled = false;
        elements.stopMonitoringButton.disabled = true;
        elements.monitoringBadge.textContent = "MONITORING OFF";
        elements.gpsIndicator.classList.remove("is-on");
        elements.gpsIndicator.innerHTML = '<span class="status-dot muted-dot"></span> GPS NOT STARTED';
        elements.gpsActiveTag.textContent = "GPS OFF";
        elements.gpsActiveTag.classList.remove("is-on");
        stopAlarm();
        try {
            await apiRequest("/api/monitoring", { monitoring: false });
        } catch (error) {
            reportApiError(error);
        }
        setMessage("Monitoring stopped. Your last location remains visible on the map.");
    }

    function setCurrentHomeFromGps() {
        if (!("geolocation" in navigator)) {
            setMessage("⚠️ GPS location unavailable. Enter the home coordinates manually.", true);
            return;
        }
        elements.setCurrentHomeButton.disabled = true;
        setMessage("Getting the browser's current location for home…");
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setHome(position.coords.latitude, position.coords.longitude, "GPS");
                elements.setCurrentHomeButton.disabled = false;
            },
            (error) => {
                const message = error.code === 1
                    ? "Location permission denied. Enable browser location access or enter coordinates manually."
                    : error.code === 3
                        ? "GPS request timed out. Try again or enter coordinates manually."
                        : "GPS location unavailable. Try again or enter coordinates manually.";
                setMessage(`⚠️ ${message}`, true);
                elements.setCurrentHomeButton.disabled = false;
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    }

    function setManualHomeFromInputs() {
        const latitude = Number(elements.homeLatitudeInput.value);
        const longitude = Number(elements.homeLongitudeInput.value);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
            || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            setMessage("Enter a valid home latitude (-90 to 90) and longitude (-180 to 180).", true);
            return;
        }
        setHome(latitude, longitude, "MANUAL");
    }

    function enableTestMode() {
        state.testMode = !state.testMode;
        elements.testControls.hidden = !state.testMode;
        elements.modeBadge.textContent = state.testMode ? "TEST MODE" : "REAL GPS";
        elements.toggleTestModeButton.textContent = state.testMode ? "Return to Real GPS Mode" : "🧪 Enable Test Mode";
        if (state.monitoring) stopMonitoring();
        setMessage(state.testMode
            ? "Test mode enabled. Real GPS is paused until you return to Real GPS Mode and start monitoring."
            : "Real GPS mode selected. Press Start Monitoring to request live location.");
    }

    function placeTestPosition(distanceMeters) {
        if (!state.home) {
            setMessage("Set a home location before placing a test position.", true);
            return;
        }
        const latitude = state.home.latitude + distanceMeters / 111195;
        elements.testLatitudeInput.value = latitude.toFixed(7);
        elements.testLongitudeInput.value = state.home.longitude.toFixed(7);
        if (state.monitoring && state.testMode) updateTestLocation();
    }

    function updateTestLocation() {
        if (!state.testMode) {
            setMessage("Enable Test Mode before submitting simulated coordinates.", true);
            return;
        }
        if (!state.monitoring) {
            setMessage("Start monitoring in Test Mode before updating a simulated position.", true);
            return;
        }
        const latitude = Number(elements.testLatitudeInput.value);
        const longitude = Number(elements.testLongitudeInput.value);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
            || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            setMessage("Enter valid simulated child coordinates before updating.", true);
            return;
        }
        updateChildLocation({ latitude, longitude, accuracy: 0 }, "test");
        elements.gpsIndicator.innerHTML = '<span class="status-dot"></span> TEST LOCATION ACTIVE';
        setMessage("Simulated child location updated. Test mode does not change the real GPS default.");
    }

    async function loadServerStatus() {
        try {
            const serverState = await apiRequest("/api/status");
            if (serverState.alert_history && serverState.alert_history.length) {
                elements.alertHistory.replaceChildren();
                for (const alert of serverState.alert_history) {
                    addHistoryItem({
                        distance: alert.distance,
                        detectedAt: alert.detected_at,
                        acknowledged: alert.acknowledged
                    });
                }
                if (serverState.latest_alert) state.latestAlertId = serverState.latest_alert.id;
            }
        } catch (error) {
            reportApiError(error);
        }
    }

    function initialize() {
        initializeMap();
        elements.safeRadiusInput.addEventListener("input", (event) => updateRadius(event.target.value));
        elements.customRadiusInput.addEventListener("change", (event) => updateRadius(event.target.value));
        document.querySelectorAll("[data-radius]").forEach((button) => {
            button.addEventListener("click", () => updateRadius(button.dataset.radius));
        });
        elements.setCurrentHomeButton.addEventListener("click", setCurrentHomeFromGps);
        elements.setManualHomeButton.addEventListener("click", setManualHomeFromInputs);
        elements.startMonitoringButton.addEventListener("click", startMonitoring);
        elements.stopMonitoringButton.addEventListener("click", stopMonitoring);
        elements.toggleTestModeButton.addEventListener("click", enableTestMode);
        elements.insideTestButton.addEventListener("click", () => placeTestPosition(Math.max(0, state.radius - 50)));
        elements.outsideTestButton.addEventListener("click", () => placeTestPosition(state.radius + 50));
        elements.updateTestLocationButton.addEventListener("click", updateTestLocation);
        elements.acknowledgeButton.addEventListener("click", acknowledgeAlert);
        elements.viewChildButton.addEventListener("click", () => {
            elements.emergencyAlert.hidden = true;
            if (state.map && state.child) {
                state.map.setView([state.child.latitude, state.child.longitude], 18);
                elements.map.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        });
        window.addEventListener("resize", () => {
            if (state.map) state.map.invalidateSize();
        });
        loadServerStatus();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
    else initialize();
})();
