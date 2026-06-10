# C:\Users\kokur\nana-fortune\lambda\integration\integrator.py
# -*- coding: utf-8 -*-

from typing import Dict, Any


def _build_core_theme(numerology: Dict[str, Any]) -> str:
    return numerology.get("core_theme", "")


def _build_action_hint(numerology: Dict[str, Any]) -> str:
    return numerology.get("action_hint", "")


def _build_emotional_tone(numerology: Dict[str, Any]) -> str:
    return numerology.get("emotional_tone", "")


def _build_caution(numerology: Dict[str, Any]) -> str:
    warnings = numerology.get("warnings", [])
    if not warnings:
        return "無理を重ねすぎないこと"
    return "注意点: " + " / ".join(warnings[:3])


def _build_plan_text(plan: str, core: str, action: str, emotion: str, caution: str) -> str:
    if plan == "free":
        return f"{core} {action}"

    if plan == "member":
        return f"{core} 感情は「{emotion}」。 {action} {caution}"

    # deep
    return (
        f"{core} "
        f"感情の流れは「{emotion}」。 "
        f"{action} "
        f"{caution} "
        f"今日は内面と現実のバランスを意識することで流れが整います。"
    )


def integrate_shirone7(
    numerology_result: Dict[str, Any],
    plan: str = "free",
    user_context: Dict[str, Any] | None = None,
) -> Dict[str, Any]:

    plan = plan if plan in ["free", "member", "deep"] else "free"

    core_theme = _build_core_theme(numerology_result)
    action_hint = _build_action_hint(numerology_result)
    emotional_tone = _build_emotional_tone(numerology_result)
    caution = _build_caution(numerology_result)

    plan_text = _build_plan_text(
        plan,
        core_theme,
        action_hint,
        emotional_tone,
        caution,
    )

    result = {
        "engine": {
            "name": "shirone7_integrator",
            "version": "1.0.0",
        },
        "integrated": {
            "core_theme": core_theme,
            "action_hint": action_hint,
            "emotional_tone": emotional_tone,
            "caution": caution,
            "plan_text": plan_text,
        },
        "source": {
            "numerology": numerology_result
        },
        "meta": {
            "plan": plan,
            "user_context": user_context or {},
        }
    }

    return result