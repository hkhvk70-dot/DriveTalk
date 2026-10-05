"""Mock-only tests for the OpenAI-compatible stream parser. No network, no Grok key.

The mock chunks reproduce the exact wire shape of
``POST https://api.x.ai/v1/chat/completions`` with ``stream: true``, including the two
properties that break naive parsers:

* ``function.arguments`` arrives as fragments that are only valid JSON once concatenated;
* ``id`` and ``name`` appear only on the first fragment of each tool call.

If this file passes, the next batch's HTTP client only has to move bytes.
"""
from __future__ import annotations

import json
import unittest

from ai_grok_stream import (
    FINISH_LENGTH,
    FINISH_STOP,
    FINISH_TOOL_CALLS,
    GrokStreamAccumulator,
    StreamProtocolError,
    choices_of,
    delta_of,
    finish_reason_of,
    mock_prose_stream,
    mock_tool_call_stream,
    mock_truncated_arguments_stream,
    mock_two_tool_calls_stream,
    parse_stream,
    usage_of,
)


class ProseStreamTests(unittest.TestCase):
    def test_content_deltas_are_concatenated_in_order(self):
        accumulator = parse_stream(mock_prose_stream("车辆当前电量 71%，未在充电。"))
        self.assertEqual(accumulator.text, "车辆当前电量 71%，未在充电。")
        self.assertEqual(accumulator.tool_calls, [])
        self.assertFalse(accumulator.wants_tools)
        self.assertEqual(accumulator.finish_reason, FINISH_STOP)
        self.assertTrue(accumulator.finished)

    def test_empty_content_fragments_do_not_add_noise(self):
        accumulator = parse_stream([{"choices": [{"delta": {"role": "assistant", "content": ""}}]}])
        self.assertEqual(accumulator.text, "")
        self.assertEqual(accumulator.chunk_count, 1)


class ToolCallStreamTests(unittest.TestCase):
    def test_arguments_split_across_chunks_are_joined_before_parsing(self):
        accumulator = parse_stream(mock_tool_call_stream(
            name="set_lock", arguments_json='{"locked":true}', split_at=8))
        self.assertEqual(len(accumulator.tool_calls), 1)
        call = accumulator.tool_calls[0]
        self.assertEqual(call["name"], "set_lock")
        self.assertEqual(call["arguments"], {"locked": True})
        self.assertEqual(call["id"], "call_mock_1")
        self.assertTrue(accumulator.wants_tools)
        self.assertEqual(accumulator.finish_reason, FINISH_TOOL_CALLS)

    def test_a_single_fragment_is_never_enough_to_parse(self):
        # Guard the classic bug: parsing fragments one by one would fail here.
        chunks = mock_tool_call_stream(arguments_json='{"locked":true}', split_at=1)
        accumulator = parse_stream(chunks)
        self.assertEqual(accumulator.raw_arguments(0), '{"locked":true}')
        self.assertEqual(accumulator.tool_calls[0]["arguments"], {"locked": True})

    def test_utf8_arguments_survive_the_fragment_boundary(self):
        accumulator = parse_stream(mock_tool_call_stream(
            name="send_destination",
            arguments_json=json.dumps({"destination": "示例目的地"}, ensure_ascii=False),
            split_at=3))
        call = accumulator.tool_calls[0]
        self.assertEqual(call["name"], "send_destination")
        self.assertEqual(call["arguments"]["destination"], "示例目的地")

    def test_two_interleaved_calls_are_separated_by_index(self):
        accumulator = parse_stream(mock_two_tool_calls_stream())
        calls = accumulator.tool_calls
        self.assertEqual([call["name"] for call in calls], ["get_vehicle_status", "set_lock"])
        self.assertEqual(calls[0]["arguments"], {})
        self.assertEqual(calls[1]["arguments"], {"locked": False})
        self.assertEqual([call["id"] for call in calls], ["call_a", "call_b"])

    def test_missing_id_gets_a_deterministic_placeholder(self):
        chunks = [
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"name": "find_vehicle", "arguments": "{}"}}]},
                "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]},
        ]
        self.assertEqual(parse_stream(chunks).tool_calls[0]["id"], "call_0")

    def test_fragment_without_index_falls_back_to_arrival_position(self):
        chunks = [
            {"choices": [{"delta": {"tool_calls": [
                {"id": "a", "function": {"name": "find_vehicle", "arguments": "{}"}},]}}]},
            {"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]},
        ]
        calls = parse_stream(chunks).tool_calls
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["name"], "find_vehicle")

    def test_arguments_sent_as_an_object_are_accepted(self):
        chunks = [
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "x", "function": {"name": "set_lock", "arguments": {"locked": True}}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]},
        ]
        self.assertEqual(parse_stream(chunks).tool_calls[0]["arguments"], {"locked": True})


class MalformedStreamTests(unittest.TestCase):
    def test_truncated_arguments_raise_instead_of_guessing(self):
        accumulator = parse_stream(mock_truncated_arguments_stream())
        self.assertEqual(accumulator.finish_reason, FINISH_LENGTH)
        with self.assertRaises(StreamProtocolError) as caught:
            _ = accumulator.tool_calls
        self.assertIn("参数不是有效 JSON", str(caught.exception))
        # The raw fragments stay available for debugging and audit.
        self.assertEqual(accumulator.raw_arguments(0), '{"locked":tru')

    def test_tool_call_without_a_name_raises(self):
        chunks = [
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "x", "function": {"arguments": "{}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]},
        ]
        with self.assertRaises(StreamProtocolError) as caught:
            parse_stream(chunks).tool_calls
        self.assertIn("缺少函数名", str(caught.exception))

    def test_non_object_arguments_raise(self):
        chunks = [
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "x", "function": {"name": "set_lock", "arguments": "[1,2]"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]},
        ]
        with self.assertRaises(StreamProtocolError) as caught:
            parse_stream(chunks).tool_calls
        self.assertIn("必须是 JSON 对象", str(caught.exception))

    def test_wrong_shaped_chunks_are_rejected(self):
        for chunk in ["not a dict", {"choices": "nope"}, {"choices": [{"delta": {"tool_calls": "nope"}}]}]:
            with self.subTest(chunk=chunk):
                with self.assertRaises(StreamProtocolError):
                    parse_stream([chunk])

    def test_usage_only_chunk_is_tolerated(self):
        accumulator = parse_stream(mock_prose_stream("好的"))
        self.assertEqual(accumulator.finish_reason, FINISH_STOP)
        self.assertEqual(accumulator.usage["promptTokens"], 812)
        self.assertEqual(accumulator.usage["cachedTokens"], 760)
        self.assertEqual(accumulator.usage["completionTokens"], 24)


class ShapeHelperTests(unittest.TestCase):
    def test_choices_of_handles_missing_and_empty_choices(self):
        self.assertEqual(choices_of({"usage": {}}), [])
        self.assertEqual(choices_of({"choices": []}), [])
        self.assertEqual(choices_of({"choices": [{"delta": {}}, "junk"]}), [{"delta": {}}])

    def test_delta_of_returns_empty_dict_when_absent(self):
        self.assertEqual(delta_of({"choices": [], "usage": {}}), {})
        self.assertEqual(delta_of({"choices": [{"finish_reason": "stop"}]}), {})

    def test_finish_reason_of_reads_first_available_choice(self):
        self.assertIsNone(finish_reason_of({"choices": [{"delta": {}}]}))
        self.assertEqual(finish_reason_of({"choices": [{"finish_reason": "tool_calls"}]}), FINISH_TOOL_CALLS)

    def test_usage_of_reads_cached_tokens_from_details(self):
        usage = usage_of({"usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12,
                                    "prompt_tokens_details": {"cached_tokens": 8}}})
        self.assertEqual(usage, {"promptTokens": 10, "cachedTokens": 8, "completionTokens": 2, "totalTokens": 12})

    def test_usage_of_accepts_flat_cached_tokens_too(self):
        usage = usage_of({"usage": {"prompt_tokens": 10, "cached_tokens": 4, "completion_tokens": 1}})
        self.assertEqual(usage["cachedTokens"], 4)

    def test_usage_of_returns_none_without_usage(self):
        self.assertIsNone(usage_of({"choices": []}))
        self.assertIsNone(usage_of("nope"))


class AccumulatorStateTests(unittest.TestCase):
    def test_wants_tools_requires_both_finish_reason_and_calls(self):
        accumulator = GrokStreamAccumulator()
        for chunk in mock_tool_call_stream():
            accumulator.feed(chunk)
        self.assertTrue(accumulator.wants_tools)
        # A prose answer that happens to carry finish_reason=tool_calls must not be
        # treated as a dispatch request when no call was actually parsed.
        only_finish = parse_stream([{"choices": [{"delta": {}, "finish_reason": FINISH_TOOL_CALLS}]}])
        self.assertFalse(only_finish.wants_tools)

    def test_finished_flips_only_on_a_finish_reason(self):
        accumulator = GrokStreamAccumulator()
        accumulator.feed({"choices": [{"delta": {"content": "你"}}]})
        self.assertFalse(accumulator.finished)
        accumulator.feed({"choices": [{"delta": {}, "finish_reason": FINISH_STOP}]})
        self.assertTrue(accumulator.finished)

    def test_replaying_the_same_chunks_is_deterministic(self):
        first = parse_stream(mock_two_tool_calls_stream()).tool_calls
        second = parse_stream(mock_two_tool_calls_stream()).tool_calls
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
