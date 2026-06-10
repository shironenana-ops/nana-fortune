# C:\Users\kokur\nana-fortune\lambda\lambda_function.py
# -*- coding: utf-8 -*-

import json
import os
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Dict, Any, Optional

import boto3
from botocore.exceptions import ClientError

from engines.numerology import run_numerology
from integration.integrator import integrate_shirone7


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
BUCKET_NAME = os.environ["BUCKET_NAME"]
METHOD_KEY = os.environ["METHOD_KEY"]

MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"
USERS_TABLE_NAME = "shirone7_users"

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
    if len(parts) >= 2 and parts[0] == "raw":
        tier = parts[1]
        if tier in TIERS:
            return tier
    return "free"


def read_method_text() -> str:
    obj = s3.get_object(Bucket=BUCKET_NAME, Key=METHOD_KEY)
    return obj["Body"].read().decode("utf-8")


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


def build_prompt(method_text: str, transcript: str, tier: str) -> str:
    rule = TIERS[tier]

    return f"""
あなたは占い師「白音七」です。以下の白音七メソッドと、ユーザーの音声文字起こしを元に占い文を作ってください。

# 白音七メソッド（遵守）
{method_text}

# ユーザーの相談（文字起こし）
{transcript}

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


def build_result_json(tier: str, transcript: str, fortune_text: str) -> dict:
    tag, cleaned_text = extract_tag_and_clean_text(fortune_text)
    message, advice = pick_message_and_advice(cleaned_text)

    return {
        "status": "ok",
        "type": tier,
        "transcript": transcript,
        "message": message,
        "advice": advice,
        "full_text": cleaned_text.replace("\n", "<br>"),
        "tag": tag,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# =========================
# DynamoDB
# =========================
def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    response = users_table.get_item(Key={"user_id": user_id})
    item = response.get("Item")
    print(f"user fetched: {item}")
    return item


def build_engine_input_from_user(user: Dict[str, Any], tier: str) -> Dict[str, Any]:
    return {
        "name": user["name"],
        "birth_date": user["birth_date"],
        "target_date": datetime.now().strftime("%Y-%m-%d"),
        "tier": tier,
    }


def build_engine_result(engine_input: Dict[str, Any]) -> Dict[str, Any]:
    numerology_result = run_numerology(engine_input)

    integrated_result = integrate_shirone7(
        numerology_result=numerology_result,
        plan=engine_input.get("tier", "free"),
        user_context=engine_input,
    )

    return {
        "numerology": numerology_result,
        "integrated": integrated_result,
    }


# =========================
# Main
# =========================
def lambda_handler(event, context):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

    print(f"event bucket={bucket}, key={key}")

    if bucket != BUCKET_NAME:
        raise ValueError("Unexpected bucket")

    if not key.startswith("raw/"):
        return {"statusCode": 200, "body": "ignored"}

    tier = get_tier_from_key(key)
    base_name = key.split("/")[-1].rsplit(".", 1)[0]

    print(f"tier={tier}, base_name={base_name}")

    ext = key.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_MEDIA_FORMATS:
        raise ValueError(f"Unsupported media format: {ext}")

    media_format = "mp4" if ext == "m4a" else ext
    transcript_key = f"transcript/{tier}/{base_name}.json"

    job_name = f"shirone7-{int(time.time())}-{base_name}".replace("_", "-")[:200]

    print(f"starting transcribe job: {job_name}")
    print(f"transcript_key={transcript_key}")

    transcribe.start_transcription_job(
        TranscriptionJobName=job_name,
        LanguageCode="ja-JP",
        MediaFormat=media_format,
        Media={"MediaFileUri": f"s3://{bucket}/{key}"},
        OutputBucketName=bucket,
        OutputKey=transcript_key,
    )

    job_res = wait_transcribe(job_name)
    status = job_res["TranscriptionJob"]["TranscriptionJobStatus"]

    if status == "FAILED":
        reason = job_res["TranscriptionJob"].get("FailureReason", "unknown")
        raise RuntimeError(f"Transcribe failed: {reason}")

    transcript_text = fetch_transcript_text_from_s3(bucket, transcript_key)
    print("transcript fetched from s3")

    method_text = read_method_text()

    prompt = build_prompt(method_text, transcript_text, tier)
    print("starting fortune generation")
    fortune_text = invoke_bedrock_text(prompt, max_tokens=1200, temperature=0.7)
    print("fortune generation completed")

    result_json = build_result_json(tier, transcript_text, fortune_text)

    user_id = "user_001"
    user = get_user(user_id)

    if not user:
        raise ValueError(f"user not found: {user_id}")

    engine_input = build_engine_input_from_user(user, tier)
    result_json["engine_results"] = build_engine_result(engine_input)
    result_json["user_profile"] = {
        "user_id": user_id,
        "name": user["name"],
        "birth_date": user["birth_date"],
        "plan": user.get("plan", tier),
    }

    out_key = f"result/{tier}/{base_name}.json"
    print(f"saving result to {out_key}")

    s3.put_object(
        Bucket=bucket,
        Key=out_key,
        Body=json.dumps(result_json, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )

    return {
        "statusCode": 200,
        "body": json.dumps(result_json, ensure_ascii=False),
    }