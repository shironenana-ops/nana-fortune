import base64
import hashlib
import hmac
import json
import sys
import time


def b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def b64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create(payload, secret):
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_part = b64url_encode(payload_json)
    signature = hmac.new(secret.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    return payload_part + "." + b64url_encode(signature)


def verify(token, secret):
    if token.count(".") != 1:
        return False
    payload_part, signature_part = token.split(".", 1)
    expected = hmac.new(secret.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    try:
        actual = b64url_decode(signature_part)
        payload = json.loads(b64url_decode(payload_part).decode("utf-8"))
    except Exception:
        return False
    return (
        hmac.compare_digest(expected, actual)
        and isinstance(payload, dict)
        and isinstance(payload.get("user_id"), str)
        and bool(payload.get("user_id"))
        and type(payload.get("iat")) is int
        and type(payload.get("exp")) is int
        and payload["exp"] >= int(time.time())
    )


request = json.load(sys.stdin)
if request["action"] == "create":
    print(create(request["payload"], request["secret"]))
elif request["action"] == "verify":
    print(json.dumps({"valid": verify(request["token"], request["secret"])}))
else:
    raise SystemExit(2)
