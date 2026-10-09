"""TRINETRA child geofencing prototype."""

from datetime import datetime, timezone
import math
import threading

from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.dispatcher import DispatcherMiddleware

app = Flask(__name__)

state_lock = threading.Lock()
monitoring_state = {
    "monitoring": False,
    "child_location": None,
    "latest_alert": None,
    "alert_history": [],
    "next_alert_id": 1,
}
assist_state = {
    "requests": [],
    "next_request_id": 1,
}


class LazyElderlyApplication:
    def __init__(self):
        self._application = None
        self._lock = threading.Lock()

    def __call__(self, environ, start_response):
        if self._application is None:
            with self._lock:
                if self._application is None:
                    from app10 import app as elderly_app

                    self._application = elderly_app
        return self._application(environ, start_response)


def current_time():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_number(value, field, minimum, maximum):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number.") from None
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}.")
    return number


@app.get("/")
def home():
    return render_template("landing.html")


@app.get("/child")
def child_safety():
    return render_template("index.html")


@app.get("/assist")
def physical_assistance():
    return render_template("assist.html")


def create_assistance_request(payload, forced_category=None):
    if not isinstance(payload, dict):
        return jsonify(error="Expected a JSON assistance request."), 400

    user = payload.get("user")
    message = payload.get("message")
    category = forced_category or payload.get("category")
    categories = {
        "normal": ("NORMAL", "NORMAL ASSISTANCE"),
        "urgent": ("URGENT", "URGENT ASSISTANCE"),
        "emergency": ("EMERGENCY", "EMERGENCY"),
        "check_in": ("CHECK-IN", "SAFETY CHECK-IN"),
    }
    if not isinstance(user, str) or not user.strip() or len(user.strip()) > 80:
        return jsonify(error="Enter a name between 1 and 80 characters."), 400
    if not isinstance(message, str) or not message.strip() or len(message.strip()) > 500:
        return jsonify(error="Request text must be between 1 and 500 characters."), 400
    if category not in categories:
        return jsonify(error="Request category must be normal, urgent, emergency, or check_in."), 400

    location = payload.get("location")
    saved_location = None
    if location is not None:
        if not isinstance(location, dict):
            return jsonify(error="Location must contain latitude and longitude."), 400
        try:
            latitude = parse_number(location.get("latitude"), "latitude", -90, 90)
            longitude = parse_number(location.get("longitude"), "longitude", -180, 180)
            accuracy = parse_number(location.get("accuracy", 0), "accuracy", 0, 100000)
        except ValueError as error:
            return jsonify(error=str(error)), 400
        saved_location = {
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": accuracy,
        }

    with state_lock:
        category_label, severity = categories[category]
        assistance_request = {
            "id": assist_state["next_request_id"],
            "user": user.strip(),
            "message": message.strip(),
            "category": category_label,
            "severity": severity,
            "location": saved_location,
            "timestamp": current_time(),
            "status": "PENDING",
        }
        assist_state["next_request_id"] += 1
        assist_state["requests"].insert(0, assistance_request)
        del assist_state["requests"][100:]
    return jsonify(request=assistance_request), 201


@app.get("/api/assist/requests")
def get_assistance_requests():
    with state_lock:
        return jsonify(requests=assist_state["requests"])


@app.post("/api/assist/request")
def submit_assistance_request():
    return create_assistance_request(request.get_json(silent=True))


@app.post("/api/assist/emergency")
def submit_emergency_request():
    return create_assistance_request(request.get_json(silent=True), "emergency")


@app.post("/api/assist/check-in")
def submit_safety_check_in():
    return create_assistance_request(request.get_json(silent=True), "check_in")


@app.post("/api/assist/requests/<int:request_id>/acknowledge")
def acknowledge_assistance_request(request_id):
    with state_lock:
        for assistance_request in assist_state["requests"]:
            if assistance_request["id"] == request_id:
                assistance_request["status"] = "ACKNOWLEDGED"
                return jsonify(request=assistance_request)
    return jsonify(error="Assistance request not found."), 404


@app.get("/api/status")
def get_status():
    with state_lock:
        return jsonify(
            monitoring=monitoring_state["monitoring"],
            child_location=monitoring_state["child_location"],
            latest_alert=monitoring_state["latest_alert"],
            alert_history=monitoring_state["alert_history"],
        )


@app.post("/api/monitoring")
def set_monitoring():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("monitoring"), bool):
        return jsonify(error="Expected a JSON boolean named monitoring."), 400
    with state_lock:
        monitoring_state["monitoring"] = payload["monitoring"]
    return jsonify(monitoring=payload["monitoring"])


@app.post("/api/location")
def update_location():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Expected a JSON location object."), 400
    try:
        latitude = parse_number(payload.get("latitude"), "latitude", -90, 90)
        longitude = parse_number(payload.get("longitude"), "longitude", -180, 180)
        accuracy = parse_number(payload.get("accuracy", 0), "accuracy", 0, 100000)
        radius = parse_number(payload.get("safe_radius", 100), "safe_radius", 1, 10000)
        distance = payload.get("distance")
        if distance is not None:
            distance = parse_number(distance, "distance", 0, 30000000)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    location = {
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy,
        "distance": distance,
        "safe_radius": radius,
        "status": payload.get("status") if payload.get("status") in ("SAFE", "OUTSIDE") else None,
        "mode": payload.get("mode") if payload.get("mode") in ("gps", "test") else "gps",
        "updated_at": current_time(),
    }
    with state_lock:
        monitoring_state["child_location"] = location
    return jsonify(ok=True, child_location=location)


@app.post("/api/alerts")
def record_alert():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Expected a JSON alert object."), 400
    try:
        distance = parse_number(payload.get("distance"), "distance", 0, 30000000)
        safe_radius = parse_number(payload.get("safe_radius"), "safe_radius", 1, 10000)
        latitude = parse_number(payload.get("latitude"), "latitude", -90, 90)
        longitude = parse_number(payload.get("longitude"), "longitude", -180, 180)
        home_latitude = parse_number(payload.get("home_latitude"), "home_latitude", -90, 90)
        home_longitude = parse_number(payload.get("home_longitude"), "home_longitude", -180, 180)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    with state_lock:
        alert = {
            "id": monitoring_state["next_alert_id"],
            "distance": distance,
            "safe_radius": safe_radius,
            "latitude": latitude,
            "longitude": longitude,
            "home_latitude": home_latitude,
            "home_longitude": home_longitude,
            "detected_at": current_time(),
            "acknowledged": False,
        }
        monitoring_state["next_alert_id"] += 1
        monitoring_state["latest_alert"] = alert
        monitoring_state["alert_history"].insert(0, alert)
        del monitoring_state["alert_history"][20:]
    return jsonify(alert=alert), 201


@app.post("/api/alerts/<int:alert_id>/acknowledge")
def acknowledge_alert(alert_id):
    with state_lock:
        for alert in monitoring_state["alert_history"]:
            if alert["id"] == alert_id:
                alert["acknowledged"] = True
                if monitoring_state["latest_alert"]["id"] == alert_id:
                    monitoring_state["latest_alert"] = alert
                return jsonify(alert=alert)
    return jsonify(error="Alert not found."), 404


if __name__ == "__main__":
    app.wsgi_app = DispatcherMiddleware(
        app.wsgi_app,
        {"/elderly": LazyElderlyApplication()},
    )
    print("TRINETRA Safety is ready at http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
