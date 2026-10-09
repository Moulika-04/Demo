import base64
import binascii
from collections import deque
from contextlib import contextmanager
import functools
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
import time

import cv2
import numpy as np
from flask import Flask, flash, jsonify, redirect, render_template, request, session, url_for

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024
app.config["SECRET_KEY"] = os.environ.get("TRINETRA_SECRET_KEY") or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("trinetra")

DATABASE_PATH = os.path.join(app.instance_path, "caregivers.sqlite3")
os.makedirs(app.instance_path, exist_ok=True)

hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

FALL_TIME_SECONDS = 0.6
FALL_DETECTION_GAP_SECONDS = 1.5
MIN_FALL_BOX_HEIGHT_RATIO = 0.16

state_lock = threading.Lock()
fall_start_time = None
last_fall_seen_time = None
movement_samples = deque()


@contextmanager
def get_database_connection():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database():
    with get_database_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS caregivers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


def normalize_phone(phone):
    phone = phone.strip()
    digits = re.sub(r"\D", "", phone)
    if not 7 <= len(digits) <= 15:
        return None
    return digits


def login_required(view):
    @functools.wraps(view)
    def wrapped_view(*args, **kwargs):
        if "caregiver_id" not in session:
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped_view


initialize_database()


def process_image(frame, video_time=None):
    global fall_start_time, last_fall_seen_time

    frame = cv2.resize(frame, (640, 480))
    output = frame.copy()
    boxes, weights = hog.detectMultiScale(
        frame,
        winStride=(8, 8),
        padding=(8, 8),
        scale=1.05,
    )

    upright_people = []
    for index, box in enumerate(boxes):
        x, y, width, height = (int(value) for value in box)
        confidence = float(weights[index]) if len(weights) > index else 0.0
        if confidence > 0.2:
            upright_people.append((x, y, width, height, confidence))

    rotated = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    rotated_boxes, rotated_weights = hog.detectMultiScale(
        rotated,
        winStride=(8, 8),
        padding=(8, 8),
        scale=1.05,
    )
    rotated_people = []
    for index, box in enumerate(rotated_boxes):
        x_rotated, y_rotated, width_rotated, height_rotated = (
            int(value) for value in box
        )
        confidence = (
            float(rotated_weights[index])
            if len(rotated_weights) > index
            else 0.0
        )
        if confidence <= 0.2:
            continue

        rotated_people.append(
            (
                y_rotated,
                frame.shape[0] - (x_rotated + width_rotated),
                height_rotated,
                width_rotated,
                confidence,
            )
        )

    def is_fall_candidate(person):
        _, y, width, height, _ = person
        return (
            width / float(max(height, 1)) > 1.10
            and y + height > output.shape[0] * 0.60
            and height >= output.shape[0] * MIN_FALL_BOX_HEIGHT_RATIO
        )

    fall_candidates = [
        person for person in rotated_people if is_fall_candidate(person)
    ]
    people = upright_people or rotated_people
    if fall_candidates:
        selected_person = max(
            fall_candidates, key=lambda person: person[2] * person[3]
        )
    elif upright_people:
        selected_person = max(
            upright_people, key=lambda person: person[2] * person[3]
        )
    elif rotated_people:
        selected_person = max(
            rotated_people, key=lambda person: person[2] * person[3]
        )

    if not people:
        now = time.monotonic()
        with state_lock:
            while movement_samples and now - movement_samples[0][0] > 1.5:
                movement_samples.popleft()
            fall_now = now if video_time is None else video_time
            recent_fall = (
                fall_start_time is not None
                and last_fall_seen_time is not None
                and fall_now - last_fall_seen_time <= FALL_DETECTION_GAP_SECONDS
            )
            if recent_fall and fall_now - fall_start_time >= FALL_TIME_SECONDS:
                status = "LYING"
                alert = True
            elif recent_fall:
                status = "CHECKING FALL"
                alert = False
            else:
                fall_start_time = None
                last_fall_seen_time = None
                status = "NO PERSON"
                alert = False

        if alert:
            cv2.rectangle(
                output,
                (0, 0),
                (output.shape[1] - 1, output.shape[0] - 1),
                (0, 0, 255),
                8,
            )
            cv2.putText(
                output,
                "LYING - FALL ALERT",
                (20, 50),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 0, 255),
                3,
            )
            return output, status, 0, alert

        cv2.putText(
            output,
            status if status == "CHECKING FALL" else "NO PERSON DETECTED",
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 0, 255),
            2,
        )
        return output, status, 0, alert

    x, y, width, height, _ = selected_person
    cv2.rectangle(
        output,
        (x, y),
        (x + width, y + height),
        (0, 255, 0),
        3,
    )

    ratio = width / float(max(height, 1))
    possible_fall = is_fall_candidate((x, y, width, height, 0.0))
    now = time.monotonic()
    alert = False

    with state_lock:
        fall_now = now if video_time is None else video_time
        center_x = x + width / 2
        center_y = y + height / 2
        movement_samples.append((now, center_x, center_y))
        while movement_samples and now - movement_samples[0][0] > 1.5:
            movement_samples.popleft()
        walking = (
            len(movement_samples) >= 2
            and (center_x - movement_samples[0][1]) ** 2
            + (center_y - movement_samples[0][2]) ** 2
            >= 30**2
        )

        if possible_fall:
            if (
                fall_start_time is None
                or last_fall_seen_time is None
                or fall_now - last_fall_seen_time > FALL_DETECTION_GAP_SECONDS
            ):
                fall_start_time = fall_now
            last_fall_seen_time = fall_now
            alert = fall_now - fall_start_time >= FALL_TIME_SECONDS
            status = "LYING" if alert else "CHECKING FALL"
        else:
            fall_start_time = None
            last_fall_seen_time = None
            if walking:
                status = "WALKING"
            elif 0.70 <= ratio <= 1.10:
                status = "SITTING / BENDING"
            else:
                status = "STANDING"

    if alert:
        cv2.rectangle(
            output,
            (0, 0),
            (output.shape[1] - 1, output.shape[0] - 1),
            (0, 0, 255),
            8,
        )
        cv2.putText(
            output,
            "LYING - FALL ALERT",
            (20, 50),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 0, 255),
            3,
        )
    else:
        color = (0, 165, 255) if status == "CHECKING FALL" else (0, 255, 0)
        cv2.putText(
            output,
            status,
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            color,
            2,
        )

    return output, status, len(people), alert


def assess_risk(status, people, alert):
    if alert:
        return "HIGH", "Possible fall detected. Check on the person immediately."
    if status == "CHECKING FALL":
        return "MODERATE", "Fall-like posture detected. Confirming whether the person has fallen."
    if status == "SITTING / BENDING":
        return "LOW", "Person is sitting or bending. No fall has been detected."
    if status in ("STANDING", "WALKING"):
        return "LOW", f"Person is {status.lower()}. No fall has been detected."
    if status == "LYING":
        return "MODERATE", "Person is lying down. Confirm they are resting safely."
    if people == 0:
        return "UNKNOWN", "Person not detected. Check the camera view and monitoring area."
    return "UNKNOWN", "Movement is being assessed."


@app.route("/")
@login_required
def home():
    return render_template(
        "elder frontend.html",
        caregiver_name=session["caregiver_name"],
        caregiver_phone=session["caregiver_phone"],
    )


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        phone = normalize_phone(request.form.get("phone", ""))
        if not name or len(name) > 80:
            flash("Enter a caregiver name between 1 and 80 characters.", "error")
        elif phone is None:
            flash("Enter a phone number containing 7 to 15 digits.", "error")
        else:
            try:
                with get_database_connection() as connection:
                    connection.execute(
                        "INSERT INTO caregivers (name, phone) VALUES (?, ?)",
                        (name, phone),
                    )
                flash("Caregiver account created. Log in to continue.", "success")
                return redirect(url_for("login"))
            except sqlite3.IntegrityError:
                flash("An account with that phone number already exists. Please log in.", "error")

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if "caregiver_id" in session:
        return redirect(url_for("home"))

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        phone = normalize_phone(request.form.get("phone", ""))
        if not name or phone is None:
            flash("Enter the name and a valid phone number used during sign-up.", "error")
        else:
            with get_database_connection() as connection:
                caregiver = connection.execute(
                    "SELECT id, name, phone FROM caregivers "
                    "WHERE lower(name) = lower(?) AND phone = ?",
                    (name, phone),
                ).fetchone()
            if caregiver is None:
                flash("No matching caregiver account. Check the details or sign up.", "error")
            else:
                session.clear()
                session["caregiver_id"] = caregiver["id"]
                session["caregiver_name"] = caregiver["name"]
                session["caregiver_phone"] = caregiver["phone"]
                return redirect(url_for("home"))

    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/reset_monitoring", methods=["POST"])
@login_required
def reset_monitoring():
    global fall_start_time, last_fall_seen_time

    with state_lock:
        fall_start_time = None
        last_fall_seen_time = None
        movement_samples.clear()
    return jsonify(success=True)


@app.route("/process_frame", methods=["POST"])
@login_required
def process_frame():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("image"), str):
        return jsonify(success=False, error="A base64 image field is required."), 400

    video_time = payload.get("video_time")
    if video_time is not None and (
        isinstance(video_time, bool)
        or not isinstance(video_time, (int, float))
        or not math.isfinite(video_time)
        or video_time < 0
    ):
        return jsonify(success=False, error="The video timestamp must be a non-negative number."), 400

    image_data = payload["image"]
    if image_data.startswith("data:image/") and "," in image_data:
        image_data = image_data.split(",", 1)[1]
    if not image_data or len(image_data) > 2_500_000:
        return jsonify(success=False, error="The image is empty or too large."), 413

    try:
        image_bytes = base64.b64decode(image_data, validate=True)
    except (binascii.Error, ValueError):
        return jsonify(success=False, error="The image is not valid base64."), 400

    frame = cv2.imdecode(
        np.frombuffer(image_bytes, dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    if frame is None:
        return jsonify(success=False, error="OpenCV could not decode the image."), 400

    try:
        output, status, people, alert = process_image(frame, video_time)
        risk_level, risk_insight = assess_risk(status, people, alert)
        encoded_ok, buffer = cv2.imencode(".jpg", output)
        if not encoded_ok:
            raise RuntimeError("OpenCV could not encode the processed frame.")
    except Exception:
        logger.exception("Could not process the submitted camera frame.")
        return jsonify(success=False, error="Could not process the camera frame."), 500

    encoded = base64.b64encode(buffer).decode("ascii")
    return jsonify(
        success=True,
        image=encoded,
        status=status,
        people=people,
        alert=alert,
        risk_level=risk_level,
        risk_insight=risk_insight,
    )


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(success=False, error="The submitted image is too large."), 413


if __name__ == "__main__":
    port = int(os.environ.get("TRINETRA_PORT", "5000"))
    print(f"TRINETRA is ready at http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
