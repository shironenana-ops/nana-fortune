# C:\Users\kokur\nana-fortune\lambda\lambda_function.py
# -*- coding: utf-8 -*-

import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Dict, Any, Optional

import boto3
from botocore.exceptions import ClientError

# =========================
# AWS Clients / Resources
# =========================
s3 = boto3.client("s3")
transcribe = boto3.client("transcribe")
bedrock_runtime = boto3.client("bedrock-runtime")
dynamodb = boto3.resource("dynamodb")


# =========================
# Environment Variables
# =========================
RESULT_BUCKET = (
    os.environ.get("RESULT_BUCKET")
    or os.environ.get("VOICE_BUCKET")
    or os.environ.get("BUCKET_NAME")
    or ""
)
METHOD_KEY = os.environ.get("METHOD_KEY", "")

MODEL_ID = os.environ.get("MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")
HISTORY_TABLE_NAME = (
    os.environ.get("HISTORY_TABLE")
    or os.environ.get("HISTORY_TABLE_NAME")
    or "shirone7_history"
)
USERS_TABLE_NAME = os.environ.get("USERS_TABLE_NAME", "shirone7_users")

history_table = dynamodb.Table(HISTORY_TABLE_NAME)
users_table = dynamodb.Table(USERS_TABLE_NAME)


# =========================
# Constants
# =========================
TIERS = {
    "free": {"min_chars": 50, "max_chars": 100},
    "member": {"min_chars": 200, "max_chars": 400},
    "deep": {"min_chars": 1000, "max_chars": 2000},
}

ALLOWED_TAGS = {"仕事", "恋愛", "人間関係", "家族", "お金", "健康", "不安", "その他"}
ALLOWED_MEDIA_FORMATS = {"mp3", "mp4", "wav", "flac", "ogg", "amr", "webm", "m4a"}


# =========================
# Utility
# =========================
def get_tier_from_key(key: str) -> str:
    parts = key.split("/")
    if len(parts) >= 2 and parts[0] in {"raw", "transcript", "result"}:
        tier = parts[1]
        if tier in TIERS:
            return tier
    return "free"


def read_method_text() -> str:
    default_method = "白音七として、相談者の言葉を静かに受け止め、今日の流れと次の一歩をやさしく示してください。"

    if not RESULT_BUCKET or not METHOD_KEY:
        return default_method

    try:
        obj = s3.get_object(Bucket=RESULT_BUCKET, Key=METHOD_KEY)
        return obj["Body"].read().decode("utf-8")
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code", "")
        print(f"method text unavailable: {error_code}")
        return default_method


def wait_transcribe(job_name: str, timeout_sec: int = 600) -> dict:
    start = time.time()

    while True:
        res = transcribe.get_transcription_job(TranscriptionJobName=job_name)
        status = res["TranscriptionJob"]["TranscriptionJobStatus"]
        print(f"transcribe job={job_name} status={status}")

        if status in ["COMPLETED", "FAILED"]:
            return res

        if time.time() - start > timeout_sec:
            raise TimeoutError("Transcribe job timed out")

        time.sleep(5)


def fetch_transcript_text_from_s3(bucket: str, key: str) -> str:
    obj = s3.get_object(Bucket=bucket, Key=key)
    data = json.loads(obj["Body"].read().decode("utf-8"))
    return data["results"]["transcripts"][0]["transcript"]


def load_json_from_s3(bucket: str, key: str) -> Dict[str, Any]:
    obj = s3.get_object(Bucket=bucket, Key=key)
    data = json.loads(obj["Body"].read().decode("utf-8"))

    if not isinstance(data, dict):
        raise ValueError("json object is required")

    return data


def extract_transcript_text(data: Dict[str, Any]) -> str:
    try:
        text = data["results"]["transcripts"][0]["transcript"]
    except (KeyError, IndexError, TypeError):
        text = ""

    text = str(text or "").strip()
    if not text:
        raise ValueError("transcript text is empty")

    return text


def extract_transcribe_job_name(data: Dict[str, Any]) -> str:
    return str(data.get("jobName") or data.get("job_name") or "").strip()


def is_target_transcript_key(key: str) -> bool:
    return key.startswith("transcript/member/") and key.endswith(".json")


def result_key_from_transcript_key(key: str, item: Optional[Dict[str, Any]] = None) -> str:
    if item:
        result_s3_key = str(item.get("result_s3_key") or "").strip()
        if result_s3_key:
            return result_s3_key

    return key.replace("transcript/", "result/", 1)


def scan_first_history_item(label: str, filter_expression: str, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    scan_kwargs = {
        "FilterExpression": filter_expression,
        "ExpressionAttributeValues": values,
    }
    page = 0
    total_scanned = 0
    total_count = 0

    while True:
        page += 1
        response = history_table.scan(**scan_kwargs)
        scanned_count = response.get("ScannedCount", 0)
        count = response.get("Count", 0)
        total_scanned += scanned_count
        total_count += count
        print(f"history lookup {label} scan page={page} scanned={scanned_count} count={count}")

        items = response.get("Items") or []

        if items:
            print(f"history lookup {label} scan total_scanned={total_scanned} total_count={total_count}")
            return items[0]

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            print(f"history lookup {label} scan total_scanned={total_scanned} total_count={total_count}")
            return None

        scan_kwargs["ExclusiveStartKey"] = last_key


def find_history_item_by_transcript_key(
    transcript_key: str,
    transcribe_job_name: str = "",
) -> Optional[Dict[str, Any]]:
    basename_with_ext = transcript_key.rsplit("/", 1)[-1]
    basename = basename_with_ext.rsplit(".", 1)[0]

    print(f"history lookup table={HISTORY_TABLE_NAME}")
    print(f"history lookup transcript_key={transcript_key}")
    print(f"history lookup basename={basename}")
    print("history lookup transcribe_job_name_present=" + ("yes" if transcribe_job_name else "no"))

    item = scan_first_history_item(
        "exact",
        "transcript_s3_key = :transcript_s3_key",
        {
            ":transcript_s3_key": transcript_key,
        },
    )

    if item:
        print("history lookup exact=found")
        return item

    print("history lookup exact=not_found")

    item = scan_first_history_item(
        "basename",
        "contains(transcript_s3_key, :basename) OR contains(result_s3_key, :basename)",
        {
            ":basename": basename,
        },
    )

    if item:
        print("history lookup fallback_basename=found")
        return item

    print("history lookup fallback_basename=not_found")

    if transcribe_job_name:
        item = scan_first_history_item(
            "transcribe_job_name",
            "transcribe_job_name = :transcribe_job_name",
            {
                ":transcribe_job_name": transcribe_job_name,
            },
        )

        if item:
            print("history lookup fallback_transcribe_job=found")
            return item

        print("history lookup fallback_transcribe_job=not_found")

    return None


def update_history_completed(item: Dict[str, Any], result_json: Dict[str, Any], result_key: str) -> None:
    user_id = str(item.get("user_id") or "").strip()
    history_id = str(item.get("history_id") or "").strip()

    if not user_id or not history_id:
        raise ValueError("history key is missing")

    now = datetime.now(timezone.utc).isoformat()
    summary = str(result_json.get("summary") or result_json.get("message") or "").strip()
    full_text = str(result_json.get("full_text") or "").strip()

    history_table.update_item(
        Key={
            "user_id": user_id,
            "history_id": history_id,
        },
        UpdateExpression=(
            "SET #status = :status, updated_at = :updated_at, completed_at = :completed_at, "
            "result_s3_key = :result_s3_key, history_s3_key = :history_s3_key, "
            "history_bucket = :history_bucket, #result = :result, summary = :summary, "
            "result_preview = :summary, result_text = :result_text"
        ),
        ExpressionAttributeNames={
            "#status": "status",
            "#result": "result",
        },
        ExpressionAttributeValues={
            ":status": "completed",
            ":updated_at": now,
            ":completed_at": now,
            ":result_s3_key": result_key,
            ":history_s3_key": result_key,
            ":history_bucket": RESULT_BUCKET,
            ":result": result_json,
            ":summary": summary,
            ":result_text": full_text,
        },
    )


def to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def consume_voice_quota(item: Dict[str, Any]) -> None:
    user_id = str(item.get("user_id") or "").strip()
    if not user_id:
        return

    try:
        response = users_table.get_item(Key={"user_id": user_id})
        user = response.get("Item") or {}
        monthly_voice_limit = to_int(user.get("monthly_voice_limit"), 0)
        monthly_voice_used = to_int(user.get("monthly_voice_used"), 0)
        extra_voice_remaining = to_int(user.get("extra_voice_remaining"), 0)

        if monthly_voice_used < monthly_voice_limit:
            users_table.update_item(
                Key={"user_id": user_id},
                UpdateExpression=(
                    "SET monthly_voice_used = if_not_exists(monthly_voice_used, :zero) + :one, "
                    "updated_at = :updated_at"
                ),
                ExpressionAttributeValues={
                    ":zero": 0,
                    ":one": 1,
                    ":updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            return

        if extra_voice_remaining > 0:
            users_table.update_item(
                Key={"user_id": user_id},
                UpdateExpression=(
                    "SET extra_voice_remaining = extra_voice_remaining - :one, "
                    "updated_at = :updated_at"
                ),
                ExpressionAttributeValues={
                    ":one": 1,
                    ":updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code", "")
        print(f"voice quota consume skipped: {error_code}")


def invoke_bedrock_text(
    prompt: str,
    max_tokens: int = 1200,
    temperature: float = 0.7,
    max_attempts: int = 6,
) -> str:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [
            {
                "role": "user",
                "content": prompt,
            }
        ],
    }

    last_error = None

    for attempt in range(1, max_attempts + 1):
        try:
            print(f"bedrock invoke attempt={attempt}/{max_attempts}")

            resp = bedrock_runtime.invoke_model(
                modelId=MODEL_ID,
                body=json.dumps(body).encode("utf-8"),
                contentType="application/json",
                accept="application/json",
            )

            payload = json.loads(resp["body"].read().decode("utf-8"))
            return "".join([c.get("text", "") for c in payload.get("content", [])]).strip()

        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            last_error = exc

            if error_code == "ThrottlingException":
                wait_sec = min(2 ** attempt, 30)
                print(f"bedrock throttled. sleeping {wait_sec}s before retry")
                time.sleep(wait_sec)
                continue

            raise

    raise RuntimeError(f"Bedrock invoke failed after retries: {last_error}")


def build_voice_fortune_context(
    transcript_text: str,
    title: str = "",
    category: str = "",
    memo: str = "",
    name: str = "",
    birth_date: str = "",
    gender: str = "",
) -> Dict[str, Any]:
    return {
        "engine_version": "voice_fortune_v0",
        "title": title,
        "category": category,
        "user_profile": {
            "name": name,
            "birth_date": birth_date,
            "gender": gender,
        },
        "transcript_text": transcript_text,
        "memo": memo,
        "reading_axes": [
            "今日の流れ",
            "内面の声",
            "今の選択",
            "次の一歩",
        ],
    }


def build_prompt(method_text: str, transcript: str, tier: str, context: Optional[Dict[str, Any]] = None) -> str:
    rule = TIERS[tier]
    voice_context = context or build_voice_fortune_context(transcript_text=transcript)
    voice_context_json = json.dumps(voice_context, ensure_ascii=False, indent=2)

    return f"""
あなたは占い師「白音七」です。以下の白音七メソッドと、ユーザーの音声文字起こしを元に占い文を作ってください。

# 白音七メソッド（遵守）
{method_text}

# ユーザーの相談（文字起こし）
{transcript}

# voice_fortune_v0 コンテキスト
{voice_context_json}

# 出力条件
- 日本語
- 断定しすぎず、寄り添う
- 文字数は {rule["min_chars"]}〜{rule["max_chars"]} 字
- その範囲を超えそうなら、自分で要約して範囲内に収める
- 必ず以下の順番で書く
  1) 今の状態（最初の1文で明確に）
  2) 今日からできる行動（具体的に1つ）
  3) ひと言の励まし（最後の1文で締める）
- 必ず段落を分ける
- 1段落は長くなりすぎないようにする
- 読みやすさを最優先する
- 音声内容に含まれる具体的な悩みやテーマがあれば、できるだけ自然に触れる
- 同じ意味の言い回しを繰り返しすぎない
- HTMLタグは使わない（<br>などは禁止）
- 同じ内容や表現を繰り返さない（重複は禁止）

# タグ候補
仕事
恋愛
人間関係
家族
お金
健康
不安
その他

# 最後の出力形式
- 占い本文を書いたあと、最後の1行に必ず次の形式でタグを書く
タグ：候補の中から1つだけ
- タグ行以外に説明は書かない

# JSON出力の厳守
- 以下のJSONオブジェクトだけを返す
- Markdownコードブロックは禁止
- ```jsonは禁止
- ```は禁止
- JSONの前後に説明文を書かない
- キーは summary, full_text, today_flow, outer_impression, action_hint の5つ
- すべて文字列で返す
""".strip()


def extract_tag_and_clean_text(text: str) -> tuple[str, str]:
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    tag = "その他"
    cleaned_lines = []

    for line in lines:
        if line.startswith("タグ："):
            candidate = line.replace("タグ：", "").strip()
            tag = candidate if candidate in ALLOWED_TAGS else "その他"
        else:
            cleaned_lines.append(line)

    cleaned_text = "\n\n".join(cleaned_lines)
    return tag, cleaned_text


def pick_message_and_advice(text: str) -> tuple[str, str]:
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]

    if not paragraphs:
        return "", ""

    message = paragraphs[0]
    advice = paragraphs[1] if len(paragraphs) >= 2 else paragraphs[0]

    return message, advice


def strip_markdown_json_fence(text: str) -> str:
    cleaned = text.strip()

    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].strip().lower() in {"```json", "```"}:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    return cleaned


def extract_json_object_text(text: str) -> str:
    cleaned = strip_markdown_json_fence(text)

    try:
        json.loads(cleaned)
        return cleaned
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")

    if start == -1 or end == -1 or end <= start:
        raise ValueError("json object not found")

    return cleaned[start:end + 1].strip()


def parse_bedrock_result_json(text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(extract_json_object_text(text))
    except (json.JSONDecodeError, ValueError, TypeError):
        return None

    if not isinstance(parsed, dict):
        return None

    return parsed


def normalize_result_text(value: str) -> str:
    return re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)


def normalize_result_strings(value: Any) -> Any:
    if isinstance(value, str):
        return normalize_result_text(value)

    if isinstance(value, list):
        return [normalize_result_strings(item) for item in value]

    if isinstance(value, dict):
        return {
            key: normalize_result_strings(item)
            for key, item in value.items()
        }

    return value


def build_result_json(tier: str, transcript: str, fortune_text: str) -> dict:
    parsed_result = parse_bedrock_result_json(fortune_text)
    if parsed_result:
        summary = str(parsed_result.get("summary") or "").strip()
        full_text = str(parsed_result.get("full_text") or "").strip()
        today_flow = str(parsed_result.get("today_flow") or "").strip()
        outer_impression = str(parsed_result.get("outer_impression") or "").strip()
        action_hint = str(parsed_result.get("action_hint") or "").strip()
        message = summary or full_text or today_flow
        advice = action_hint or today_flow or summary

        return {
            "status": "ok",
            "type": tier,
            "transcript": transcript,
            "summary": summary,
            "full_text": full_text,
            "today_flow": today_flow,
            "outer_impression": outer_impression,
            "action_hint": action_hint,
            "message": message,
            "advice": advice,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    tag, cleaned_text = extract_tag_and_clean_text(fortune_text)
    message, advice = pick_message_and_advice(cleaned_text)

    return {
        "status": "ok",
        "type": tier,
        "transcript": transcript,
        "message": message,
        "advice": advice,
        "full_text": cleaned_text,
        "tag": tag,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# =========================
# Main
# =========================
def lambda_handler(event, context):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
    base_name = key.split("/")[-1].rsplit(".", 1)[0]

    print(f"processing s3 object basename={base_name}")

    if not RESULT_BUCKET:
        raise RuntimeError("voice result configuration error")

    if not is_target_transcript_key(key):
        print("skipped: not transcript member json")
        return {"statusCode": 200, "body": "skipped"}

    tier = get_tier_from_key(key)

    print(f"processing transcript tier={tier}, basename={base_name}")

    transcript_json = load_json_from_s3(bucket, key)
    transcript_text = extract_transcript_text(transcript_json)
    transcribe_job_name = extract_transcribe_job_name(transcript_json)
    print("transcript json loaded")

    history_item = find_history_item_by_transcript_key(key, transcribe_job_name)
    if not history_item:
        raise ValueError("history item not found")

    print("history item found")

    method_text = read_method_text()

    voice_context = build_voice_fortune_context(
        transcript_text=transcript_text,
        title=str(history_item.get("title") or history_item.get("input_title") or ""),
        category=str(history_item.get("category") or tier),
        memo=str(history_item.get("memo") or ""),
        name=str(history_item.get("name") or ""),
        birth_date=str(history_item.get("birth_date") or ""),
        gender=str(history_item.get("gender") or ""),
    )
    prompt = build_prompt(method_text, transcript_text, tier, voice_context)
    print("starting fortune generation")
    fortune_text = invoke_bedrock_text(prompt, max_tokens=1200, temperature=0.7)
    print("fortune generation completed")

    result_json = build_result_json(tier, transcript_text, fortune_text)
    result_json["engine_results"] = {
        "voice_fortune_v0": voice_context,
    }
    result_json["user_profile"] = voice_context["user_profile"]
    result_json = normalize_result_strings(result_json)

    out_key = result_key_from_transcript_key(key, history_item)
    print(f"saving result to {out_key}")

    s3.put_object(
        Bucket=RESULT_BUCKET,
        Key=out_key,
        Body=json.dumps(result_json, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )

    update_history_completed(history_item, result_json, out_key)
    consume_voice_quota(history_item)
    print("history completed")

    return {
        "statusCode": 200,
        "body": json.dumps(result_json, ensure_ascii=False),
    }
