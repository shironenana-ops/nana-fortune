import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from email.parser import BytesParser
from email.policy import default

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
s3 = boto3.client("s3")
transcribe = boto3.client("transcribe")

HISTORY_TABLE_NAME = os.environ.get("HISTORY_TABLE", "shirone7_history")
USERS_TABLE_NAME = os.environ.get("USERS_TABLE_NAME", "shirone7_users")
VOICE_BUCKET = os.environ.get("VOICE_BUCKET", "")

history_table = dynamodb.Table(HISTORY_TABLE_NAME)
users_table = dynamodb.Table(USERS_TABLE_NAME)

MAX_FILE_SIZE = 20 * 1024 * 1024
ALLOWED_EXTENSIONS = {"mp3", "wav", "m4a", "mp4", "webm", "ogg"}
MEDIA_FORMAT_BY_EXT = {
    "mp3": "mp3",
    "wav": "wav",
    "m4a": "mp4",
    "mp4": "mp4",
    "webm": "webm",
    "ogg": "ogg",
}


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def get_method(event):
    return (
        event.get("requestContext", {})
        .get("http", {})
        .get("method")
        or event.get("httpMethod")
        or ""
    ).upper()


def safe_str(value):
    if value is None:
        return ""
    return str(value).strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def get_header(headers, name):
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value or ""
    return ""


def get_session_secret():
    secret = os.environ.get("SESSION_TOKEN_SECRET")
    if not secret:
        raise RuntimeError("SESSION_TOKEN_SECRET is not configured")
    return secret


def b64url_decode(value):
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def unauthorized_response():
    return response(401, {
        "ok": False,
        "message": "unauthorized",
    })


def verify_session_token(event):
    secret = get_session_secret()

    authorization = get_header(event.get("headers") or {}, "Authorization")
    if not authorization.startswith("Bearer "):
        raise PermissionError("unauthorized")

    token = authorization.replace("Bearer ", "", 1).strip()

    if not token or len(token) > 4096:
        raise PermissionError("unauthorized")

    if token.count(".") != 1:
        raise PermissionError("unauthorized")

    payload_part, signature_part = token.split(".", 1)

    try:
        expected_signature = hmac.new(
            secret.encode("utf-8"),
            payload_part.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        actual_signature = b64url_decode(signature_part)
    except (binascii.Error, ValueError):
        raise PermissionError("unauthorized")

    if not hmac.compare_digest(expected_signature, actual_signature):
        raise PermissionError("unauthorized")

    try:
        payload_raw = b64url_decode(payload_part)
        payload = json.loads(payload_raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise PermissionError("unauthorized")
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise PermissionError("unauthorized")

    user_id = payload.get("user_id")
    iat = payload.get("iat")
    exp = payload.get("exp")

    if not isinstance(user_id, str) or not user_id:
        raise PermissionError("unauthorized")

    if type(iat) is not int or type(exp) is not int:
        raise PermissionError("unauthorized")

    if exp < int(time.time()):
        raise PermissionError("unauthorized")

    return payload


def to_int(value, default=0):
    if isinstance(value, Decimal):
        return int(value)

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_key_segment(value):
    segment = re.sub(r"[^A-Za-z0-9_.@=-]+", "_", safe_str(value))
    return segment[:160] or "user"


def get_request_body_bytes(event):
    body = event.get("body")
    if body is None:
        return b""

    if event.get("isBase64Encoded"):
        return base64.b64decode(body)

    if isinstance(body, str):
        return body.encode("utf-8")

    if isinstance(body, bytes):
        return body

    return b""


def parse_multipart(event):
    content_type = get_header(event.get("headers") or {}, "Content-Type")
    if not content_type.lower().startswith("multipart/form-data"):
        raise ValueError("multipart/form-data is required")

    body_bytes = get_request_body_bytes(event)
    message_bytes = (
        f"Content-Type: {content_type}\r\n"
        "MIME-Version: 1.0\r\n"
        "\r\n"
    ).encode("utf-8") + body_bytes
    message = BytesParser(policy=default).parsebytes(message_bytes)

    fields = {}
    file_info = None

    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue

        name = part.get_param("name", header="content-disposition")
        if not name:
            continue

        payload = part.get_payload(decode=True) or b""
        filename = safe_str(part.get_filename())

        if name == "file" and filename:
            file_info = {
                "filename": filename,
                "content_type": safe_str(part.get_content_type()),
                "bytes": payload,
            }
        else:
            charset = part.get_content_charset() or "utf-8"
            try:
                fields[name] = payload.decode(charset)
            except UnicodeDecodeError:
                fields[name] = payload.decode("utf-8", errors="replace")

    if not file_info or not file_info["bytes"]:
        raise ValueError("file is required")

    return fields, file_info


def extension_from_file(file_info, fields):
    filename = file_info.get("filename") or ""
    ext = os.path.splitext(filename)[1].lower().lstrip(".")

    if not ext:
        mime_type = safe_str(fields.get("mime_type") or file_info.get("content_type")).lower()
        if "mpeg" in mime_type or "mp3" in mime_type:
            ext = "mp3"
        elif "wav" in mime_type:
            ext = "wav"
        elif "mp4" in mime_type or "m4a" in mime_type:
            ext = "m4a"
        elif "webm" in mime_type:
            ext = "webm"
        elif "ogg" in mime_type:
            ext = "ogg"

    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError("unsupported audio format")

    return ext


def check_voice_quota(user_id):
    result = users_table.get_item(Key={"user_id": user_id})
    user = result.get("Item") or {}

    plan = safe_str(user.get("plan") or "free").lower() or "free"
    subscription_status = safe_str(user.get("subscription_status") or "inactive").lower()
    monthly_voice_limit = to_int(user.get("monthly_voice_limit"), 0)
    monthly_voice_used = to_int(user.get("monthly_voice_used"), 0)
    extra_voice_remaining = to_int(user.get("extra_voice_remaining"), 0)

    voice_remaining = max(monthly_voice_limit - monthly_voice_used, 0) + max(extra_voice_remaining, 0)
    allowed = voice_remaining > 0

    return {
        "allowed": allowed,
        "plan": plan,
        "subscription_status": subscription_status,
        "monthly_voice_limit": monthly_voice_limit,
        "monthly_voice_used": monthly_voice_used,
        "extra_voice_remaining": extra_voice_remaining,
        "voice_remaining": voice_remaining,
        "upgrade_target": "premium" if plan in {"free", "normal"} else "",
    }


def quota_denied_response(quota):
    return response(403, {
        "ok": False,
        "message": "音声鑑定の利用上限に達しました",
        "subscription": {
            "plan": quota["plan"],
            "subscription_status": quota["subscription_status"],
            "monthly_voice_limit": quota["monthly_voice_limit"],
            "monthly_voice_used": quota["monthly_voice_used"],
            "extra_voice_remaining": quota["extra_voice_remaining"],
            "voice_remaining": quota["voice_remaining"],
            "upgrade_target": quota["upgrade_target"] or "premium",
        },
        "ui": {
            "show_upgrade": True,
        },
    })


def build_history_item(fields, user_id, history_id, job_id, keys, file_info, quota):
    timestamp = now_iso()
    title = safe_str(fields.get("title")) or "音声鑑定"
    category = safe_str(fields.get("category")) or "general"
    memo = safe_str(fields.get("memo"))

    item = {
        "user_id": user_id,
        "history_id": history_id,
        "type": "voice",
        "source": safe_str(fields.get("source")) or "premium_voice",
        "title": title,
        "input_title": title,
        "category": category,
        "memo": memo,
        "status": "processing",
        "created_at": timestamp,
        "updated_at": timestamp,
        "audio_s3_key": keys["audio_s3_key"],
        "transcript_s3_key": keys["transcript_s3_key"],
        "result_s3_key": keys["result_s3_key"],
        "history_bucket": VOICE_BUCKET,
        "job_id": job_id,
        "transcribe_job_name": job_id,
        "audio_source_type": safe_str(fields.get("audio_source_type")) or "unknown",
        "mime_type": safe_str(fields.get("mime_type") or file_info.get("content_type")),
        "file_size": to_int(fields.get("file_size"), len(file_info["bytes"])),
        "transcribe_started": False,
        "plan": quota["plan"],
    }

    duration_sec = safe_str(fields.get("duration_sec"))
    if duration_sec:
        item["duration_sec"] = to_int(duration_sec, 0)

    for field in ("name", "birth_date", "gender"):
        value = safe_str(fields.get(field))
        if value:
            item[field] = value

    return item


def start_transcribe_job(job_id, audio_s3_key, transcript_s3_key, media_format):
    transcribe.start_transcription_job(
        TranscriptionJobName=job_id,
        LanguageCode="ja-JP",
        MediaFormat=media_format,
        Media={
            "MediaFileUri": f"s3://{VOICE_BUCKET}/{audio_s3_key}",
        },
        OutputBucketName=VOICE_BUCKET,
        OutputKey=transcript_s3_key,
    )


def lambda_handler(event, context):
    logger.info("voice upload request started")

    method = get_method(event)

    if method == "OPTIONS":
        return response(200, {"ok": True})

    if method != "POST":
        return response(405, {
            "ok": False,
            "message": "Method Not Allowed",
        })

    try:
        try:
            payload = verify_session_token(event)
        except PermissionError:
            logger.info("voice upload unauthorized")
            return unauthorized_response()
        except RuntimeError:
            logger.error("voice upload configuration error")
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        if not VOICE_BUCKET:
            logger.error("voice upload configuration error")
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        user_id = payload["user_id"]
        fields, file_info = parse_multipart(event)

        if len(file_info["bytes"]) > MAX_FILE_SIZE:
            return response(400, {
                "ok": False,
                "message": "音声ファイルのサイズが大きすぎます",
            })

        quota = check_voice_quota(user_id)
        if not quota["allowed"]:
            return quota_denied_response(quota)

        ext = extension_from_file(file_info, fields)
        media_format = MEDIA_FORMAT_BY_EXT.get(ext, ext)
        short_id = uuid.uuid4().hex[:12]
        history_id = f"voice-{uuid.uuid4().hex}"
        job_id = f"shirone7-{uuid.uuid4().hex}"
        date_prefix = datetime.now(timezone.utc).strftime("%Y/%m/%d")
        user_segment = safe_key_segment(user_id)

        audio_s3_key = f"raw/member/{date_prefix}/{user_segment}/{short_id}.{ext}"
        transcript_s3_key = f"transcript/member/{short_id}.json"
        result_s3_key = f"result/member/{short_id}.json"

        s3.put_object(
            Bucket=VOICE_BUCKET,
            Key=audio_s3_key,
            Body=file_info["bytes"],
            ContentType=file_info.get("content_type") or "application/octet-stream",
            Metadata={
                "user_id": user_id,
                "history_id": history_id,
                "source": "premium_voice",
            },
        )

        keys = {
            "audio_s3_key": audio_s3_key,
            "transcript_s3_key": transcript_s3_key,
            "result_s3_key": result_s3_key,
        }
        item = build_history_item(fields, user_id, history_id, job_id, keys, file_info, quota)

        transcribe_started = False
        try:
            start_transcribe_job(job_id, audio_s3_key, transcript_s3_key, media_format)
            transcribe_started = True
            item["transcribe_started"] = True
            item["status"] = "processing"
        except ClientError:
            logger.error("Transcribe start failed")
            item["status"] = "failed"
            item["transcribe_started"] = False

        history_table.put_item(Item=item)

        logger.info("voice upload completed")

        return response(200, {
            "ok": True,
            "message": "音声鑑定を受け付けました",
            "history_id": history_id,
            "job_id": job_id,
            "status": item["status"],
            "audio_s3_key": audio_s3_key,
            "transcribe_started": transcribe_started,
            "quota": {
                "plan": quota["plan"],
                "monthly_voice_limit": quota["monthly_voice_limit"],
                "monthly_voice_used": quota["monthly_voice_used"],
                "extra_voice_remaining": quota["extra_voice_remaining"],
                "voice_remaining": quota["voice_remaining"],
            },
        })

    except ValueError as e:
        message = str(e) if str(e) in {"file is required", "multipart/form-data is required", "unsupported audio format"} else "upload request is invalid"
        return response(400, {
            "ok": False,
            "message": message,
        })

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error("ClientError: %s", error_code)

        return response(500, {
            "ok": False,
            "message": "音声アップロードに失敗しました",
        })

    except Exception:
        logger.error("ERROR: voice upload failed")

        return response(500, {
            "ok": False,
            "message": "音声アップロードに失敗しました",
        })
