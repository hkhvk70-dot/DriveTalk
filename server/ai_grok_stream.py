"""OpenAI-compatible streaming parser for the Grok call path.

**No network here.** This module only understands the wire shape that
``https://api.x.ai/v1/chat/completions`` returns with ``stream: true``, so the HTTP
client added in the next batch stays a thin transport.

Wire shape handled (one SSE ``data:`` payload per chunk)::

    {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
    {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function",
        "function":{"name":"set_lock","arguments":"{\\"loc"}}]},"finish_reason":null}]}
    ...more argument fragments, same index, no id/name repeated...
    {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
    {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":96,"total_tokens":908}}

Three facts this parser exists to get right:

1. ``function.arguments`` arrives as fragments that only form valid JSON when
   concatenated in order — never ``json.loads`` a single fragment.
2. ``id`` and ``name`` appear only on the first fragment of each tool call; later
   fragments carry only ``index`` and ``arguments``.
3. Several tool calls can be interleaved in one response, so state is keyed by
   ``index``, not by arrival order.
"""
from __future__ import annotations

import json
from typing import Any

FINISH_TOOL_CALLS = "tool_calls"
FINISH_STOP = "stop"
FINISH_LENGTH = "length"


class StreamProtocolError(ValueError):
    """The upstream stream did not look like an OpenAI-compatible completion."""


class PartialToolCall:
    """Accumulator for one tool call, keyed by ``delta.tool_calls[].index``."""

    __slots__ = ("index", "call_id", "name", "argument_fragments")

    def __init__(self, index: int) -> None:
        self.index = index
        self.call_id: str | None = None
        self.name: str | None = None
        self.argument_fragments: list[str] = []

    def add(self, fragment: dict[str, Any]) -> None:
        if not isinstance(fragment, dict):
            raise StreamProtocolError("tool_calls 分片必须是对象")
        if fragment.get("id"):
            self.call_id = str(fragment["id"])
        function = fragment.get("function")
        if isinstance(function, dict):
            if function.get("name"):
                self.name = str(function["name"])
            arguments = function.get("arguments")
            if arguments is not None:
                if not isinstance(arguments, str):
                    # Some providers send an object; treat it as a complete document.
                    arguments = json.dumps(arguments, ensure_ascii=False)
                self.argument_fragments.append(arguments)

    @property
    def raw_arguments(self) -> str:
        return "".join(self.argument_fragments)

    def finish(self) -> dict[str, Any]:
        if not self.name:
            raise StreamProtocolError(f"tool_call[{self.index}] 缺少函数名")
        text = self.raw_arguments.strip()
        if not text:
            arguments: Any = {}
        else:
            try:
                arguments = json.loads(text)
            except json.JSONDecodeError as error:
                raise StreamProtocolError(
                    f"tool_call[{self.index}] 参数不是有效 JSON：{error.msg}"
                ) from error
        if not isinstance(arguments, dict):
            raise StreamProtocolError(f"tool_call[{self.index}] 参数必须是 JSON 对象")
        return {"id": self.call_id or f"call_{self.index}", "name": self.name, "arguments": arguments}


def choices_of(chunk: Any) -> list[dict[str, Any]]:
    """Return the usable choices of a chunk, tolerating a usage-only chunk."""
    if not isinstance(chunk, dict):
        raise StreamProtocolError("流式分片必须是 JSON 对象")
    choices = chunk.get("choices")
    if choices is None:
        return []
    if not isinstance(choices, list):
        raise StreamProtocolError("choices 必须是数组")
    return [choice for choice in choices if isinstance(choice, dict)]


def delta_of(chunk: Any) -> dict[str, Any]:
    """Return ``choices[0].delta`` for a chunk, or an empty dict when absent."""
    for choice in choices_of(chunk):
        delta = choice.get("delta")
        if isinstance(delta, dict):
            return delta
    return {}


def usage_of(chunk: Any) -> dict[str, Any] | None:
    """Return the usage block, which OpenAI-compatible APIs send on its own chunk."""
    if not isinstance(chunk, dict):
        return None
    usage = chunk.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        "promptTokens": usage.get("prompt_tokens"),
        "cachedTokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        if isinstance(usage.get("prompt_tokens_details"), dict) else usage.get("cached_tokens"),
        "completionTokens": usage.get("completion_tokens"),
        "totalTokens": usage.get("total_tokens"),
    }


def finish_reason_of(chunk: Any) -> str | None:
    for choice in choices_of(chunk):
        reason = choice.get("finish_reason")
        if isinstance(reason, str):
            return reason
    return None


class GrokStreamAccumulator:
    """Feed chunks in arrival order; read :attr:`text` as it grows.

    Usage::

        acc = GrokStreamAccumulator()
        for chunk in chunks:
            acc.feed(chunk)
        text = acc.text
        calls = acc.tool_calls          # [] when the model answered in prose

    ``finished`` flips to True once a finish_reason arrives, so the caller can assert
    the stream ended cleanly instead of assuming it did.
    """

    def __init__(self) -> None:
        self._text: list[str] = []
        self._calls: dict[int, PartialToolCall] = {}
        self._order: list[int] = []
        self.finish_reason: str | None = None
        self.usage: dict[str, Any] | None = None
        self.chunk_count = 0

    # -- ingestion -------------------------------------------------------------------

    def feed(self, chunk: Any) -> None:
        self.chunk_count += 1
        usage = usage_of(chunk)
        if usage is not None:
            self.usage = usage
        reason = finish_reason_of(chunk)
        if reason is not None:
            self.finish_reason = reason
        delta = delta_of(chunk)
        if not delta:
            return
        content = delta.get("content")
        if isinstance(content, str) and content:
            self._text.append(content)
        fragments = delta.get("tool_calls")
        if fragments is None:
            return
        if not isinstance(fragments, list):
            raise StreamProtocolError("delta.tool_calls 必须是数组")
        for position, fragment in enumerate(fragments):
            index = fragment.get("index") if isinstance(fragment, dict) else None
            if not isinstance(index, int):
                # Missing index: fall back to arrival position so we never merge two calls.
                index = position if not self._order else self._order[-1] + position
            call = self._calls.get(index)
            if call is None:
                call = PartialToolCall(index)
                self._calls[index] = call
                self._order.append(index)
            call.add(fragment)

    # -- results ---------------------------------------------------------------------

    @property
    def text(self) -> str:
        return "".join(self._text)

    @property
    def tool_calls(self) -> list[dict[str, Any]]:
        """Finalised tool calls in first-seen order. Empty when the model used prose."""
        if not self._calls:
            return []
        return [self._calls[index].finish() for index in self._order]

    @property
    def wants_tools(self) -> bool:
        return self.finish_reason == FINISH_TOOL_CALLS and bool(self._calls)

    @property
    def finished(self) -> bool:
        return self.finish_reason is not None

    def raw_arguments(self, index: int = 0) -> str:
        """Concatenated argument text, exposed for debugging malformed streams."""
        call = self._calls.get(index)
        return call.raw_arguments if call else ""


def parse_stream(chunks: list[Any]) -> GrokStreamAccumulator:
    """Drive an accumulator over a complete list of chunks (used by tests and replay)."""
    accumulator = GrokStreamAccumulator()
    for chunk in chunks:
        accumulator.feed(chunk)
    return accumulator


# --------------------------------------------------------------------------------------
# Mock fixtures: the exact wire shape, for tests and offline replay
# --------------------------------------------------------------------------------------


def _chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
    return {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": "grok-mock",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


def _usage_chunk(prompt: int, cached: int, completion: int) -> dict[str, Any]:
    return {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": "grok-mock",
            "choices": [], "usage": {"prompt_tokens": prompt, "completion_tokens": completion,
                                     "total_tokens": prompt + completion,
                                     "prompt_tokens_details": {"cached_tokens": cached}}}


def mock_prose_stream(text: str = "车辆当前电量 71%，未在充电。") -> list[dict[str, Any]]:
    """A plain answer: content deltas, no tool calls."""
    middle = max(1, len(text) // 3)
    pieces = [text[:middle], text[middle:2 * middle], text[2 * middle:]]
    chunks = [_chunk({"role": "assistant", "content": ""})]
    chunks += [_chunk({"content": piece}) for piece in pieces if piece]
    chunks.append(_chunk({}, FINISH_STOP))
    chunks.append(_usage_chunk(812, 760, 24))
    return chunks


def mock_tool_call_stream(*, name: str = "set_lock", arguments_json: str = '{"locked":true}',
                          call_id: str = "call_mock_1", include_usage: bool = True,
                          split_at: int | None = None) -> list[dict[str, Any]]:
    """One tool call whose arguments are split across chunks, like the real API."""
    cut = split_at if split_at is not None else max(1, len(arguments_json) // 2)
    first, rest = arguments_json[:cut], arguments_json[cut:]
    chunks = [
        _chunk({"role": "assistant", "content": ""}),
        _chunk({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                "function": {"name": name, "arguments": first}}]}),
    ]
    # Later fragments carry only index + arguments; id/name are absent on purpose.
    for offset in range(0, len(rest), 4):
        chunks.append(_chunk({"tool_calls": [{"index": 0, "function": {"arguments": rest[offset:offset + 4]}}]}))
    chunks.append(_chunk({}, FINISH_TOOL_CALLS))
    if include_usage:
        chunks.append(_usage_chunk(980, 900, 41))
    return chunks


def mock_two_tool_calls_stream() -> list[dict[str, Any]]:
    """Two calls in one response, interleaved by index: the loop-breaker test case."""
    return [
        _chunk({"role": "assistant", "content": ""}),
        _chunk({"tool_calls": [{"index": 0, "id": "call_a", "type": "function",
                                "function": {"name": "get_vehicle_status", "arguments": "{"}}]}),
        _chunk({"tool_calls": [{"index": 1, "id": "call_b", "type": "function",
                                "function": {"name": "set_lock", "arguments": '{"loc'}}]}),
        _chunk({"tool_calls": [{"index": 0, "function": {"arguments": "}"}}]}),
        _chunk({"tool_calls": [{"index": 1, "function": {"arguments": 'ked":false}'}}]}),
        _chunk({}, FINISH_TOOL_CALLS),
        _usage_chunk(1200, 1100, 55),
    ]


def mock_truncated_arguments_stream() -> list[dict[str, Any]]:
    """Arguments that never become valid JSON, plus a length cut-off."""
    return [
        _chunk({"role": "assistant", "content": ""}),
        _chunk({"tool_calls": [{"index": 0, "id": "call_bad", "type": "function",
                                "function": {"name": "set_lock", "arguments": '{"locked":'}}]}),
        _chunk({"tool_calls": [{"index": 0, "function": {"arguments": "tru"}}]}),
        _chunk({}, FINISH_LENGTH),
    ]
