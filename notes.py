"""Note generation for the local RecordingNote server.

Gemini is the first provider. Keep the provider boundary small so another
service (a local LLM, for example) can be added later without touching the
frontend or the job API.
"""

from __future__ import annotations

import os

NOTE_PROMPT = (
    "あなたは大学講義の学習ノート作成者です。以下は講義の文字起こしです。"
    "この内容だけを使って、日本語で学習ノートを作成してください。"
    "ルール: 文字起こしに書かれていない事実・用語・年号を絶対に足さない／"
    "見出しで階層化し要点は箇条書き／年号・人名・地名・専門用語は文字起こしの表記をそのまま使う／"
    "講義の流れに沿って構成する／冒頭にタイトル行を付ける／"
    "末尾に「重要語句」リストと「復習ポイント」を付ける。出力はMarkdownのみ。"
    "文字起こしは句読点のない音声認識結果なので、読み取りにくい箇所は無理に補わず趣旨が取れる範囲で整理すること。"
)
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class NoteGenerationError(RuntimeError):
    """A message that can be shown to the user as-is."""


def build_prompt(transcript: str) -> str:
    return f"{NOTE_PROMPT}\n\n文字起こし:\n{transcript}"


class GeminiProvider:
    """Generate a note with the Gemini API (key stays on the server)."""

    name = "gemini"

    def __init__(self, api_key: str, model: str = DEFAULT_GEMINI_MODEL) -> None:
        self._api_key = api_key
        self.model = model or DEFAULT_GEMINI_MODEL

    def generate(self, transcript: str) -> str:
        import httpx

        try:
            with httpx.Client(timeout=180) as client:
                response = client.post(
                    GEMINI_ENDPOINT.format(model=self.model),
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": self._api_key,
                    },
                    json={"contents": [{"role": "user", "parts": [{"text": build_prompt(transcript)}]}]},
                )
        except httpx.HTTPError as exc:
            raise NoteGenerationError(
                "Geminiへ接続できませんでした。インターネット接続を確認し、時間を置いて再実行してください。"
            ) from exc

        if response.status_code != 200:
            raise NoteGenerationError(_gemini_error_message(response.status_code))

        try:
            data = response.json()
        except ValueError as exc:
            raise NoteGenerationError("Geminiの応答を読み取れませんでした。時間を置いて再実行してください。") from exc

        candidate = (data.get("candidates") or [{}])[0]
        if data.get("promptFeedback", {}).get("blockReason"):
            raise NoteGenerationError(
                "Geminiが入力を制限したため、ノートを生成できませんでした。文字起こしの内容を確認してください。"
            )
        finish_reason = candidate.get("finishReason")
        if finish_reason and finish_reason != "STOP":
            raise NoteGenerationError(
                "Geminiの出力が途中終了したため、ノートを保存しませんでした。"
                "モデルの入力・出力上限を確認して再実行してください。"
            )

        parts = (candidate.get("content") or {}).get("parts") or []
        note = "\n".join(
            part["text"]
            for part in parts
            if isinstance(part, dict) and not part.get("thought") and isinstance(part.get("text"), str)
        )
        if not note.strip():
            raise NoteGenerationError(
                "Geminiからノート本文が返りませんでした。入力内容とGoogle側の利用状況を確認して再実行してください。"
            )
        return note


def _gemini_error_message(status: int) -> str:
    if status in (400, 401, 403):
        return "Geminiのリクエストが拒否されました。APIキーの有効性・利用権限・モデル名を確認してください。"
    if status == 404:
        return "指定したGeminiモデルが見つかりません。.env の GEMINI_MODEL を確認してください。"
    if status == 429:
        return "Geminiの利用上限に達しました。Google側の利用枠を確認し、時間を置いて再実行してください。"
    return f"Geminiでエラーが発生しました（HTTP {status}）。時間を置いて再実行してください。"


def load_provider() -> GeminiProvider | None:
    """Return the configured provider, or None when notes are not set up yet."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    return GeminiProvider(api_key, model)
