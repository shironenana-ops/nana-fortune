# C:\Users\kokur\nana-fortune\lambda\engines\numerology.py
# -*- coding: utf-8 -*-

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional


MASTER_NUMBERS = {11, 22, 33}


NUMBER_KEYWORDS = {
    1: ["開始", "主体性", "決断", "突破"],
    2: ["協調", "受容", "調和", "対話"],
    3: ["表現", "創造", "明るさ", "発信"],
    4: ["安定", "基盤", "継続", "堅実"],
    5: ["変化", "自由", "行動", "柔軟"],
    6: ["愛情", "責任", "信頼", "献身"],
    7: ["探求", "内省", "分析", "直感"],
    8: ["成果", "現実化", "影響力", "達成"],
    9: ["完了", "包容", "浄化", "手放し"],
    11: ["直感", "感受性", "啓示", "精神性"],
    22: ["構築", "実装", "大局観", "現実形成"],
    33: ["奉仕", "癒し", "無償愛", "導き"],
}

NUMBER_STRENGTHS = {
    1: ["自分で道を切り開ける", "迷いの中でも着手できる"],
    2: ["人の気持ちを汲み取れる", "関係をなめらかに整えられる"],
    3: ["言葉や表現で空気を変えられる", "発想に軽やかさがある"],
    4: ["土台を固める力が強い", "着実に積み上げられる"],
    5: ["変化への適応が早い", "流れを切り替える行動力がある"],
    6: ["面倒見がよく信頼を集めやすい", "責任を持って支えられる"],
    7: ["本質を深く見抜ける", "静かな集中力がある"],
    8: ["結果へつなげる実務力がある", "現実を動かす力がある"],
    9: ["視野が広く包容力がある", "終わらせることで次を開ける"],
    11: ["鋭い直感で流れを感じ取れる", "人の心の機微に気づきやすい"],
    22: ["大きな構想を形にできる", "理想を現実へ落とし込める"],
    33: ["人を癒し支える力がある", "愛の視点で全体を見られる"],
}

NUMBER_WARNINGS = {
    1: ["独走", "強引さ", "せっかち"],
    2: ["気疲れ", "遠慮しすぎ", "優柔不断"],
    3: ["散漫", "口先だけ", "飽きやすさ"],
    4: ["頑固", "停滞", "慎重すぎる"],
    5: ["衝動", "落ち着きのなさ", "ブレ"],
    6: ["背負い込み", "過干渉", "我慢しすぎ"],
    7: ["考えすぎ", "孤立", "閉じこもり"],
    8: ["結果を急ぐ", "支配的", "力みすぎ"],
    9: ["情に流される", "曖昧", "手放せない"],
    11: ["神経疲労", "刺激過多", "感情の揺れ"],
    22: ["責任過多", "抱え込み", "理想が重い"],
    33: ["自己犠牲", "情の抱え込み", "境界の薄さ"],
}

NUMBER_ACTIONS = {
    1: "今日は迷い続けるより、まず一つ決めて着手してください。",
    2: "一人で抱え込まず、対話と共有を入れることで流れが整います。",
    3: "感じたことを言葉・文章・形にすると運が動きやすい日です。",
    4: "派手さよりも、足元の整理と継続を優先してください。",
    5: "いつもと違う動きを一つ入れることで停滞がほどけます。",
    6: "身近な人への配慮や責任ある行動が、そのまま追い風になります。",
    7: "静かな時間を確保し、本音と優先順位を整理してください。",
    8: "理想を数字・期限・手順に落とし込むと現実が動きます。",
    9: "もう役目を終えたものを手放し、余白を作ることが大切です。",
    11: "ノイズを減らし、直感が働く静かな環境を作ってください。",
    22: "大きな目標ほど、今日やるべき工程に分けて進めてください。",
    33: "誰かを助ける行動が、自分自身の流れも整えてくれます。",
}

NUMBER_EMOTIONS = {
    1: "前向きだが勢い先行になりやすい",
    2: "やわらかいが人に引っ張られやすい",
    3: "明るいが散りやすい",
    4: "落ち着いているが固まりやすい",
    5: "刺激的だが揺れやすい",
    6: "温かいが背負い込みやすい",
    7: "静かだが考え込みやすい",
    8: "力強いが結果を急ぎやすい",
    9: "包容力があるが境界が曖昧になりやすい",
    11: "繊細で鋭いが疲れを拾いやすい",
    22: "大局的だが責任を抱えやすい",
    33: "優しいが自己犠牲に寄りやすい",
}

NUMBER_THEMES = {
    1: "新しい一歩を自分の意志で刻む日",
    2: "人との呼吸を合わせることで流れが開く日",
    3: "言葉や表現が運を動かす日",
    4: "土台を整えるほど全体が噛み合う日",
    5: "動くことで停滞を破れる日",
    6: "やさしさと責任感が評価につながる日",
    7: "焦らず本質を見抜くことで道が見える日",
    8: "成果へ向けて手を動かすほど現実が応える日",
    9: "不要なものを手放すことで次が始まる日",
    11: "直感を信じるほど答えに近づく日",
    22: "大きな構想を現実に落とし込む日",
    33: "人のための行動が巡って自分を満たす日",
}


def reduce_number(value: int, keep_master: bool = True) -> int:
    """
    数を1桁、またはマスターナンバーまで還元する
    """
    if value <= 0:
        return 0

    while value > 9:
        if keep_master and value in MASTER_NUMBERS:
            return value
        value = sum(int(digit) for digit in str(value))
    return value


def normalize_birth_date(birth_date: str) -> str:
    """
    YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD を YYYY-MM-DD に正規化
    """
    if not birth_date:
        raise ValueError("birth_date が空です。")

    src = birth_date.strip().replace("/", "-")
    if len(src) == 8 and src.isdigit():
        src = f"{src[:4]}-{src[4:6]}-{src[6:8]}"

    try:
        dt = datetime.strptime(src, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("birth_date は YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD の形式で指定してください。") from exc

    return dt.strftime("%Y-%m-%d")


def normalize_target_date(target_date: Optional[str]) -> str:
    """
    target_date が未指定なら今日
    """
    if not target_date:
        return datetime.now().strftime("%Y-%m-%d")

    src = target_date.strip().replace("/", "-")
    if len(src) == 8 and src.isdigit():
        src = f"{src[:4]}-{src[4:6]}-{src[6:8]}"

    try:
        dt = datetime.strptime(src, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("target_date は YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD の形式で指定してください。") from exc

    return dt.strftime("%Y-%m-%d")


def extract_digits(text: str) -> List[int]:
    return [int(ch) for ch in text if ch.isdigit()]


def calc_life_path_number(birth_date: str) -> int:
    digits = extract_digits(birth_date)
    return reduce_number(sum(digits), keep_master=True)


def calc_destiny_number(name: str) -> int:
    """
    本来の姓名判断やピタゴラス式ではなく、
    白音七の初期版として文字コードベースで簡易算出する。

    後で正式ロジックへ差し替え可能なよう関数分離。
    """
    if not name:
        return 0

    total = 0
    for char in name.strip():
        if char.isspace():
            continue
        total += ord(char)

    return reduce_number(total, keep_master=True)


def calc_soul_number(name: str) -> int:
    """
    簡易版:
    偶数位置文字のコード合計
    """
    if not name:
        return 0

    chars = [c for c in name.strip() if not c.isspace()]
    total = 0
    for idx, char in enumerate(chars):
        if idx % 2 == 0:
            total += ord(char)
    return reduce_number(total, keep_master=True)


def calc_personality_number(name: str) -> int:
    """
    簡易版:
    奇数位置文字のコード合計
    """
    if not name:
        return 0

    chars = [c for c in name.strip() if not c.isspace()]
    total = 0
    for idx, char in enumerate(chars):
        if idx % 2 == 1:
            total += ord(char)
    return reduce_number(total, keep_master=True)


def calc_personal_year_number(birth_date: str, target_date: str) -> int:
    birth_dt = datetime.strptime(birth_date, "%Y-%m-%d")
    target_dt = datetime.strptime(target_date, "%Y-%m-%d")

    total = (
        sum(extract_digits(f"{birth_dt.month:02d}{birth_dt.day:02d}"))
        + sum(extract_digits(str(target_dt.year)))
    )
    return reduce_number(total, keep_master=True)


def calc_personal_month_number(personal_year: int, target_date: str) -> int:
    target_dt = datetime.strptime(target_date, "%Y-%m-%d")
    total = personal_year + target_dt.month
    return reduce_number(total, keep_master=False)


def calc_personal_day_number(personal_month: int, target_date: str) -> int:
    target_dt = datetime.strptime(target_date, "%Y-%m-%d")
    total = personal_month + target_dt.day
    return reduce_number(total, keep_master=False)


def safe_keywords(number_value: int) -> List[str]:
    return NUMBER_KEYWORDS.get(number_value, ["静観", "整理", "調整"])


def safe_strengths(number_value: int) -> List[str]:
    return NUMBER_STRENGTHS.get(number_value, ["自分の流れを整える力がある"])


def safe_warnings(number_value: int) -> List[str]:
    return NUMBER_WARNINGS.get(number_value, ["無理を重ねすぎないこと"])


def safe_action(number_value: int) -> str:
    return NUMBER_ACTIONS.get(number_value, "今日は無理に広げず、やるべきことを絞って進めてください。")


def safe_emotion(number_value: int) -> str:
    return NUMBER_EMOTIONS.get(number_value, "落ち着きと揺らぎが混ざりやすい状態です。")


def safe_theme(number_value: int) -> str:
    return NUMBER_THEMES.get(number_value, "内面を整えながら現実へつなげる日")


def unique_preserve(items: List[str]) -> List[str]:
    seen = set()
    result: List[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def calc_score(
    life_path: int,
    destiny: int,
    soul: int,
    personality: int,
    personal_year: int,
    personal_month: int,
    personal_day: int,
) -> int:
    """
    簡易スコア
    50点ベース + 数字の調和感で補正
    """
    score = 50

    core_numbers = [life_path, destiny, soul, personality]
    cycle_numbers = [personal_year, personal_month, personal_day]

    if personal_day in core_numbers:
        score += 15

    if personal_month in core_numbers:
        score += 10

    if personal_year in core_numbers:
        score += 10

    if life_path == soul:
        score += 5

    if destiny == personality:
        score += 5

    if any(n in MASTER_NUMBERS for n in core_numbers + cycle_numbers):
        score += 5

    return max(1, min(score, 99))


def build_tags(
    life_path: int,
    personal_year: int,
    personal_month: int,
    personal_day: int,
    core_theme: str,
) -> List[str]:
    tags = [
        "数秘術",
        f"LP{life_path}",
        f"PY{personal_year}",
        f"PM{personal_month}",
        f"PD{personal_day}",
        core_theme,
    ]
    return unique_preserve(tags)


def build_sub_themes(
    life_path: int,
    destiny: int,
    soul: int,
    personal_year: int,
    personal_month: int,
    personal_day: int,
) -> List[str]:
    themes: List[str] = []
    for num in [life_path, destiny, soul, personal_year, personal_month, personal_day]:
        themes.extend(safe_keywords(num)[:2])
    return unique_preserve(themes)[:8]


def build_strengths(
    life_path: int,
    destiny: int,
    soul: int,
) -> List[str]:
    strengths: List[str] = []
    strengths.extend(safe_strengths(life_path))
    strengths.extend(safe_strengths(destiny))
    strengths.extend(safe_strengths(soul))
    return unique_preserve(strengths)[:6]


def build_warnings(
    personality: int,
    personal_year: int,
    personal_day: int,
) -> List[str]:
    warnings: List[str] = []
    warnings.extend(safe_warnings(personality))
    warnings.extend(safe_warnings(personal_year))
    warnings.extend(safe_warnings(personal_day))
    return unique_preserve(warnings)[:6]


def build_action_hint(
    life_path: int,
    personal_year: int,
    personal_day: int,
) -> str:
    if personal_day != 0:
        return safe_action(personal_day)
    if personal_year != 0:
        return safe_action(personal_year)
    return safe_action(life_path)


def build_emotional_tone(
    soul: int,
    personal_month: int,
    personal_day: int,
) -> str:
    base = safe_emotion(soul if soul != 0 else personal_month)
    if personal_day in {1, 5, 8}:
        return f"{base} 今日は外向きに動きやすい日です。"
    if personal_day in {2, 6, 9}:
        return f"{base} 今日は対人や感情の影響を受けやすい日です。"
    if personal_day in {4, 7, 11, 22, 33}:
        return f"{base} 今日は内側を整えるほど安定しやすい日です。"
    return f"{base} 今日は流れを見ながら調整すると安定します。"


def build_core_theme(
    life_path: int,
    personal_year: int,
    personal_day: int,
) -> str:
    priority = personal_day or personal_year or life_path
    return safe_theme(priority)


def build_input_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    name = str(data.get("name", "")).strip()
    birth_date = normalize_birth_date(str(data.get("birth_date", "")).strip())
    target_date = normalize_target_date(data.get("target_date"))
    tier = str(data.get("tier", "free")).strip().lower() or "free"

    if tier not in {"free", "member", "deep"}:
        tier = "free"

    return {
        "name": name,
        "birth_date": birth_date,
        "target_date": target_date,
        "tier": tier,
    }


def run_numerology(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    白音七 数秘術エンジン
    """
    payload = build_input_payload(input_data)

    name = payload["name"]
    birth_date = payload["birth_date"]
    target_date = payload["target_date"]
    tier = payload["tier"]

    life_path = calc_life_path_number(birth_date)
    destiny = calc_destiny_number(name)
    soul = calc_soul_number(name)
    personality = calc_personality_number(name)
    personal_year = calc_personal_year_number(birth_date, target_date)
    personal_month = calc_personal_month_number(personal_year, target_date)
    personal_day = calc_personal_day_number(personal_month, target_date)

    core_theme = build_core_theme(life_path, personal_year, personal_day)
    sub_themes = build_sub_themes(
        life_path=life_path,
        destiny=destiny,
        soul=soul,
        personal_year=personal_year,
        personal_month=personal_month,
        personal_day=personal_day,
    )
    strengths = build_strengths(
        life_path=life_path,
        destiny=destiny,
        soul=soul,
    )
    warnings = build_warnings(
        personality=personality,
        personal_year=personal_year,
        personal_day=personal_day,
    )
    action_hint = build_action_hint(
        life_path=life_path,
        personal_year=personal_year,
        personal_day=personal_day,
    )
    emotional_tone = build_emotional_tone(
        soul=soul,
        personal_month=personal_month,
        personal_day=personal_day,
    )
    score = calc_score(
        life_path=life_path,
        destiny=destiny,
        soul=soul,
        personality=personality,
        personal_year=personal_year,
        personal_month=personal_month,
        personal_day=personal_day,
    )
    tags = build_tags(
        life_path=life_path,
        personal_year=personal_year,
        personal_month=personal_month,
        personal_day=personal_day,
        core_theme=core_theme,
    )

    result = {
        "engine_name": "numerology",
        "version": "1.0.0",
        "input": {
            "name": name,
            "birth_date": birth_date,
            "target_date": target_date,
            "tier": tier,
        },
        "numbers": {
            "life_path": life_path,
            "destiny": destiny,
            "soul": soul,
            "personality": personality,
            "personal_year": personal_year,
            "personal_month": personal_month,
            "personal_day": personal_day,
        },
        "core_theme": core_theme,
        "sub_themes": sub_themes,
        "strengths": strengths,
        "warnings": warnings,
        "action_hint": action_hint,
        "emotional_tone": emotional_tone,
        "score": score,
        "tags": tags,
        "raw": {
            "life_path_keywords": safe_keywords(life_path),
            "destiny_keywords": safe_keywords(destiny),
            "soul_keywords": safe_keywords(soul),
            "personality_keywords": safe_keywords(personality),
            "personal_year_keywords": safe_keywords(personal_year),
            "personal_month_keywords": safe_keywords(personal_month),
            "personal_day_keywords": safe_keywords(personal_day),
        },
    }

    return result


if __name__ == "__main__":
    sample_input = {
        "name": "荒井龍起",
        "birth_date": "1983-01-01",
        "target_date": "2026-03-17",
        "tier": "free",
    }

    output = run_numerology(sample_input)

    import json
    print(json.dumps(output, ensure_ascii=False, indent=2))